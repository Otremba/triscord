#pragma once
#include "voice_codec.h"
#include "voice_processing.h"
#include "voice_activity.h"
#include <QObject>
#include <QAudioSource>
#include <QAudioSink>
#include <QTimer>
#include <QThread>
#include <QHash>
#include <QMediaDevices>
#include <functional>
#include <QJsonArray>
#include <deque>

namespace triscord {
class VoiceDevices final : public QObject {
    Q_OBJECT
public:
    explicit VoiceDevices(QObject* parent = nullptr);
    ~VoiceDevices() override;
    bool start();
    void stop();
    void setMuted(bool muted);
    void setDeafened(bool deafened);
    void enqueue(const QString& peer, const VoiceFrame& frame);
    void setPeerVolume(const QString& peer, float volume);
    void setPeerPan(const QString& peer, float pan);
    void setPeerMuted(const QString& peer, bool muted);
    void removePeer(const QString& peer);
    void mixNextFrame(VoiceFrame& left, VoiceFrame* right = nullptr);
    void resetPeerAudio(const QString& peer) { queues_.remove(peer); }
    // Called before each frame is mixed for the speaker, so the device's clock paces the jitter buffers (VoiceCall).
    void setFrameSource(std::function<void()> source) { frameSource_ = std::move(source); }
    bool pulling() const { return writer_ && output_ && !deafened_ && frameSource_; }
    void setDevices(const QByteArray& input, const QByteArray& output);
    void setProcessing(bool noise, bool echo, bool agc = true, bool highQuality = false, int strength = 100);
    void setInputGain(float gain) {
        gain = std::clamp(gain, 0.f, 1.f);
        // The voice gate compares speech with the talker's level, which is measured after this gain.
        if (gain > 0 && inputGain_ > 0) {
            const float db = 20.f * std::log10(gain / inputGain_);
            QMetaObject::invokeMethod(processingWorker_, [this, db] { processing_->processor.inputGainChanged(db); });
        }
        inputGain_ = gain;
    }
    void setOutputGain(float gain) { outputGain_ = std::clamp(gain, 0.f, 2.f); }
    float inputGain() const { return inputGain_; }
    float outputGain() const { return outputGain_; }
signals:
    void speakingChanged(bool speaking);
    void speakingWhileMuted();
    void captured(const QByteArray& opus);
    void error(const QString& message);
    void devicesChanged(const QJsonArray& inputs, const QJsonArray& outputs);
    void runningChanged(bool running);
private:
    void closeHardware();
    void publishDevices();
    void refreshDevices();
    void deviceError(uint64_t generation);
    void readMicrophone();
    void playMixedFrame();
    bool flushPlayback();
    void resetProcessing();
    void processMicrophone(const VoiceFrame& frame, const VoiceFrame& reference);
    struct Processing { VoiceEncoder encoder; VoiceProcessor processor; };
    QThread processingThread_;
    QObject* processingWorker_ = nullptr;
    std::unique_ptr<Processing> processing_;
    quint64 processingGeneration_ = 0;
    int processingPending_ = 0;
    VoiceActivity activity_;
    std::unique_ptr<VoiceResampler> inputResampler_, outputResampler_, rightResampler_;
    std::deque<float> microphoneSamples_;
    std::deque<VoiceFrame> played_;
    QByteArray pendingPlayback_;
    std::function<void()> frameSource_;
    VoiceFrame pendingReference_{};
    std::unique_ptr<QAudioSource> input_;
    std::unique_ptr<QAudioSink> output_;
    QIODevice* reader_ = nullptr;
    QIODevice* writer_ = nullptr;
    QAudioFormat inputFormat_;
    QAudioFormat outputFormat_;
    QByteArray captureBuffer_;
    QHash<QString, std::deque<VoiceFrame>> queues_;
    QHash<QString, float> peerVolumes_;
    QHash<QString, float> peerPan_;
    QSet<QString> peerMuted_;
    QTimer playback_;
    QTimer refresh_;
    QMediaDevices mediaDevices_;
    QByteArray selectedInput_, selectedOutput_, openedInput_, openedOutput_;
    uint64_t deviceGeneration_ = 0;
    bool desired_ = false;
    bool running_ = false;
    bool closing_ = false;
    bool muted_ = true;
    bool deafened_ = false;
    float inputGain_ = 1.0f;
    float outputGain_ = 1.0f;
};
}
