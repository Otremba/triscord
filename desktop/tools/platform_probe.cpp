#include "platform_probe.h"
#include <windows.h>
#include <psapi.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <wrl/client.h>
#include <QElapsedTimer>
#include <QJsonArray>

using Microsoft::WRL::ComPtr;
namespace triscord {
namespace {
QString errorText(HRESULT hr) { return QString("0x%1").arg(static_cast<quint32>(hr), 8, 16, QLatin1Char('0')); }
QJsonObject failure(const QString& stage, HRESULT hr) {
    return {{"ok", false}, {"stage", stage}, {"hresult", errorText(hr)}};
}
class ComScope {
public:
    ComScope() : hr(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
    ~ComScope() { if (SUCCEEDED(hr)) CoUninitialize(); }
    HRESULT hr;
};
HRESULT createDevice(ComPtr<ID3D11Device>& device, ComPtr<ID3D11DeviceContext>& context) {
    D3D_FEATURE_LEVEL level;
    return D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        device.GetAddressOf(), &level, context.GetAddressOf());
}
}

QJsonObject processMetrics() {
    PROCESS_MEMORY_COUNTERS_EX counters{};
    counters.cb = sizeof(counters);
    if (!GetProcessMemoryInfo(GetCurrentProcess(), reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&counters), sizeof(counters)))
        return {{"ok", false}};
    return {{"ok", true}, {"workingSetMB", static_cast<double>(counters.WorkingSetSize) / 1048576.0},
            {"privateMB", static_cast<double>(counters.PrivateUsage) / 1048576.0},
            {"pid", static_cast<double>(GetCurrentProcessId())}};
}

QJsonObject probeGraphics() {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    auto hr = createDevice(device, context);
    if (FAILED(hr)) return failure("D3D11CreateDevice", hr);
    ComPtr<IDXGIDevice> dxgi;
    hr = device.As(&dxgi);
    if (FAILED(hr)) return failure("IDXGIDevice", hr);
    ComPtr<IDXGIAdapter> adapter;
    hr = dxgi->GetAdapter(adapter.GetAddressOf());
    if (FAILED(hr)) return failure("GetAdapter", hr);
    DXGI_ADAPTER_DESC desc{};
    hr = adapter->GetDesc(&desc);
    if (FAILED(hr)) return failure("GetDesc", hr);
    return {{"ok", true}, {"adapter", QString::fromWCharArray(desc.Description)},
            {"dedicatedVideoMB", static_cast<double>(desc.DedicatedVideoMemory) / 1048576.0},
            {"featureLevel", static_cast<int>(device->GetFeatureLevel())},
            {"hardwareEncoderVerified", false}};
}

QJsonObject probeMicrophone() {
    ComScope com;
    if (FAILED(com.hr) && com.hr != RPC_E_CHANGED_MODE) return failure("COM", com.hr);
    ComPtr<IMMDeviceEnumerator> devices;
    auto hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(devices.GetAddressOf()));
    if (FAILED(hr)) return failure("IMMDeviceEnumerator", hr);
    ComPtr<IMMDevice> mic;
    hr = devices->GetDefaultAudioEndpoint(eCapture, eCommunications, mic.GetAddressOf());
    if (FAILED(hr)) return failure("DefaultMicrophone", hr);
    ComPtr<IAudioClient> audio;
    hr = mic->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(audio.GetAddressOf()));
    if (FAILED(hr)) return failure("IAudioClient", hr);
    WAVEFORMATEX* format = nullptr;
    hr = audio->GetMixFormat(&format);
    if (FAILED(hr)) return failure("GetMixFormat", hr);
    const QJsonObject result{{"ok", true}, {"sampleRate", static_cast<int>(format->nSamplesPerSec)},
                            {"channels", format->nChannels}, {"bitsPerSample", format->wBitsPerSample},
                            {"captureStarted", false}};
    CoTaskMemFree(format);
    return result;
}

QJsonObject probeDesktopFrame() {
    // A one-frame GPU-only diagnostic. No readback, image storage, or upload.
    // Desktop Duplication is the initial probe, not the final WGC window capture.
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    auto hr = createDevice(device, context);
    if (FAILED(hr)) return failure("D3D11CreateDevice", hr);
    ComPtr<IDXGIDevice> dxgi;
    hr = device.As(&dxgi);
    if (FAILED(hr)) return failure("IDXGIDevice", hr);
    ComPtr<IDXGIAdapter> adapter;
    hr = dxgi->GetAdapter(adapter.GetAddressOf());
    if (FAILED(hr)) return failure("GetAdapter", hr);
    ComPtr<IDXGIOutput> output;
    hr = adapter->EnumOutputs(0, output.GetAddressOf());
    if (FAILED(hr)) return failure("EnumOutputs", hr);
    ComPtr<IDXGIOutput1> output1;
    hr = output.As(&output1);
    if (FAILED(hr)) return failure("IDXGIOutput1", hr);
    ComPtr<IDXGIOutputDuplication> duplication;
    hr = output1->DuplicateOutput(device.Get(), duplication.GetAddressOf());
    if (FAILED(hr)) return failure("DuplicateOutput", hr);
    DXGI_OUTDUPL_FRAME_INFO info{};
    ComPtr<IDXGIResource> resource;
    QElapsedTimer timer;
    timer.start();
    hr = duplication->AcquireNextFrame(500, &info, resource.GetAddressOf());
    if (FAILED(hr)) return failure("AcquireNextFrame", hr);
    ComPtr<ID3D11Texture2D> texture;
    hr = resource.As(&texture);
    D3D11_TEXTURE2D_DESC desc{};
    if (SUCCEEDED(hr)) texture->GetDesc(&desc);
    duplication->ReleaseFrame();
    if (FAILED(hr)) return failure("ID3D11Texture2D", hr);
    return {{"ok", true}, {"width", static_cast<int>(desc.Width)}, {"height", static_cast<int>(desc.Height)},
            {"acquireMs", static_cast<double>(timer.elapsed())}, {"gpuTexture", true}, {"cpuReadback", false}};
}
}
