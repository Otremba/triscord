#include "camera_publisher.h"
#include <QSignalBlocker>
namespace triscord {
CameraPublishWorker::CameraPublishWorker(Signaling* signaling, ScreenCall::SourceMode mode)
    : call_(new ScreenCall(signaling, mode, {{1280,720},30,2500000}, this, ScreenCall::MediaKind::Camera)) {
    drain_.setParent(this); drain_.setInterval(33);
    connect(&drain_, &QTimer::timeout, this, [this] {
        if (!encoder_) return;
        try { for (const auto& frame : encoder_->poll()) call_->sendFrame(frame); }
        catch (const std::exception&) { const auto generation = generation_; stop(); emit message(generation, "a transmissão da câmera parou. tente ligá-la novamente."); }
    });
    connect(call_, &ScreenCall::roomChanged, this, [this](bool ready) {
        ready_ = ready;
        if (!ready) stop(); else call_->setFocus(focus_.isEmpty() ? "$camera-grid" : focus_);
        emit roomChanged(ready);
    });
    call_->setFocus("$camera-grid");
    connect(call_, &ScreenCall::frame, this, &CameraPublishWorker::image);
    connect(call_, &ScreenCall::generationChanged, this, &CameraPublishWorker::selected);
    connect(call_, &ScreenCall::generationRemoved, this, &CameraPublishWorker::removed);
    connect(call_, &ScreenCall::message, this, [this](const QString& text) { emit message(generation_, text); });
    connect(call_, &ScreenCall::keyframeRequested, this, [this] { if (encoder_) encoder_->requestKeyframe(); });
    connect(call_, &ScreenCall::bitrateRequested, this, [this](int bitrate) {
        try { if (encoder_) encoder_->setBitrate(bitrate); }
        catch (const std::exception&) { emit message(generation_, "não foi possível ajustar a qualidade da câmera."); }
    });
}
void CameraPublishWorker::start(quint64 generation) {
    stop(); generation_ = generation;
    if (!ready_) { emit message(generation, "entre em uma sala para ligar a câmera"); return; }
    try {
        encoder_ = std::make_unique<CameraEncoder>(VideoConfig{{1280,720},30,2500000});
        clock_.start(); preview_.invalidate(); lastTime_ = -1;
        call_->startExternal();
        emit selected("$local", generation_);
        drain_.start(); emit publishingChanged(generation_, true);
    } catch (const std::exception&) { stop(); emit message(generation, "não foi possível preparar o vídeo da câmera. confira o driver de vídeo."); }
}
void CameraPublishWorker::stop() {
    drain_.stop(); encoder_.reset(); call_->stop();
    emit removed("$local"); emit publishingChanged(generation_, false);
}
void CameraPublishWorker::leave() { stop(); call_->leave(); }
void CameraPublishWorker::setFocus(const QString& id) {
    focus_ = id; call_->setFocus(id.isEmpty() ? "$camera-grid" : id); preview_.invalidate();
}
void CameraPublishWorker::consume(quint64 generation, const QVideoFrame& frame) {
    if (generation != generation_ || !encoder_ || !ready_) return;
    try {
        const auto time = clock_.nsecsElapsed() / 100;
        if (lastTime_ < 0 || time - lastTime_ >= 10000000 / 30) {
            if (encoder_->submit(frame, time)) lastTime_ = time;
        }
        const bool focused = focus_ == "$local";
        if (!preview_.isValid() || preview_.elapsed() >= (focused ? 33 : 200)) {
            auto image = cameraImage(frame).scaled(focused ? QSize(1280,720) : QSize(640,360), Qt::KeepAspectRatio, Qt::FastTransformation);
            if (frame.mirrored()) image = image.mirrored(true, false);
            preview_.start(); emit this->image("$local", generation_, image);
        }
    } catch (const std::exception&) { const auto current = generation_; stop(); emit message(current, "não foi possível processar a imagem da câmera. escolha outra configuração do dispositivo."); }
}
CameraPublisher::CameraPublisher(Signaling* signaling, QObject* parent, ScreenCall::SourceMode mode)
    : QObject(parent), worker_(new CameraPublishWorker(signaling, mode)), capture_(std::make_unique<CameraService>()), mode_(mode) {
    worker_->moveToThread(&thread_);
    connect(&thread_, &QThread::finished, worker_, &QObject::deleteLater);
    connect(capture_.get(), &CameraService::devicesReady, this, &CameraPublisher::devicesReady);
    connect(capture_.get(), &CameraService::message, this, [this](const QString& text) { stop(); emit message(text); });
    connect(capture_.get(), &CameraService::mediaFrameReady, worker_,
        [worker = worker_, frames = frames_, wanted = wanted_, source = source_](quint64 generation, const QVideoFrame& frame) {
            if (generation != source->load()) return;
            const auto current = wanted->load(); if (!current || !frames->publish(current, frame)) return;
            QMetaObject::invokeMethod(worker, [worker, frames, current] { if (auto latest = frames->take()) worker->consume(current, *latest); }, Qt::QueuedConnection);
        }, Qt::DirectConnection);
    connect(worker_, &CameraPublishWorker::roomChanged, this, [this](bool ready) { if (!ready) stop(); emit roomChanged(ready); });
    connect(worker_, &CameraPublishWorker::publishingChanged, this, [this](quint64 generation, bool active) {
        if (generation == wanted_->load()) emit publishingChanged(active);
    });
    connect(worker_, &CameraPublishWorker::message, this, [this](quint64 generation, const QString& text) {
        if (generation == wanted_->load()) { stop(); emit message(text); }
    });
    connect(worker_, &CameraPublishWorker::selected, worker_, [render = render_](const QString& id, quint64 generation) { render->select(id, generation); });
    connect(worker_, &CameraPublishWorker::removed, worker_, [render = render_](const QString& id) { render->remove(id); });
    connect(worker_, &CameraPublishWorker::image, worker_, [this, render = render_](const QString& id, quint64 generation, const QImage& image) {
        if (!render->publish({id, generation, image})) return;
        QMetaObject::invokeMethod(this, [this, render] { for (const auto& frame : render->take()) emit this->image(frame.id, frame.image); }, Qt::QueuedConnection);
    });
    connect(worker_, &CameraPublishWorker::removed, this, &CameraPublisher::removed);
    thread_.setObjectName("triscordCameraPublisher"); thread_.start();
}
CameraPublisher::~CameraPublisher() {
    QSignalBlocker blocker(this); wanted_->store(0); source_->store(0); frames_->select(++next_);
    capture_.reset();
    QMetaObject::invokeMethod(worker_, &CameraPublishWorker::stop, Qt::BlockingQueuedConnection);
    thread_.quit(); thread_.wait();
}
void CameraPublisher::requestDevices() { capture_->requestDevices(); }
void CameraPublisher::start(const QByteArray& id) {
    const auto generation = ++next_; wanted_->store(generation); source_->store(0); frames_->select(generation);
    QMetaObject::invokeMethod(worker_, [worker = worker_, generation] { worker->start(generation); });
    if (mode_ != ScreenCall::SourceMode::Injected) source_->store(capture_->start(id));
}
void CameraPublisher::stop() {
    wanted_->store(0); source_->store(0); frames_->select(++next_); capture_->stop();
    QMetaObject::invokeMethod(worker_, &CameraPublishWorker::stop); emit publishingChanged(false); emit removed("$local");
}
void CameraPublisher::submitFrame(const QVideoFrame& frame) { if (mode_ == ScreenCall::SourceMode::Injected) queue(frame); }
void CameraPublisher::leave() {
    stop(); setFocus({}); QMetaObject::invokeMethod(worker_, &CameraPublishWorker::leave);
}
void CameraPublisher::setFocus(const QString& id) {
    QMetaObject::invokeMethod(worker_, [worker = worker_, id] { worker->setFocus(id); });
}
void CameraPublisher::queue(const QVideoFrame& frame) {
    const auto generation = wanted_->load(); if (!generation || !frames_->publish(generation, frame)) return;
    QMetaObject::invokeMethod(worker_, [worker = worker_, frames = frames_, generation] { if (auto latest = frames->take()) worker->consume(generation, *latest); });
}
}
