#pragma once
#include "video_codec.h"
#include <QVideoFrame>
struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11Texture2D;
namespace triscord {
// Create/use/destroy on an MTA media thread, never QApplication's STA UI thread.
// No capture/transport/queue. Busy input is dropped before conversion.
class CameraEncoder final {
public:
    explicit CameraEncoder(VideoConfig config = {}, EncoderPreference preference = EncoderPreference::HardwarePreferred);
    ~CameraEncoder();
    bool submit(QVideoFrame frame, qint64 time100ns);
    bool submitSurface(ID3D11Texture2D* bgra, QSize content, qint64 time100ns);
    bool ready();
    ID3D11Device* gpuDevice();
    ID3D11DeviceContext* gpuContext();
    std::vector<EncodedVideo> poll();
    bool requestKeyframe();
    void setBitrate(int bitrate);
    bool hardware() const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
// Applies camera orientation to pixels; presentation-only selfie mirroring is
// deliberately left to the local preview, so remote text is not reversed.
QImage cameraImage(const QVideoFrame& frame);
}
