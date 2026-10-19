#include "screen_service.h"
#include "com_apartment.h"

namespace triscord {
ScreenService::ScreenService(Signaling* signaling, QObject* parent, ScreenCall::SourceMode mode, VideoConfig config, ScreenCall::MediaKind media)
    : QObject(parent), call_(new ScreenCall(signaling, mode, config, nullptr, media)), mailbox_(std::make_shared<ScreenFrameMailbox>()) {
    call_->moveToThread(&thread_);
    connect(call_, &ScreenCall::roomChanged, this, &ScreenService::roomChanged);
    connect(call_, &ScreenCall::sharingChanged, this, &ScreenService::sharingChanged);
    connect(call_, &ScreenCall::streamsChanged, this, &ScreenService::streamsChanged);
    connect(call_, &ScreenCall::message, this, &ScreenService::message);
    connect(call_, &ScreenCall::thumbnailReady, this, &ScreenService::thumbnailReady);
    connect(call_, &ScreenCall::keyframeRequested, this, &ScreenService::keyframeRequested);
    connect(call_, &ScreenCall::bitrateRequested, this, &ScreenService::bitrateRequested);
    if (mode == ScreenCall::SourceMode::Injected) connect(call_, &ScreenCall::screenAudio, this, &ScreenService::screenAudio);
    connect(call_, &ScreenCall::generationChanged, call_, [mailbox = mailbox_](const QString& id, quint64 generation) { mailbox->select(id, generation); });
    connect(call_, &ScreenCall::generationRemoved, call_, [mailbox = mailbox_](const QString& id) { mailbox->remove(id); });
    connect(call_, &ScreenCall::generationRemoved, this, &ScreenService::frameRemoved);
    connect(call_, &ScreenCall::frame, call_, [this, mailbox = mailbox_](const QString& id, quint64 generation, const QImage& image) {
        if (!mailbox->publish({id, generation, image})) return;
        QMetaObject::invokeMethod(this, [this, mailbox] {
            for (const auto& frame : mailbox->take()) emit frameReady(frame.id, frame.image);
        }, Qt::QueuedConnection);
    });
    connect(&thread_, &QThread::finished, call_, &QObject::deleteLater);
    joinMultithreadedApartment(thread_);
    thread_.setObjectName("TriscordScreenMedia"); thread_.start();
}
ScreenService::~ScreenService() {
    QMetaObject::invokeMethod(call_, &ScreenCall::leave, Qt::BlockingQueuedConnection);
    thread_.quit(); thread_.wait();
}
void ScreenService::start(const CaptureSource& source, bool shareAudio, VideoConfig config) { QMetaObject::invokeMethod(call_, [call = call_, source, shareAudio, config] { call->start(source, shareAudio, config); }); }
void ScreenService::start(const CaptureSource& source, bool shareAudio) { QMetaObject::invokeMethod(call_, [call = call_, source, shareAudio] { call->start(source, shareAudio); }); }
void ScreenService::setAudioOutput(const QByteArray& device) { QMetaObject::invokeMethod(call_, [call = call_, device] { call->setAudioOutput(device); }); }
void ScreenService::setOutputGain(float gain) { QMetaObject::invokeMethod(call_, [call = call_, gain] { call->setOutputGain(gain); }); }
void ScreenService::setDeafened(bool deafened) { QMetaObject::invokeMethod(call_, [call = call_, deafened] { call->setDeafened(deafened); }); }
void ScreenService::setDucking(bool active, float amount) {
    QMetaObject::invokeMethod(call_, [call = call_, active, amount] { call->setDucking(active, amount); });
}
void ScreenService::stop() { QMetaObject::invokeMethod(call_, [call = call_] { call->stop(); }); }
void ScreenService::leave() { QMetaObject::invokeMethod(call_, &ScreenCall::leave); }
void ScreenService::setFocus(const QString& id) { QMetaObject::invokeMethod(call_, [call = call_, id] { call->setFocus(id); }); }
void ScreenService::setVideoDisabled(const QString& id, bool disabled) { QMetaObject::invokeMethod(call_, [call = call_, id, disabled] { call->setVideoDisabled(id, disabled); }); }
void ScreenService::setStreamVolume(const QString& id, float volume) { QMetaObject::invokeMethod(call_, [call = call_, id, volume] { call->setStreamVolume(id, volume); }); }
void ScreenService::setStreamMuted(const QString& id, bool muted) { QMetaObject::invokeMethod(call_, [call = call_, id, muted] { call->setStreamMuted(id, muted); }); }
void ScreenService::startInjected() { QMetaObject::invokeMethod(call_, &ScreenCall::startInjected); }
void ScreenService::startExternal() { QMetaObject::invokeMethod(call_, [call = call_] { call->startExternal(); }); }
void ScreenService::startExternal(VideoConfig config) { QMetaObject::invokeMethod(call_, [call = call_, config] { call->startExternal(config); }); }
void ScreenService::requestThumbnails(const QVector<CaptureSource>& sources, quint64 generation) {
    QMetaObject::invokeMethod(call_, [call = call_, sources, generation] { call->requestThumbnails(sources, generation); });
}
void ScreenService::cancelThumbnails() { QMetaObject::invokeMethod(call_, &ScreenCall::cancelThumbnails); }
void ScreenService::sendFrame(const EncodedVideo& frame) { QMetaObject::invokeMethod(call_, [call = call_, frame] { call->sendFrame(frame); }); }
void ScreenService::sendAudio(const QByteArray& opus) { QMetaObject::invokeMethod(call_, [call = call_, opus] { call->sendAudio(opus); }); }
}
