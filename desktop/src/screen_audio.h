#pragma once
#include "system_audio.h"
#include "voice_jitter.h"
#include "voice_processing.h"
#include <QAudioSink>
#include <QElapsedTimer>
#include <QSet>
#include <map>
namespace triscord {
class ScreenAudio final : public QObject {
    Q_OBJECT
public:
    explicit ScreenAudio(QObject* parent = nullptr);
    bool startCapture() { return capture_.start(); }
    void stopCapture() { capture_.stop(); }
    void clear();
    void remove(const QString& peer);
    void receive(const QString& peer, const QByteArray& packet, uint32_t timestamp);
    void setPeerVolume(const QString& peer, float volume);
    void setPeerMuted(const QString& peer, bool muted);
    void forgetPeer(const QString& peer) { remove(peer); volumes_.erase(peer); muted_.remove(peer); }
    void setOutput(const QByteArray& device);
    void setDeafened(bool deafened);
    void setPlaybackEnabled(bool enabled) { playback_ = enabled; }
    void setDucking(bool active, float amount = 0.5f) { ducking_ = active; duckAmount_ = std::clamp(amount, 0.0f, 0.95f); }
    // The speaker volume ("Volume do Alto-falante") applies to streams too, as to voices (18/10: it did not).
    void setOutputGain(float gain) { outputGain_ = std::isfinite(gain) ? std::clamp(gain, 0.f, 2.f) : 1.f; }
signals:
    void captured(const QByteArray& opus);
    void decoded(const QString& peer, const VoiceFrame& frame);
    void error(const QString& message);
private:
    bool openOutput();
    void closeOutput();
    void failOutput(const QString& message);
    void tick();
    SystemAudio capture_{this};
    std::map<QString, std::unique_ptr<VoiceJitter>> peers_;
    std::map<QString, float> volumes_;
    QSet<QString> muted_;
    QTimer timer_;
    std::unique_ptr<QAudioSink> sink_;
    std::unique_ptr<VoiceResampler> resampler_;
    QIODevice* writer_ = nullptr;
    QAudioFormat format_;
    QByteArray output_, pending_;
    bool deafened_ = false;
    bool playback_ = true;
    bool ducking_ = false;
    float duckAmount_ = 0.5f;
    float outputGain_ = 1.f;
    bool outputFailed_ = false;
    bool outputFailureNotified_ = false;
    QElapsedTimer outputRetry_;
};
}
