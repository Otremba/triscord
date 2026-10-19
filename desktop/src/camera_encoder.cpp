#include "camera_encoder.h"
#include "video_gpu.h"
#include <QTransform>
#include <QColorSpace>
#include <d3d11.h>
#include <wrl/client.h>
#include <cstring>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
namespace triscord {
namespace {
void check(HRESULT result) { if (FAILED(result)) throw std::runtime_error("Camera GPU conversion unavailable"); }
void validFrame(const QVideoFrame& frame) {
    if (!frame.isValid() || frame.width() < 1 || frame.height() < 1 || frame.width() > 4096 || frame.height() > 2160)
        throw std::invalid_argument("Invalid camera frame");
    const auto transfer = frame.surfaceFormat().colorTransfer();
    if (transfer == QVideoFrameFormat::ColorTransfer_ST2084 || transfer == QVideoFrameFormat::ColorTransfer_STD_B67)
        throw std::invalid_argument("HDR camera frames require a tone-mapping path");
}
bool directNv12(const QVideoFrame& frame, QSize output) {
    const auto format = frame.surfaceFormat();
    return frame.pixelFormat() == QVideoFrameFormat::Format_NV12 && frame.size() == output &&
        frame.rotation() == QtVideo::Rotation::None && format.scanLineDirection() == QVideoFrameFormat::TopToBottom &&
        format.viewport() == QRect(QPoint{}, output) && format.colorSpace() == QVideoFrameFormat::ColorSpace_BT709 &&
        format.colorRange() == QVideoFrameFormat::ColorRange_Video;
}
QByteArray packNv12(QVideoFrame& frame, VideoConfig config) {
    if (!frame.map(QVideoFrame::ReadOnly)) throw std::runtime_error("Camera frame mapping failed");
    struct Unmap { QVideoFrame& frame; ~Unmap() { frame.unmap(); } } unmap{frame};
    if (frame.planeCount() != 2) throw std::runtime_error("Invalid NV12 camera planes");
    QByteArray bytes(config.nv12Bytes(), Qt::Uninitialized);
    const int width = config.size.width(), height = config.size.height();
    for (int plane = 0; plane < 2; ++plane) {
        const int rows = plane == 0 ? height : height / 2, stride = frame.bytesPerLine(plane);
        if (!frame.bits(plane) || stride < width || qint64(frame.mappedBytes(plane)) < qint64(rows - 1) * stride + width)
            throw std::runtime_error("Invalid NV12 camera stride or plane length");
        auto* target = bytes.data() + (plane == 0 ? 0 : width * height);
        for (int row = 0; row < rows; ++row)
            std::memcpy(target + row * width, frame.bits(plane) + qsizetype(row) * stride, size_t(width));
    }
    return bytes;
}
}
QImage cameraImage(const QVideoFrame& frame) {
    validFrame(frame);
    auto image = frame.toImage();
    if (image.isNull()) throw std::runtime_error("Camera image conversion failed");
    if (frame.rotation() != QtVideo::Rotation::None)
        image = image.transformed(QTransform().rotate(int(frame.rotation())));
    if (image.colorSpace().isValid() && image.colorSpace() != QColorSpace(QColorSpace::SRgb))
        return image.convertedToColorSpace(QColorSpace::SRgb, QImage::Format_ARGB32);
    return image.convertToFormat(QImage::Format_ARGB32);
}
struct CameraEncoder::State {
    VideoConfig config;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    std::unique_ptr<VideoGpuConverter> converter;
    std::unique_ptr<VideoEncoder> encoder;
    ComPtr<ID3D11Texture2D> upload, staging;
    QSize uploadSize;
    qint64 lastTime = -1;
    State(VideoConfig value, EncoderPreference preference) : config(value) {
        if (!config.valid()) throw std::invalid_argument("Invalid camera encoding configuration");
        if (preference != EncoderPreference::SoftwareOnly) {
            try { ensureGpu(); }
            catch (const std::runtime_error&) { if (preference == EncoderPreference::HardwareOnly) throw; }
        }
        encoder = std::make_unique<VideoEncoder>(config, preference, device.Get());
    }
    void ensureGpu() {
        if (device) return;
        ComPtr<ID3D11Device> selectedDevice; ComPtr<ID3D11DeviceContext> selectedContext;
        check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0,
            D3D11_SDK_VERSION, &selectedDevice, nullptr, &selectedContext));
        auto selectedConverter = std::make_unique<VideoGpuConverter>(selectedDevice.Get(), selectedContext.Get(), config.size, config.fps);
        device = std::move(selectedDevice); context = std::move(selectedContext); converter = std::move(selectedConverter);
    }
    ComPtr<ID3D11Texture2D> uploadNv12(const QByteArray& bytes) {
        D3D11_TEXTURE2D_DESC desc{}; desc.Width = UINT(config.size.width()); desc.Height = UINT(config.size.height());
        desc.MipLevels = desc.ArraySize = 1; desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_NV12; desc.Usage = D3D11_USAGE_DEFAULT; desc.BindFlags = D3D11_BIND_RENDER_TARGET;
        D3D11_SUBRESOURCE_DATA source{}; source.pSysMem = bytes.constData(); source.SysMemPitch = UINT(config.size.width());
        ComPtr<ID3D11Texture2D> texture; check(device->CreateTexture2D(&desc, &source, &texture)); return texture;
    }
    ComPtr<ID3D11Texture2D> convert(const QImage& image) {
        ensureGpu();
        if (uploadSize != image.size()) {
            upload.Reset();
            D3D11_TEXTURE2D_DESC desc{}; desc.Width = UINT(image.width()); desc.Height = UINT(image.height());
            desc.MipLevels = desc.ArraySize = 1; desc.SampleDesc.Count = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.Usage = D3D11_USAGE_DEFAULT;
            check(device->CreateTexture2D(&desc, nullptr, &upload)); uploadSize = image.size();
        }
        // Same immediate context orders the upload after the previous frame's GPU copy.
        context->UpdateSubresource(upload.Get(), 0, nullptr, image.constBits(), UINT(image.bytesPerLine()), 0);
        return converter->convert(upload.Get(), image.size());
    }
    QByteArray readback(ID3D11Texture2D* nv12) {
        if (!staging) {
            D3D11_TEXTURE2D_DESC desc{}; nv12->GetDesc(&desc);
            desc.Usage = D3D11_USAGE_STAGING; desc.BindFlags = 0; desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            check(device->CreateTexture2D(&desc, nullptr, &staging));
        }
        context->CopyResource(staging.Get(), nv12);
        D3D11_MAPPED_SUBRESOURCE mapped{}; check(context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped));
        struct Unmap { ID3D11DeviceContext* context; ID3D11Texture2D* texture; ~Unmap() { context->Unmap(texture, 0); } } unmap{context.Get(), staging.Get()};
        if (!mapped.pData || mapped.RowPitch < UINT(config.size.width())) throw std::runtime_error("Invalid camera readback pitch");
        QByteArray bytes(config.nv12Bytes(), Qt::Uninitialized);
        const auto* source = static_cast<const char*>(mapped.pData);
        for (int row = 0; row < config.size.height() * 3 / 2; ++row)
            std::memcpy(bytes.data() + row * config.size.width(), source + size_t(row) * mapped.RowPitch, size_t(config.size.width()));
        return bytes;
    }
};
CameraEncoder::CameraEncoder(VideoConfig config, EncoderPreference preference) : state_(std::make_unique<State>(config, preference)) {}
CameraEncoder::~CameraEncoder() = default;
bool CameraEncoder::submit(QVideoFrame frame, qint64 time100ns) {
    validFrame(frame); auto& state = *state_;
    if (time100ns < 0 || time100ns <= state.lastTime) throw std::invalid_argument("Invalid camera timestamp");
    if (!state.encoder->ready()) return false;
    bool accepted;
    if (directNv12(frame, state.config.size)) {
        const auto bytes = packNv12(frame, state.config);
        accepted = state.encoder->acceptsTextures() ? state.encoder->submitTexture(state.uploadNv12(bytes).Get(), time100ns)
                                                   : state.encoder->submit(bytes, time100ns);
    }
    else {
        const auto nv12 = state.convert(cameraImage(frame));
        accepted = state.encoder->acceptsTextures() ? state.encoder->submitTexture(nv12.Get(), time100ns)
                                                   : state.encoder->submit(state.readback(nv12.Get()), time100ns);
    }
    if (accepted) state.lastTime = time100ns;
    return accepted;
}
std::vector<EncodedVideo> CameraEncoder::poll() { return state_->encoder->poll(); }
bool CameraEncoder::submitSurface(ID3D11Texture2D* bgra,QSize content,qint64 time100ns) {
    auto& state=*state_;
    if (time100ns<0 || time100ns<=state.lastTime) throw std::invalid_argument("Invalid camera timestamp");
    if (!bgra) throw std::invalid_argument("Missing camera effect surface");
    if (!state.encoder->ready()) return false;
    state.ensureGpu();
    const auto nv12=state.converter->convert(bgra,content);
    const bool accepted=state.encoder->acceptsTextures()?state.encoder->submitTexture(nv12.Get(),time100ns):state.encoder->submit(state.readback(nv12.Get()),time100ns);
    if (accepted) state.lastTime=time100ns;
    return accepted;
}
bool CameraEncoder::ready() { return state_->encoder->ready(); }
ID3D11Device* CameraEncoder::gpuDevice() { state_->ensureGpu(); return state_->device.Get(); }
ID3D11DeviceContext* CameraEncoder::gpuContext() { state_->ensureGpu(); return state_->context.Get(); }
bool CameraEncoder::requestKeyframe() { return state_->encoder->requestKeyframe(); }
void CameraEncoder::setBitrate(int bitrate) { state_->encoder->setBitrate(bitrate); state_->encoder->requestKeyframe(); }
bool CameraEncoder::hardware() const { return state_->encoder->hardware(); }
}
