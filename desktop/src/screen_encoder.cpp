#include "screen_encoder.h"
#include <stdexcept>
#include <QtGlobal>
#include <windows.h>

namespace triscord {
namespace {
VideoConfig checked(VideoConfig config) {
    if (!config.valid()) throw std::invalid_argument("Invalid screen encoding configuration");
    return config;
}
}
ScreenEncoder::ScreenEncoder(const CaptureSource& source, VideoConfig config)
    : config_(checked(config)), source_(source), capture_(source, config_.fps),
      converter_(capture_.device(), capture_.context(), config_.size, config_.fps),
      // Hardware first; the Microsoft software H.264 encoder when the GPU has none (18/10: sharing stayed black on a
      // friend's PC, the screen encoder was hardware-only).
      encoder_(config_, qEnvironmentVariable("TRISCORD_SCREEN_ENCODER") == "software" ? EncoderPreference::SoftwareOnly   // tests
                                                                                      : EncoderPreference::HardwarePreferred, capture_.device()) { clock_.start(); }
bool ScreenEncoder::submitCpu(ID3D11Texture2D* nv12, qint64 timestamp) {
    D3D11_TEXTURE2D_DESC desc{}; nv12->GetDesc(&desc);
    if (!staging_) {
        D3D11_TEXTURE2D_DESC staging = desc; staging.Usage = D3D11_USAGE_STAGING; staging.BindFlags = 0;
        staging.CPUAccessFlags = D3D11_CPU_ACCESS_READ; staging.MiscFlags = 0;
        if (FAILED(capture_.device()->CreateTexture2D(&staging, nullptr, &staging_))) throw std::runtime_error("NV12 staging unavailable");
    }
    auto* context = capture_.context();
    context->CopyResource(staging_.Get(), nv12);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    if (FAILED(context->Map(staging_.Get(), 0, D3D11_MAP_READ, 0, &mapped))) throw std::runtime_error("NV12 readback failed");
    const int width = int(desc.Width), height = int(desc.Height);
    QByteArray bytes(width * height * 3 / 2, Qt::Uninitialized);
    const auto* source = static_cast<const char*>(mapped.pData);
    for (int y = 0; y < height; ++y) memcpy(bytes.data() + y * width, source + y * mapped.RowPitch, width);
    const auto* chroma = source + mapped.RowPitch * height;
    for (int y = 0; y < height / 2; ++y) memcpy(bytes.data() + width * height + y * width, chroma + y * mapped.RowPitch, width);
    context->Unmap(staging_.Get(), 0);
    return encoder_.submit(bytes, timestamp);
}
ScreenTick ScreenEncoder::tick() {
    bool minimized = false;
    if (source_.kind == CaptureSource::Kind::Window) {
        auto window = reinterpret_cast<HWND>(source_.handle);
        DWORD process = 0; GetWindowThreadProcessId(window, &process);
        if (!IsWindow(window) || !IsWindowVisible(window) || process != source_.processId)
            throw std::runtime_error("Screen source unavailable");
        minimized = IsIconic(window);
    } else {
        MONITORINFO info{}; info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(reinterpret_cast<HMONITOR>(source_.handle), &info))
            throw std::runtime_error("Screen source unavailable");
    }
    ScreenTick result;
    result.encoded = encoder_.poll();
    const qint64 timestamp = clock_.nsecsElapsed() / 100;
    const bool ready = encoder_.ready();
    if (!minimized) result.preview = capture_.next([&](ID3D11Texture2D* texture, QSize size, qint64) {
        if (latest_ && !schedule_.timeDue(timestamp, config_.fps)) return;
        latest_ = converter_.convert(texture, size); pendingFrame_ = true;
    });
    // next() completes the GPU graphics copy before releasing the WGC lease.
    // MF retains the newly allocated immutable NV12 texture on accepted input.
    if (latest_ && schedule_.shouldSubmit(timestamp, config_.fps, pendingFrame_, ready)
        && (encoder_.acceptsTextures() ? encoder_.submitTexture(latest_.Get(), timestamp) : submitCpu(latest_.Get(), timestamp))) {
        schedule_.submitted(timestamp); pendingFrame_ = false;
    }
    return result;
}
bool ScreenEncoder::requestKeyframe() { schedule_.requestKeyframe(); return encoder_.requestKeyframe(); }
}
