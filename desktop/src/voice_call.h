#pragma once
#include "signaling.h"
#include "sfu_transport.h"
#include "voice_codec.h"
#include "voice_activity.h"
#include "voice_processing.h"
#include "voice_devices.h"
#include "voice_peer.h"
#include "voice_jitter.h"
#include <QElapsedTimer>
#include <map>

namespace triscord {
class VoiceCall final : public QObject {
    Q_OBJECT
public:
    enum class AudioMode { Devices, Injected };
    VoiceCall(Signaling* signaling, QObject* parent = nullptr, AudioMode mode = AudioMode::Devices);
    ~VoiceCall() override;
    void setMuted(bool muted);
    void setDeafened(bool deafened);
    void leave();
    bool active() const { return !room_.isEmpty(); }
    void setDevices(const QByteArray& input, const QByteArray& output);
    void setProcessing(bool noise, bool echo, bool agc = true, bool highQuality = false, int strength = 100) { devices_.setProcessing(noise, echo, agc, highQuality, strength); }
    void sendOpus(const QByteArray& packet);
    void setPeerVolume(const QString& peer, float volume) { devices_.setPeerVolume(peer, volume); }
    void setPeerMuted(const QString& peer, bool muted) { devices_.setPeerMuted(peer, muted); }
    void setPeerPan(const QString& peer, float pan) { devices_.setPeerPan(peer, pan); }
    void setInputGain(float gain) { devices_.setInputGain(gain); }
    void setOutputGain(float gain) { devices_.setOutputGain(gain); }
    float inputGain() const { return devices_.inputGain(); }
    float outputGain() const { return devices_.outputGain(); }
signals:
    void speakingChanged(const QString& peer, bool speaking);
    void speakingWhileMuted();
    void outboundEvent(const QString& event, const QJsonObject& payload);
    void activeChanged(bool active);
    void devicesChanged(const QJsonArray& inputs, const QJsonArray& outputs);
    void message(const QString& message);
    void remoteAudio(const QString& peer, const VoiceFrame& frame);
private:
    struct Session {
        std::unique_ptr<VoicePeer> peer;
        VoiceJitter jitter;
        VoiceActivity activity;
        QString localSession;
        QString remoteSession;
        QJsonArray candidates;
        QElapsedTimer age;
        int attempts = 0;
        bool remoteDescription = false;
        bool failureReported = false;
    };
    void event(const QString& name, const QJsonArray& args);
    Session& create(const QString& id, int attempts = 0);
    void addMember(const QString& id);
    void removeMember(const QString& id, bool forgetSettings = true);
    QSet<QString> serverMutedPeers_;
    bool serverMuted_ = false;
    void receiveSignal(const QString& name, const QJsonObject& payload);
    void recover();
    SfuTransport sfu_{"voice", this};
    Signaling* signaling_;
    VoiceDevices devices_;
    rtc::Configuration config_;
    std::vector<rtc::IceServer> pushedIce_;   // from the hub's "ice-servers" event, added to resolveIceServers()
    std::map<QString, std::unique_ptr<Session>> peers_;
    QString self_;
    QString socketIdentity_;
    QString room_;
    QTimer recovery_;
    QTimer playout_;
    void playoutTick();   // one frame from every jitter buffer
    // Test-only synthetic voice (injected mode + TRISCORD_SYNTHETIC_VOICE=1): a quiet talker (-40 dBFS bursts over
    // room noise) sent through the real chain (RNNoise, AGC, Opus); received levels are logged ("voice: heard ...").
    void syntheticTick();
    bool synthetic_ = false, syntheticMuted_ = true;
    int syntheticFrame_ = 0;
    VoiceProcessor syntheticProcessor_;
    VoiceEncoder syntheticEncoder_;
    VoiceActivity syntheticActivity_;
    std::map<QString, std::pair<double, int>> heard_;   // peer -> (speech energy sum, speech frames)
    bool useDevices_;
};
}
