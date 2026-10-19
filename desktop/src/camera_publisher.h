#pragma once
#include "camera_service.h"
#include "camera_encoder.h"
#include "screen_call.h"
#include "screen_service.h"
namespace triscord {
class CameraPublishWorker final : public QObject {
    Q_OBJECT
public:
    CameraPublishWorker(Signaling* signaling, ScreenCall::SourceMode mode);
    void start(quint64 generation);
    void stop();
    void leave();
    void setFocus(const QString& id);
    void consume(quint64 generation, const QVideoFrame& frame);
signals:
    void roomChanged(bool ready);
    void publishingChanged(quint64 generation, bool active);
    void message(quint64 generation, const QString& text);
    void image(const QString& id, quint64 generation, const QImage& image);
    void selected(const QString& id, quint64 generation);
    void removed(const QString& id);
private:
    ScreenCall* call_;
    std::unique_ptr<CameraEncoder> encoder_;
    QTimer drain_;
    QElapsedTimer clock_, preview_;
    quint64 generation_ = 0;
    qint64 lastTime_ = -1;
    bool ready_ = false;
    QString focus_;
};
class CameraPublisher final : public QObject {
    Q_OBJECT
public:
    explicit CameraPublisher(Signaling* signaling, QObject* parent = nullptr, ScreenCall::SourceMode mode = ScreenCall::SourceMode::External);
    ~CameraPublisher() override;
    void requestDevices();
    void start(const QByteArray& id = {});
    void stop();
    void leave();
    void setFocus(const QString& id);
    void submitFrame(const QVideoFrame& frame); // Injected source only; same bounded encoder path.
signals:
    void devicesReady(const QList<QCameraDevice>& devices);
    void roomChanged(bool ready);
    void publishingChanged(bool active);
    void image(const QString& id, const QImage& image);
    void removed(const QString& id);
    void message(const QString& text);
private:
    void queue(const QVideoFrame& frame);
    QThread thread_;
    CameraPublishWorker* worker_;
    std::unique_ptr<CameraService> capture_;
    std::shared_ptr<CameraFrames> frames_ = std::make_shared<CameraFrames>();
    std::shared_ptr<ScreenFrameMailbox> render_ = std::make_shared<ScreenFrameMailbox>();
    std::shared_ptr<std::atomic<quint64>> wanted_ = std::make_shared<std::atomic<quint64>>(0);
    std::shared_ptr<std::atomic<quint64>> source_ = std::make_shared<std::atomic<quint64>>(0);
    quint64 next_ = 0;
    ScreenCall::SourceMode mode_;
};
}
