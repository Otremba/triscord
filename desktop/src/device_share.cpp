#include "device_share.h"
#include "screen_service.h"
#include <QSignalBlocker>
namespace triscord {
DeviceShareWorker::DeviceShareWorker(ScreenService* screen) : screen_(screen) {
    drain_.setParent(this);
    connect(&drain_, &QTimer::timeout, this, [this] {
        if (!encoder_) return;
        try { for (const auto& frame : encoder_->poll()) screen_->sendFrame(frame); }
        catch (const std::exception&) { const auto generation = generation_; stop(); emit failed(generation, "a transmissão do dispositivo parou. tente novamente."); }
    });
}
void DeviceShareWorker::start(quint64 generation, VideoConfig config) {
    stop(); generation_ = generation; config_ = config;
    try {
        encoder_ = std::make_unique<CameraEncoder>(config);
        clock_.start(); preview_.invalidate(); lastTime_ = -1;
        drain_.setInterval(std::max(1, 1000 / config.fps)); drain_.start();
    } catch (const std::exception&) { stop(); emit failed(generation, "não foi possível preparar o vídeo do dispositivo. confira o driver de vídeo."); }
}
void DeviceShareWorker::stop() { drain_.stop(); encoder_.reset(); }
void DeviceShareWorker::consume(quint64 generation, const QVideoFrame& frame) {
    if (generation != generation_ || !encoder_) return;
    try {
        const auto time = clock_.nsecsElapsed() / 100;
        if (lastTime_ < 0 || time - lastTime_ >= 10000000 / config_.fps) {
            if (encoder_->submit(frame, time)) lastTime_ = time;
        }
        if (!preview_.isValid() || preview_.elapsed() >= 66) {
            preview_.start();
            emit image(generation_, cameraImage(frame).scaled(QSize(1280, 720), Qt::KeepAspectRatio, Qt::FastTransformation));
        }
    } catch (const std::exception&) { const auto current = generation_; stop(); emit failed(current, "não foi possível processar a imagem do dispositivo. escolha outro dispositivo."); }
}

DeviceShare::DeviceShare(ScreenService* screen, QObject* parent)
    : QObject(parent), screen_(screen), worker_(new DeviceShareWorker(screen)), capture_(std::make_unique<CameraService>()) {
    worker_->moveToThread(&thread_);
    connect(&thread_, &QThread::finished, worker_, &QObject::deleteLater);
    connect(capture_.get(), &CameraService::message, this, [this](const QString& text) { stop(); emit message(text); });
    connect(capture_.get(), &CameraService::mediaFrameReady, worker_,
        [worker = worker_, frames = frames_, wanted = wanted_, source = source_](quint64 generation, const QVideoFrame& frame) {
            if (generation != source->load()) return;
            const auto current = wanted->load(); if (!current || !frames->publish(current, frame)) return;
            QMetaObject::invokeMethod(worker, [worker, frames, current] { if (auto latest = frames->take()) worker->consume(current, *latest); }, Qt::QueuedConnection);
        }, Qt::DirectConnection);
    connect(worker_, &DeviceShareWorker::image, this, [this](quint64 generation, const QImage& image) {
        if (generation == wanted_->load()) emit this->image(image);
    });
    connect(worker_, &DeviceShareWorker::failed, this, [this](quint64 generation, const QString& text) {
        if (generation == wanted_->load()) { stop(); emit message(text); }
    });
    connect(screen_, &ScreenService::keyframeRequested, worker_, [worker = worker_] { worker->requestKeyframe(); });
    connect(screen_, &ScreenService::bitrateRequested, worker_, [worker = worker_](int bitrate) { worker->setBitrate(bitrate); });
    thread_.setObjectName("triscordDeviceShare"); thread_.start();
}
DeviceShare::~DeviceShare() {
    QSignalBlocker blocker(this); wanted_->store(0); source_->store(0); frames_->select(++next_);
    capture_.reset();
    QMetaObject::invokeMethod(worker_, &DeviceShareWorker::stop, Qt::BlockingQueuedConnection);
    thread_.quit(); thread_.wait();
}
void DeviceShare::start(const QByteArray& deviceId, VideoConfig config) {
    const auto generation = ++next_; wanted_->store(generation); source_->store(0); frames_->select(generation);
    QMetaObject::invokeMethod(worker_, [worker = worker_, generation, config] { worker->start(generation, config); });
    screen_->startExternal(config);
    source_->store(capture_->start(deviceId, config.size, config.fps));
}
void DeviceShare::stop() {
    if (!wanted_->load()) return;
    wanted_->store(0); source_->store(0); frames_->select(++next_); capture_->stop();
    QMetaObject::invokeMethod(worker_, &DeviceShareWorker::stop);
}
}
