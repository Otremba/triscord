#include "voice_service.h"

namespace triscord {
VoiceService::VoiceService(Signaling* signaling, QObject* parent, VoiceCall::AudioMode mode)
    : QObject(parent), call_(new VoiceCall(signaling, nullptr, mode)) {
    qRegisterMetaType<VoiceFrame>();
    call_->moveToThread(&thread_);
    connect(call_, &VoiceCall::message, this, &VoiceService::message);
    connect(call_, &VoiceCall::speakingChanged, this, &VoiceService::speakingChanged);
    connect(call_, &VoiceCall::speakingWhileMuted, this, &VoiceService::speakingWhileMuted);
    connect(call_, &VoiceCall::activeChanged, this, &VoiceService::activeChanged);
    connect(call_, &VoiceCall::devicesChanged, this, &VoiceService::devicesChanged);
    // Production does not copy PCM to the UI. Only synthetic test clients do.
    if (mode == VoiceCall::AudioMode::Injected)
        connect(call_, &VoiceCall::remoteAudio, this, &VoiceService::remoteAudio);
    connect(&thread_, &QThread::finished, call_, &QObject::deleteLater);
    thread_.setObjectName("TriscordMedia");
    thread_.start(QThread::HighestPriority);   // playback and jitter ticks must not wait behind a game's threads
}
VoiceService::~VoiceService() {
    QMetaObject::invokeMethod(call_, &VoiceCall::leave, Qt::BlockingQueuedConnection);
    thread_.quit();
    thread_.wait();
}
void VoiceService::setMuted(bool muted) {
    QMetaObject::invokeMethod(call_, [call = call_, muted] { call->setMuted(muted); });
}
void VoiceService::setDeafened(bool deafened) {
    QMetaObject::invokeMethod(call_, [call = call_, deafened] { call->setDeafened(deafened); });
}
void VoiceService::setDevices(const QByteArray& input, const QByteArray& output) {
    QMetaObject::invokeMethod(call_, [call = call_, input, output] { call->setDevices(input, output); });
}
void VoiceService::leave() { QMetaObject::invokeMethod(call_, &VoiceCall::leave); }
void VoiceService::setProcessing(bool noise, bool echo, bool agc, bool highQuality, int strength) {
    QMetaObject::invokeMethod(call_, [call = call_, noise, echo, agc, highQuality, strength] { call->setProcessing(noise, echo, agc, highQuality, strength); });
}
void VoiceService::setPeerVolume(const QString& peer, float volume) {
    QMetaObject::invokeMethod(call_, [call = call_, peer, volume] { call->setPeerVolume(peer, volume); });
}
void VoiceService::setPeerPan(const QString& peer, float pan) {
    QMetaObject::invokeMethod(call_, [call = call_, peer, pan] { call->setPeerPan(peer, pan); });
}
void VoiceService::setPeerMuted(const QString& peer, bool muted) {
    QMetaObject::invokeMethod(call_, [call = call_, peer, muted] { call->setPeerMuted(peer, muted); });
}
void VoiceService::setInputGain(float gain) {
    QMetaObject::invokeMethod(call_, [call = call_, gain] { call->setInputGain(gain); });
}
void VoiceService::setOutputGain(float gain) {
    QMetaObject::invokeMethod(call_, [call = call_, gain] { call->setOutputGain(gain); });
}
void VoiceService::sendOpus(const QByteArray& packet) {
    QMetaObject::invokeMethod(call_, [call = call_, packet] { call->sendOpus(packet); });
}
}
