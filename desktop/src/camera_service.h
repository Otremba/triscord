#pragma once
#include "camera_capture.h"
#include <QThread>
#include <atomic>
namespace triscord {
class CameraWorker final : public QObject {
    Q_OBJECT
public:
    explicit CameraWorker(std::shared_ptr<std::atomic<quint64>> wanted);
    void requestDevices(quint64 request);
    void start(const QByteArray& id, quint64 generation, QSize size, int fps);
    void stop(quint64 generation);
signals:
    void devicesReady(quint64 request, const QList<QCameraDevice>& devices);
    void frameReady(quint64 generation, const QVideoFrame& frame);
    void activeChanged(quint64 generation, bool active);
    void message(quint64 generation, const QString& text);
private:
    std::shared_ptr<std::atomic<quint64>> wanted_;
    std::unique_ptr<CameraCapture> capture_;
    quint64 generation_ = 0;
};
// UI-facing facade. Device enumeration and capture objects live on the worker.
// The worker/thread are created lazily, and only one UI frame notification is queued.
class CameraService final : public QObject {
    Q_OBJECT
public:
    explicit CameraService(QObject* parent = nullptr);
    ~CameraService() override;
    void requestDevices();
    quint64 start(const QByteArray& id = {}, QSize size = {1280, 720}, int fps = 30);
    void stop();
    bool isActive() const { return active_; }
signals:
    void devicesReady(const QList<QCameraDevice>& devices);
    void frameReady(const QVideoFrame& frame);
    void mediaFrameReady(quint64 generation, const QVideoFrame& frame); // Producer thread; use a bounded consumer.
    void activeChanged(bool active);
    void message(const QString& text);
private:
    void ensureWorker();
    void setActive(bool active);
    QThread thread_;
    CameraWorker* worker_ = nullptr;
    std::shared_ptr<CameraFrames> frames_ = std::make_shared<CameraFrames>();
    std::shared_ptr<std::atomic<quint64>> wanted_ = std::make_shared<std::atomic<quint64>>(0);
    quint64 generation_ = 0, devicesRequest_ = 0;
    bool active_ = false;
};
}
