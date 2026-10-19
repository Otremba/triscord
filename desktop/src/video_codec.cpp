#include "video_codec.h"
#include "com_apartment.h"
#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>
#include <d3d11.h>
#include <d3d10.h>
#include <wrl/client.h>
#include <algorithm>
#include <cstring>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;
namespace triscord {
namespace {
void check(HRESULT hr, const char* operation) {
    if (FAILED(hr)) throw std::runtime_error(std::string(operation) + " HRESULT=" + std::to_string(uint32_t(hr)));
}
class Runtime final {
public:
    Runtime() {
        check(enterComApartment(com_), "COM video initialization");
        const auto hr = MFStartup(MF_VERSION, MFSTARTUP_FULL);
        if (FAILED(hr)) { if (com_) CoUninitialize(); check(hr, "Media Foundation initialization"); }
    }
    ~Runtime() { MFShutdown(); if (com_) CoUninitialize(); }
private:
    bool com_ = false;
};
struct Activations {
    IMFActivate** items = nullptr;
    UINT32 count = 0;
    ~Activations() {
        for (UINT32 n = 0; n < count; ++n) items[n]->Release();
        CoTaskMemFree(items);
    }
};
ComPtr<IMFMediaType> mediaType(const VideoConfig& config, const GUID& subtype) {
    ComPtr<IMFMediaType> type;
    check(MFCreateMediaType(&type), "Video media type");
    check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video), "Video major type");
    check(type->SetGUID(MF_MT_SUBTYPE, subtype), "Video subtype");
    check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, UINT32(config.size.width()), UINT32(config.size.height())), "Video size");
    check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, UINT32(config.fps), 1), "Video rate");
    check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1), "Video aspect");
    check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive), "Video progressive mode");
    check(type->SetUINT32(MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709), "Video primaries");
    check(type->SetUINT32(MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709), "Video matrix");
    check(type->SetUINT32(MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709), "Video transfer");
    check(type->SetUINT32(MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235), "Video range");
    return type;
}
ComPtr<IMFSample> sample(const QByteArray& bytes, qint64 time, qint64 duration) {
    ComPtr<IMFSample> result;
    ComPtr<IMFMediaBuffer> buffer;
    check(MFCreateSample(&result), "Video sample");
    check(MFCreateMemoryBuffer(DWORD(bytes.size()), &buffer), "Video input buffer");
    BYTE* data = nullptr;
    check(buffer->Lock(&data, nullptr, nullptr), "Video input lock");
    std::memcpy(data, bytes.constData(), size_t(bytes.size()));
    check(buffer->Unlock(), "Video input unlock");
    check(buffer->SetCurrentLength(DWORD(bytes.size())), "Video input length");
    check(result->AddBuffer(buffer.Get()), "Video sample buffer");
    check(result->SetSampleTime(time), "Video sample time");
    check(result->SetSampleDuration(duration), "Video sample duration");
    return result;
}
QByteArray bytes(IMFSample* sample) {
    ComPtr<IMFMediaBuffer> buffer;
    check(sample->ConvertToContiguousBuffer(&buffer), "Contiguous video output");
    DWORD length = 0;
    check(buffer->GetCurrentLength(&length), "Video output length");
    // A codec must not create unbounded application allocations.
    if (length > 8 * 1024 * 1024) throw std::runtime_error("Video output too large");
    BYTE* data = nullptr;
    check(buffer->Lock(&data, nullptr, nullptr), "Video output lock");
    QByteArray result(reinterpret_cast<const char*>(data), qsizetype(length));
    check(buffer->Unlock(), "Video output unlock");
    return result;
}
struct Output {
    MFT_OUTPUT_DATA_BUFFER value{};
    ComPtr<IMFSample> supplied;
    ~Output() {
        if (value.pEvents) value.pEvents->Release();
        if (value.pSample && value.pSample != supplied.Get()) value.pSample->Release();
    }
};
HRESULT output(IMFTransform* transform, Output& result) {
    MFT_OUTPUT_STREAM_INFO info{};
    check(transform->GetOutputStreamInfo(0, &info), "Video output requirements");
    if (!(info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES)) {
        if (!info.cbSize || info.cbSize > 8 * 1024 * 1024) throw std::runtime_error("Invalid video output buffer size");
        check(MFCreateSample(&result.supplied), "Video output sample");
        ComPtr<IMFMediaBuffer> buffer;
        check(MFCreateAlignedMemoryBuffer(info.cbSize, info.cbAlignment ? info.cbAlignment - 1 : 0, &buffer), "Video output allocation");
        check(result.supplied->AddBuffer(buffer.Get()), "Video output buffer");
        result.value.pSample = result.supplied.Get();
    }
    DWORD status = 0;
    return transform->ProcessOutput(0, 1, &result.value, &status);
}
bool property(IMFTransform* transform, const GUID& id, ULONG value, bool boolean = false) {
    ComPtr<ICodecAPI> codec;
    if (FAILED(transform->QueryInterface(IID_ICodecAPI, reinterpret_cast<void**>(codec.GetAddressOf())))) return false;
    VARIANT variant{};
    variant.vt = boolean ? VT_BOOL : VT_UI4;
    if (boolean) variant.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
    else variant.ulVal = value;
    return SUCCEEDED(codec->SetValue(&id, &variant));
}
void begin(IMFTransform* transform) {
    check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0), "Video begin streaming");
    check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0), "Video start stream");
}
void end(IMFTransform* transform) noexcept {
    if (!transform) return;
    transform->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
    transform->ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
}
bool hasNal(const QByteArray& data, uint8_t type) {
    for (qsizetype n = 0; n + 3 < data.size(); ++n) {
        if (data[n] || data[n + 1]) continue;
        const auto offset = data[n + 2] == 1 ? 3 : (n + 4 < data.size() && !data[n + 2] && data[n + 3] == 1 ? 4 : 0);
        if (offset && (uint8_t(data[n + offset]) & 31) == type) return true;
    }
    return false;
}
}
bool VideoConfig::valid() const {
    return size.width() >= 64 && size.height() >= 64 && size.width() <= 1920 && size.height() <= 1080 &&
        !(size.width() % 2) && !(size.height() % 2) && fps >= 1 && fps <= 60 && bitrate >= 64000 && bitrate <= 20000000;
}
qsizetype VideoConfig::nv12Bytes() const { return valid() ? qsizetype(size.width()) * size.height() * 3 / 2 : 0; }

struct VideoEncoder::State {
    Runtime runtime; // Outlives every MF/COM object below.
    VideoConfig config;
    ComPtr<IMFTransform> transform;
    ComPtr<IMFActivate> activation;
    ComPtr<IMFMediaEventGenerator> events;
    ComPtr<IMFDXGIDeviceManager> manager;
    ComPtr<ID3D11Device> device;
    bool hardware = false;
    unsigned inputCredits = 0;
    unsigned outputCredits = 0;
    unsigned inFlight = 0;
    qint64 lastTime = -1;
    ~State() { end(transform.Get()); if (activation) activation->ShutdownObject(); }
    void collectEvents() {
        if (!events) return;
        for (int n = 0; n < 64; ++n) {
            ComPtr<IMFMediaEvent> event;
            auto hr = events->GetEvent(MF_EVENT_FLAG_NO_WAIT, &event);
            if (hr == MF_E_NO_EVENTS_AVAILABLE) break;
            check(hr, "Video encoder event");
            HRESULT status = S_OK;
            check(event->GetStatus(&status), "Video encoder event status"); check(status, "Asynchronous video encoding");
            MediaEventType type{}; check(event->GetType(&type), "Video encoder event type");
            if (type == METransformNeedInput) ++inputCredits;
            else if (type == METransformHaveOutput) ++outputCredits;
            if (inputCredits > 64 || outputCredits > 64) throw std::runtime_error("Excessive encoder events");
        }
    }
};
VideoEncoder::VideoEncoder(VideoConfig config, EncoderPreference preference, ID3D11Device* device) {
    if (!config.valid()) throw std::invalid_argument("Invalid video configuration");
    state_ = std::make_unique<State>(); state_->config = config;
    auto& state = *state_;
    if (device) {
        UINT token = 0;
        check(MFCreateDXGIDeviceManager(&token, &state.manager), "Video DXGI manager");
        check(state.manager->ResetDevice(device, token), "Video DXGI device");
        ComPtr<ID3D10Multithread> protection;
        check(device->QueryInterface(IID_PPV_ARGS(&protection)), "Video device multithread protection");
        protection->SetMultithreadProtected(TRUE);
    }
    std::string lastError;
    auto select = [&](bool hardware) {
        Activations candidates;
        MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_NV12};
        MFT_REGISTER_TYPE_INFO out{MFMediaType_Video, MFVideoFormat_H264};
        check(MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, (hardware ? MFT_ENUM_FLAG_HARDWARE : MFT_ENUM_FLAG_SYNCMFT) | MFT_ENUM_FLAG_SORTANDFILTER,
            &input, &out, &candidates.items, &candidates.count), "Enumerate H264 encoders");
        for (UINT32 n = 0; n < candidates.count; ++n) {
            ComPtr<IMFTransform> transform;
            try {
                check(candidates.items[n]->ActivateObject(IID_PPV_ARGS(&transform)), "Activate H264 encoder");
                ComPtr<IMFAttributes> attributes;
                check(transform->GetAttributes(&attributes), "Encoder attributes");
                UINT32 async = 0; attributes->GetUINT32(MF_TRANSFORM_ASYNC, &async);
                UINT32 aware = 0; attributes->GetUINT32(MF_SA_D3D11_AWARE, &aware);
                ComPtr<IMFMediaEventGenerator> events;
                if (async) {
                    check(attributes->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE), "Unlock asynchronous encoder");
                    check(transform->QueryInterface(IID_PPV_ARGS(&events)), "Encoder events");
                }
                if (device && hardware) {
                    if (!aware) throw std::runtime_error("Encoder does not accept D3D11 surfaces");
                    check(transform->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(state.manager.Get())), "Encoder D3D11 manager");
                }
                // Baseline excludes B pictures. A two-second GOP permits recovery;
                // PLI will request an earlier IDR through requestKeyframe().
                property(transform.Get(), CODECAPI_AVLowLatencyMode, TRUE, true);
                property(transform.Get(), CODECAPI_AVEncMPVDefaultBPictureCount, 0);
                property(transform.Get(), CODECAPI_AVEncMPVGOPSize, ULONG(config.fps * 2));
                property(transform.Get(), CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
                auto outType = mediaType(config, MFVideoFormat_H264);
                check(outType->SetUINT32(MF_MT_AVG_BITRATE, UINT32(config.bitrate)), "Encoder bitrate");
                check(outType->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base), "Encoder baseline profile");
                check(transform->SetOutputType(0, outType.Get(), 0), "Encoder output type");
                auto inType = mediaType(config, MFVideoFormat_NV12);
                check(transform->SetInputType(0, inType.Get(), 0), "Encoder input type");
                begin(transform.Get());
                state.transform = transform; state.events = events;
                state.activation = candidates.items[n]; state.hardware = hardware;
                if (hardware && device) state.device = device;
                return true;
            } catch (const std::exception& error) {
                lastError = error.what();
                end(transform.Get()); candidates.items[n]->ShutdownObject();
            }
        }
        return false;
    };
    if (preference != EncoderPreference::SoftwareOnly && select(true)) return;
    if (preference != EncoderPreference::HardwareOnly && select(false)) return;
    throw std::runtime_error("No compatible H264 encoder: " + lastError);
}
VideoEncoder::~VideoEncoder() = default;
bool VideoEncoder::hardware() const { return state_->hardware; }
bool VideoEncoder::acceptsTextures() const { return bool(state_->device); }
bool VideoEncoder::ready() {
    state_->collectEvents();
    return state_->inFlight < 4 && (!state_->events || state_->inputCredits);
}
bool VideoEncoder::requestKeyframe() { return property(state_->transform.Get(), CODECAPI_AVEncVideoForceKeyFrame, TRUE); }
void VideoEncoder::setBitrate(int bitrate) {
    auto config = state_->config; config.bitrate = bitrate;
    if (!config.valid()) throw std::invalid_argument("Invalid adaptive video bitrate");
    if (bitrate == state_->config.bitrate) return;
    if (property(state_->transform.Get(), CODECAPI_AVEncCommonMeanBitRate, ULONG(bitrate))) {
        state_->config = config; return;
    }
    // Some MFTs cannot change bitrate live. Replace only the encoder, retaining
    // capture, dimensions, timestamps and peer connections; the next frame is IDR.
    VideoEncoder replacement(config, state_->hardware ? EncoderPreference::HardwarePreferred : EncoderPreference::SoftwareOnly, state_->device.Get());
    state_.swap(replacement.state_);
}
bool VideoEncoder::submit(const QByteArray& nv12, qint64 time100ns) {
    auto& state = *state_;
    if (nv12.size() != state.config.nv12Bytes() || time100ns < 0 || time100ns <= state.lastTime)
        throw std::invalid_argument("Invalid NV12 frame or timestamp");
    state.collectEvents();
    if ((state.events && !state.inputCredits) || state.inFlight >= 4) return false;
    auto input = sample(nv12, time100ns, 10000000 / state.config.fps);
    auto hr = state.transform->ProcessInput(0, input.Get(), 0);
    if (hr == MF_E_NOTACCEPTING) return false;
    check(hr, "Encode video input");
    if (state.events) --state.inputCredits;
    ++state.inFlight;
    state.lastTime = time100ns;
    return true;
}
bool VideoEncoder::submitTexture(ID3D11Texture2D* nv12, qint64 time100ns) {
    auto& state = *state_;
    if (!state.device || !nv12 || time100ns < 0 || time100ns <= state.lastTime)
        throw std::invalid_argument("Invalid GPU video input");
    D3D11_TEXTURE2D_DESC desc{}; nv12->GetDesc(&desc);
    ComPtr<ID3D11Device> owner; nv12->GetDevice(&owner);
    if (owner.Get() != state.device.Get() || desc.Format != DXGI_FORMAT_NV12 || desc.Width != UINT(state.config.size.width()) ||
        desc.Height != UINT(state.config.size.height()) || desc.ArraySize != 1 || desc.MipLevels != 1)
        throw std::invalid_argument("NV12 texture does not match encoder device/configuration");
    state.collectEvents();
    if ((state.events && !state.inputCredits) || state.inFlight >= 4) return false;
    ComPtr<IMFSample> input;
    ComPtr<IMFMediaBuffer> surface;
    check(MFCreateSample(&input), "GPU video sample");
    check(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), nv12, 0, FALSE, &surface), "GPU NV12 surface");
    check(input->AddBuffer(surface.Get()), "GPU video buffer");
    check(input->SetSampleTime(time100ns), "GPU video timestamp");
    check(input->SetSampleDuration(10000000 / state.config.fps), "GPU video duration");
    auto hr = state.transform->ProcessInput(0, input.Get(), 0);
    if (hr == MF_E_NOTACCEPTING) return false;
    check(hr, "Encode GPU video input");
    if (state.events) --state.inputCredits;
    ++state.inFlight; state.lastTime = time100ns;
    return true;
}
std::vector<EncodedVideo> VideoEncoder::poll() {
    auto& state = *state_;
    state.collectEvents();
    std::vector<EncodedVideo> frames;
    for (int n = 0; n < 4; ++n) {
        if (state.events && !state.outputCredits) break;
        Output result;
        auto hr = output(state.transform.Get(), result);
        if (!state.events && hr == MF_E_TRANSFORM_NEED_MORE_INPUT) break;
        check(hr, "Encode video output");
        if (state.events) --state.outputCredits;
        if (state.inFlight) --state.inFlight;
        if (!result.value.pSample) throw std::runtime_error("Missing encoded video sample");
        EncodedVideo frame;
        frame.annexB = bytes(result.value.pSample);
        check(result.value.pSample->GetSampleTime(&frame.time100ns), "Encoded video timestamp");
        check(result.value.pSample->GetSampleDuration(&frame.duration100ns), "Encoded video duration");
        frame.keyframe = hasNal(frame.annexB, 5);
        if (frame.keyframe && (!hasNal(frame.annexB, 7) || !hasNal(frame.annexB, 8))) {
            ComPtr<IMFMediaType> type;
            check(state.transform->GetOutputCurrentType(0, &type), "H264 sequence header type");
            UINT32 size = 0;
            check(type->GetBlobSize(MF_MT_MPEG_SEQUENCE_HEADER, &size), "H264 sequence header size");
            if (!size || size > 65536) throw std::runtime_error("Invalid H264 sequence header");
            QByteArray header(qsizetype(size), Qt::Uninitialized);
            check(type->GetBlob(MF_MT_MPEG_SEQUENCE_HEADER, reinterpret_cast<UINT8*>(header.data()), size, nullptr), "H264 sequence header");
            if (!hasNal(header, 7) || !hasNal(header, 8)) throw std::runtime_error("H264 header is not Annex B SPS/PPS");
            frame.annexB.prepend(header);
        }
        frames.push_back(std::move(frame));
    }
    return frames;
}
struct VideoDecoder::State {
    Runtime runtime;
    VideoConfig config;
    ComPtr<IMFTransform> transform;
    ComPtr<IMFActivate> activation;
    UINT32 codedHeight = 0;
    UINT32 stride = 0;
    unsigned inFlight = 0;
    ~State() { end(transform.Get()); if (activation) activation->ShutdownObject(); }
    void selectOutput() {
        for (DWORD n = 0; n < 64; ++n) {
            ComPtr<IMFMediaType> type;
            auto hr = transform->GetOutputAvailableType(0, n, &type);
            if (hr == MF_E_NO_MORE_TYPES) break;
            check(hr, "Decoder output types");
            GUID subtype{}; check(type->GetGUID(MF_MT_SUBTYPE, &subtype), "Decoder output subtype");
            UINT32 width = 0, height = 0;
            check(MFGetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, &width, &height), "Decoder output size");
            if (subtype != MFVideoFormat_NV12) continue;
            if (width < UINT32(config.size.width()) || width > UINT32(config.size.width() + 15) ||
                height < UINT32(config.size.height()) || height > UINT32(config.size.height() + 15))
                throw std::runtime_error("Unexpected video dimensions; recreate decoder for new configuration");
            UINT32 rowStride = width;
            type->GetUINT32(MF_MT_DEFAULT_STRIDE, &rowStride);
            if (rowStride < width || rowStride > 8192) throw std::runtime_error("Unsupported decoder stride");
            check(transform->SetOutputType(0, type.Get(), 0), "Decoder NV12 output");
            codedHeight = height; stride = rowStride;
            return;
        }
        throw std::runtime_error("No NV12 decoder output");
    }
};
VideoDecoder::VideoDecoder(VideoConfig config) {
    if (!config.valid()) throw std::invalid_argument("Invalid video configuration");
    state_ = std::make_unique<State>(); state_->config = config;
    auto& state = *state_;
    Activations candidates;
    MFT_REGISTER_TYPE_INFO input{MFMediaType_Video, MFVideoFormat_H264};
    MFT_REGISTER_TYPE_INFO out{MFMediaType_Video, MFVideoFormat_NV12};
    check(MFTEnumEx(MFT_CATEGORY_VIDEO_DECODER, MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_SORTANDFILTER, &input, &out,
        &candidates.items, &candidates.count), "Enumerate H264 decoders");
    if (!candidates.count) throw std::runtime_error("No H264 decoder");
    state.activation = candidates.items[0];
    check(state.activation->ActivateObject(IID_PPV_ARGS(&state.transform)), "Activate H264 decoder");
    ComPtr<IMFAttributes> attributes;
    check(state.transform->GetAttributes(&attributes), "Decoder attributes");
    check(attributes->SetUINT32(MF_LOW_LATENCY, TRUE), "Decoder low latency");
    property(state.transform.Get(), CODECAPI_AVLowLatencyMode, TRUE, true);
    auto type = mediaType(config, MFVideoFormat_H264);
    check(state.transform->SetInputType(0, type.Get(), 0), "Decoder input type");
    state.selectOutput(); begin(state.transform.Get());
}
VideoDecoder::~VideoDecoder() = default;
bool VideoDecoder::submit(const EncodedVideo& frame) {
    if (frame.annexB.isEmpty() || frame.annexB.size() > 8 * 1024 * 1024 || frame.time100ns < 0 || frame.duration100ns <= 0)
        throw std::invalid_argument("Invalid H264 sample");
    if (state_->inFlight >= 4) return false;
    auto input = sample(frame.annexB, frame.time100ns, frame.duration100ns);
    auto hr = state_->transform->ProcessInput(0, input.Get(), 0);
    if (hr == MF_E_NOTACCEPTING) return false;
    check(hr, "Decode video input"); ++state_->inFlight; return true;
}
std::vector<DecodedVideo> VideoDecoder::poll() {
    std::vector<DecodedVideo> frames;
    for (int n = 0; n < 4; ++n) {
        Output result;
        auto hr = output(state_->transform.Get(), result);
        if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) break;
        if (hr == MF_E_TRANSFORM_STREAM_CHANGE) { state_->selectOutput(); continue; }
        check(hr, "Decode video output");
        if (state_->inFlight) --state_->inFlight;
        if (!result.value.pSample) throw std::runtime_error("Missing decoded video sample");
        DecodedVideo frame;
        frame.size = state_->config.size;
        const auto padded = bytes(result.value.pSample);
        check(result.value.pSample->GetSampleTime(&frame.time100ns), "Decoded video timestamp");
        const auto stride = state_->stride;
        const qsizetype uvOffset = qsizetype(stride) * state_->codedHeight;
        const auto width = frame.size.width(), height = frame.size.height();
        if (padded.size() < uvOffset + qsizetype(stride) * height / 2) throw std::runtime_error("Truncated NV12 output");
        frame.nv12.resize(state_->config.nv12Bytes());
        for (int row = 0; row < height; ++row)
            std::memcpy(frame.nv12.data() + qsizetype(row) * width, padded.constData() + qsizetype(row) * stride, size_t(width));
        for (int row = 0; row < height / 2; ++row)
            std::memcpy(frame.nv12.data() + qsizetype(width) * height + qsizetype(row) * width,
                padded.constData() + uvOffset + qsizetype(row) * stride, size_t(width));
        frames.push_back(std::move(frame));
    }
    return frames;
}
}
