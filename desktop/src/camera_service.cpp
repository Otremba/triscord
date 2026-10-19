#include "camera_service.h"
#include "com_apartment.h"
#include <QSignalBlocker>
namespace triscord {
CameraWorker::CameraWorker(std::shared_ptr<std::atomic<quint64>> wanted) : wanted_(std::move(wanted)) {}
void CameraWorker::requestDevices(quint64 request) { emit devicesReady(request, CameraCapture::devices()); }
void CameraWorker::start(const QByteArray& id, quint64 generation, QSize size, int fps) {
    if (wanted_->load() != generation) return;
    stop(generation);
    capture_ = std::make_unique<CameraCapture>();
    connect(capture_.get(), &CameraCapture::frameReady, this, [this](const QVideoFrame& frame) {
        emit frameReady(generation_, frame);
    });
    connect(capture_.get(), &CameraCapture::activeChanged, this, [this](bool active) {
        emit activeChanged(generation_, active);
    });
    connect(capture_.get(), &CameraCapture::message, this, [this](const QString& text) {
        emit message(generation_, text);
    });
    capture_->start(id, [wanted = wanted_, generation] { return wanted->load() == generation; }, size, fps);
}
void CameraWorker::stop(quint64 generation) {
    if (capture_) { capture_->stop(); capture_.reset(); }
    generation_ = generation;
}
CameraService::CameraService(QObject* parent) : QObject(parent) {
    joinMultithreadedApartment(thread_);
    thread_.setParent(this); thread_.setObjectName("triscordCameraMedia");
    qRegisterMetaType<QList<QCameraDevice>>(); qRegisterMetaType<QVideoFrame>();
}
CameraService::~CameraService() {
    QSignalBlocker blocker(this);
    wanted_->store(++generation_); frames_->select(generation_);
    if (worker_) {
        QMetaObject::invokeMethod(worker_, [worker = worker_, generation = generation_] { worker->stop(generation); }, Qt::BlockingQueuedConnection);
        thread_.quit(); thread_.wait();
    }
}
void CameraService::setActive(bool active) {
    if (active_ == active) return;
    active_ = active; emit activeChanged(active);
}
void CameraService::ensureWorker() {
    if (worker_) return;
    worker_ = new CameraWorker(wanted_); worker_->moveToThread(&thread_);
    connect(&thread_, &QThread::finished, worker_, &QObject::deleteLater);
    connect(worker_, &CameraWorker::devicesReady, this, [this](quint64 request, const QList<QCameraDevice>& devices) {
        if (request == devicesRequest_) emit devicesReady(devices);
    });
    connect(worker_, &CameraWorker::activeChanged, this, [this](quint64 generation, bool active) {
        if (generation == generation_) setActive(active);
    });
    connect(worker_, &CameraWorker::message, this, [this](quint64 generation, const QString& text) {
        if (generation == generation_) { setActive(false); emit message(text); }
    });
    connect(worker_, &CameraWorker::frameReady, worker_, [this, frames = frames_](quint64 generation, const QVideoFrame& frame) {
        if (wanted_->load() == generation) emit mediaFrameReady(generation, frame);
        if (!frames->publish(generation, frame)) return;
        QMetaObject::invokeMethod(this, [this, frames] {
            if (auto latest = frames->take()) emit frameReady(*latest);
        }, Qt::QueuedConnection);
    });
    thread_.start();
}
void CameraService::requestDevices() {
    ensureWorker(); const auto request = ++devicesRequest_;
    QMetaObject::invokeMethod(worker_, [worker = worker_, request] { worker->requestDevices(request); });
}
quint64 CameraService::start(const QByteArray& id, QSize size, int fps) {
    const auto generation = ++generation_; wanted_->store(generation); frames_->select(generation); setActive(false);
    ensureWorker();
    QMetaObject::invokeMethod(worker_, [worker = worker_, id, generation, size, fps] { worker->start(id, generation, size, fps); });
    return generation;
}
void CameraService::stop() {
    const auto generation = ++generation_; wanted_->store(generation); frames_->select(generation); setActive(false);
    if (worker_) QMetaObject::invokeMethod(worker_, [worker = worker_, generation] { worker->stop(generation); });
}
}
