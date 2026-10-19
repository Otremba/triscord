#pragma once
#include "capture_native.h"
#include "video_codec.h"
#include "video_gpu.h"
#include "screen_quality.h"
#include <QElapsedTimer>

namespace triscord {
struct ScreenTick {
    std::optional<CapturePreview> preview;
    std::vector<EncodedVideo> encoded;
};
// Owned by a capture/media worker, never the UI thread. This component has no
// timer, transport, history or recording. Poll explicitly while sharing.
class ScreenEncoder final {
public:
    ScreenEncoder(const CaptureSource& source, VideoConfig config);
    ScreenTick tick();
    bool requestKeyframe();
    void setBitrate(int bitrate) { encoder_.setBitrate(bitrate); requestKeyframe(); }
private:
    VideoConfig config_;
    CaptureSource source_;
    NativeCapture capture_; // Device/COM apartment outlive converter and encoder.
    VideoGpuConverter converter_;
    VideoEncoder encoder_;
    QElapsedTimer clock_;
    ScreenFrameSchedule schedule_;
    bool pendingFrame_ = false;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> latest_; // immutable NV12, never a retained WGC frame
    Microsoft::WRL::ComPtr<ID3D11Texture2D> staging_;   // software encoder: NV12 read back to memory
    bool submitCpu(ID3D11Texture2D* nv12, qint64 timestamp);
};
}
