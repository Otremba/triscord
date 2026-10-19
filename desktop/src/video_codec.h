#pragma once
#include <QByteArray>
#include <QSize>
#include <memory>
#include <vector>
struct ID3D11Device;
struct ID3D11Texture2D;

namespace triscord {
struct VideoConfig {
    QSize size{1280, 720};
    int fps = 30;
    int bitrate = 2500000;
    bool valid() const;
    qsizetype nv12Bytes() const;
};
struct EncodedVideo {
    QByteArray annexB;
    qint64 time100ns = 0;
    qint64 duration100ns = 0;
    bool keyframe = false;
};
struct DecodedVideo {
    QByteArray nv12;
    QSize size;
    qint64 time100ns = 0;
};
enum class EncoderPreference { HardwarePreferred, SoftwareOnly, HardwareOnly };

// Thread confined. Input is tightly packed NV12; no capture, queue, or timer is
// owned here. A busy encoder rejects input so the caller can drop that frame.
class VideoEncoder final {
public:
    explicit VideoEncoder(VideoConfig config, EncoderPreference preference = EncoderPreference::HardwarePreferred, ID3D11Device* device = nullptr);
    ~VideoEncoder();
    bool submit(const QByteArray& nv12, qint64 time100ns);
    // Only available when a D3D11-aware hardware encoder accepted this device.
    // Submitted textures must stay immutable. MF retains their lifetime; safe
    // texture recycling via tracked samples is a separate integration step.
    bool submitTexture(ID3D11Texture2D* nv12, qint64 time100ns);
    bool acceptsTextures() const;
    bool ready();
    std::vector<EncodedVideo> poll();
    bool requestKeyframe();
    void setBitrate(int bitrate);
    bool hardware() const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
// CPU NV12 decoding is the compatibility path; GPU presentation follows later.
class VideoDecoder final {
public:
    explicit VideoDecoder(VideoConfig config);
    ~VideoDecoder();
    bool submit(const EncodedVideo& frame);
    std::vector<DecodedVideo> poll();
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
