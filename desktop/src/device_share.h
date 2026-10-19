#pragma once
#include "camera_service.h"
#include "camera_encoder.h"
#include <QElapsedTimer>
#include <QThread>
#include <QTimer>
#include <atomic>
namespace triscord {
class ScreenService;
// "Dispositivos" tab of the share picker (SHARE.md: capture devices with a "Transmitir" button): a capture device is
// streamed as the user's screen share. Frames come from CameraService, are encoded on a media thread with the screen
// preset chosen in the picker and go out through the screen room (ScreenService::startExternal / sendFrame), so viewers
// see an ordinary stream.
class DeviceShareWorker final : public QObject {
    Q_OBJECT
public:
    explicit DeviceShareWorker(ScreenService* screen);
    void start(quint64 generation, VideoConfig config);
    void stop();
    void consume(quint64 generation, const QVideoFrame& frame);
    void requestKeyframe() { if (encoder_) encoder_->requestKeyframe(); }
    void setBitrate(int bitrate) {
        try { if (encoder_) encoder_->setBitrate(bitrate); }
        catch (const std::exception&) { emit failed(generation_, "não foi possível ajustar a qualidade do dispositivo."); }
    }
signals:
    void image(quint64 generation, const QImage& image);
    void failed(quint64 generation, const QString& text);
private:
    ScreenService* screen_;
    std::unique_ptr<CameraEncoder> encoder_;
    QTimer drain_;
    QElapsedTimer clock_, preview_;
    VideoConfig config_;
    quint64 generation_ = 0;
    qint64 lastTime_ = -1;
};
class DeviceShare final : public QObject {
    Q_OBJECT
public:
    explicit DeviceShare(ScreenService* screen, QObject* parent = nullptr);
    ~DeviceShare() override;
    void start(const QByteArray& deviceId, VideoConfig config);
    void stop();
    bool active() const { return wanted_->load() != 0; }
signals:
    void image(const QImage& image);   // local preview of the stream, at most every 66 ms
    void message(const QString& text);
private:
    ScreenService* screen_;
    QThread thread_;
    DeviceShareWorker* worker_;
    std::unique_ptr<CameraService> capture_;
    std::shared_ptr<CameraFrames> frames_ = std::make_shared<CameraFrames>();
    std::shared_ptr<std::atomic<quint64>> wanted_ = std::make_shared<std::atomic<quint64>>(0);
    std::shared_ptr<std::atomic<quint64>> source_ = std::make_shared<std::atomic<quint64>>(0);
    quint64 next_ = 0;
};
}
