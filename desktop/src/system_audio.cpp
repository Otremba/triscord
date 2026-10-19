#include "system_audio.h"
#include "com_apartment.h"
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <objidl.h>
#include <wrl/client.h>
#include <atomic>
#include <deque>
#include <stdexcept>
#include <bit>

namespace triscord {
namespace {
using Microsoft::WRL::ComPtr;
void check(HRESULT value) { if (FAILED(value)) throw std::runtime_error("WASAPI HRESULT " + std::to_string(uint32_t(value))); }
// SDK ABI from audioclientactivationparams.h (not present in older MinGW SDKs).
struct ActivationParams { int type = 1; struct { DWORD pid = GetCurrentProcessId(); int mode = 1; } loopback; };
struct ActivationState {
    ActivationParams params;
    PROPVARIANT variant{};
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    ComPtr<IAudioClient> client;
    ActivationState() { variant.vt = VT_BLOB; variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params); }
    ~ActivationState() { if (event) CloseHandle(event); }
};
class Completion final : public IActivateAudioInterfaceCompletionHandler, public IAgileObject {
public:
    explicit Completion(std::shared_ptr<ActivationState> value) : state_(std::move(value)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler)) *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
        else if (iid == __uuidof(IAgileObject)) *out = static_cast<IAgileObject*>(this);
        else return E_NOINTERFACE;
        AddRef(); return S_OK;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override { const auto n = --refs_; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        ComPtr<IUnknown> object; HRESULT activation = E_FAIL;
        const auto hr = operation->GetActivateResult(&activation, &object);
        state_->result = FAILED(hr) ? hr : activation;
        if (SUCCEEDED(state_->result)) state_->result = object.As(&state_->client);
        SetEvent(state_->event); return S_OK;
    }
private:
    std::atomic<ULONG> refs_{1};
    std::shared_ptr<ActivationState> state_;
};
}
struct SystemAudio::State {
    bool apartment = false;
    ComPtr<IAudioClient> client;
    ComPtr<IAudioCaptureClient> capture;
    std::deque<float> samples;
    State() { check(enterComApartment(apartment)); }
    ~State() { if (client) client->Stop(); capture.Reset(); client.Reset(); if (apartment) CoUninitialize(); }
};
SystemAudio::SystemAudio(QObject* parent) : QObject(parent) {
    timer_.setParent(this); timer_.setInterval(20); timer_.setTimerType(Qt::PreciseTimer);
    connect(&timer_, &QTimer::timeout, this, &SystemAudio::tick);
    retry_.setParent(this); retry_.setInterval(2000);
    connect(&retry_, &QTimer::timeout, this, [this] { if (openCapture()) retry_.stop(); });
}
SystemAudio::~SystemAudio() { stop(); }
bool SystemAudio::start() {
    stop();
    if (openCapture()) return true;
    retry_.start(); return false;
}
bool SystemAudio::openCapture() {
    try {
        auto state = std::make_unique<State>(); auto activation = std::make_shared<ActivationState>();
        if (!activation->event) throw std::runtime_error("Audio event unavailable");
        // Keep the system module loaded for the process lifetime, including late async completion.
        static const auto library = LoadLibraryW(L"mmdevapi.dll");
        if (!library) throw std::runtime_error("Audio API unavailable");
        using Activate = HRESULT (WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);
        const auto activate = std::bit_cast<Activate>(GetProcAddress(library, "ActivateAudioInterfaceAsync"));
        ComPtr<IActivateAudioInterfaceCompletionHandler> handler; handler.Attach(new Completion(activation));
        ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
        const auto hr = activate ? activate(L"VAD\\Process_Loopback", __uuidof(IAudioClient), &activation->variant, handler.Get(), &operation) : E_NOTIMPL;
        check(hr);
        const auto wait = WaitForSingleObject(activation->event, 3000);
        if (wait != WAIT_OBJECT_0) throw std::runtime_error("Audio activation timeout");
        check(activation->result); state->client = activation->client;
        WAVEFORMATEX format{}; format.wFormatTag = WAVE_FORMAT_PCM; format.nChannels = 2;
        format.nSamplesPerSec = VoiceRate; format.wBitsPerSample = 16; format.nBlockAlign = 4;
        format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
        check(state->client->Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
              2000000, 0, &format, nullptr));
        check(state->client->GetService(__uuidof(IAudioCaptureClient), reinterpret_cast<void**>(state->capture.GetAddressOf())));
        check(state->client->Start()); state_ = std::move(state); failure_.clear(); timer_.start(); return true;
    } catch (const std::exception& failure) {
        const bool firstFailure = failure_.isEmpty();
        failure_ = QString::fromUtf8(failure.what());
        timer_.stop(); state_.reset();
        if (firstFailure) emit error("não foi possível capturar o áudio do pc. tentando reconectar a captura.");
        return false;
    }
}
void SystemAudio::stop() { retry_.stop(); timer_.stop(); state_.reset(); failure_.clear(); }
void SystemAudio::tick() {
    if (!state_) return;
    try {
        UINT32 pending = 0; check(state_->capture->GetNextPacketSize(&pending));
        for (int packet = 0; pending && packet < 10; ++packet) {
            BYTE* data = nullptr; UINT32 count = 0; DWORD flags = 0;
            check(state_->capture->GetBuffer(&data, &count, &flags, nullptr, nullptr));
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) state_->samples.clear();
            // A delayed tick can leave a large packet. Keep its newest 100 ms
            // instead of permanently stopping capture after a scheduling stall.
            if (count > VoiceSamples * 5) state_->samples.clear();
            const auto* pcm = reinterpret_cast<const int16_t*>(data);
            const UINT32 first = count > VoiceSamples * 5 ? count - VoiceSamples * 5 : 0;
            for (UINT32 i = first; i < count; ++i) {
                const float sample = (flags & AUDCLNT_BUFFERFLAGS_SILENT) ? 0.f : (float(pcm[2*i]) + pcm[2*i+1]) / 65536.f;
                state_->samples.push_back(sample);
            }
            check(state_->capture->ReleaseBuffer(count));
            while (state_->samples.size() > VoiceSamples * 5) state_->samples.pop_front();
            while (state_->samples.size() >= VoiceSamples) {
                VoiceFrame frame{}; for (auto& sample : frame) { sample = state_->samples.front(); state_->samples.pop_front(); }
                emit captured(encoder_.encode(frame));
            }
            check(state_->capture->GetNextPacketSize(&pending));
        }
    } catch (const std::exception& failure) {
        timer_.stop(); state_.reset(); failure_ = QString::fromUtf8(failure.what());
        retry_.start(); emit error("a captura do áudio do pc parou. tentando reconectar a captura.");
    }
}
}
