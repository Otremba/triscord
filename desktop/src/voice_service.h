#pragma once
#include "voice_call.h"
#include <QThread>

namespace triscord {
// UI proxy: codec, jitter, devices and peer operations live on the media thread.
class VoiceService final : public QObject {
    Q_OBJECT
public:
    VoiceService(Signaling* signaling, QObject* parent = nullptr,
                 VoiceCall::AudioMode mode = VoiceCall::AudioMode::Devices);
    ~VoiceService() override;
    void setMuted(bool muted);
    void setDeafened(bool deafened);
    void setDevices(const QByteArray& input, const QByteArray& output);
    void setProcessing(bool noise, bool echo, bool agc = true, bool highQuality = false, int strength = 100);
    void setPeerVolume(const QString& peer, float volume);
    void setPeerMuted(const QString& peer, bool muted);
    void setPeerPan(const QString& peer, float pan);
    void setInputGain(float gain);
    void setOutputGain(float gain);
    void leave();
    void sendOpus(const QByteArray& packet);
signals:
    void speakingChanged(const QString& peer, bool speaking);
    void speakingWhileMuted();
    void message(const QString& message);
    void activeChanged(bool active);
    void devicesChanged(const QJsonArray& inputs, const QJsonArray& outputs);
    void remoteAudio(const QString& peer, const VoiceFrame& frame);
private:
    QThread thread_;
    VoiceCall* call_;
};
}
