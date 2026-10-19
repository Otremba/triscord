#pragma once
#include <QObject>
#include <QCameraDevice>
#include <QVideoFrame>
#include <QMutex>
#include <QMutexLocker>
#include <QTimer>
#include <QSize>
#include <memory>
#include <optional>
#include <functional>
class QCamera;
class QVideoSink;
class QMediaCaptureSession;
class QMediaDevices;
namespace triscord {
// Retains one native frame; the camera callback never queues images or maps pixels.
class CameraFrames final {
public:
    void select(quint64 generation) { QMutexLocker lock(&mutex_); generation_ = generation; latest_.reset(); }
    bool publish(quint64 generation, const QVideoFrame& frame) {
        QMutexLocker lock(&mutex_);
        if (generation != generation_ || !frame.isValid()) return false;
        latest_ = frame;
        if (scheduled_) return false;
        scheduled_ = true; return true;
    }
    std::optional<QVideoFrame> take() {
        QMutexLocker lock(&mutex_); scheduled_ = false; auto frame = std::move(latest_); latest_.reset(); return frame;
    }
private:
    QMutex mutex_;
    quint64 generation_ = 0;
    bool scheduled_ = false;
    std::optional<QVideoFrame> latest_;
};
class CameraCapture final : public QObject {
    Q_OBJECT
public:
    explicit CameraCapture(QObject* parent = nullptr);
    ~CameraCapture() override;
    static QList<QCameraDevice> devices();
    void start(const QByteArray& deviceId = {}, const std::function<bool()>& wanted = {}, QSize size = {1280, 720}, int fps = 30);
    void stop();
signals:
    void frameReady(const QVideoFrame& frame);
    void activeChanged(bool active);
    void message(const QString& text);
private:
    void fail(const QString& text);
    std::shared_ptr<CameraFrames> frames_ = std::make_shared<CameraFrames>();
    std::unique_ptr<QMediaDevices> devices_;
    std::unique_ptr<QMediaCaptureSession> session_;
    std::unique_ptr<QCamera> camera_;
    std::unique_ptr<QVideoSink> sink_;
    QTimer delivery_, startup_;
    QByteArray selected_;
    quint64 generation_ = 0;
    bool active_ = false;
};
}
