#pragma once
#include "screen_call.h"
#include <QThread>
#include <QMutex>

namespace triscord {
class ScreenFrameMailbox final {
public:
    struct Frame { QString id; quint64 generation; QImage image; };
    void select(const QString& id, quint64 generation) { QMutexLocker lock(&mutex_); live_[id] = generation; frames_.erase(id); }
    void remove(const QString& id) { QMutexLocker lock(&mutex_); live_.erase(id); frames_.erase(id); }
    bool publish(Frame frame) {
        QMutexLocker lock(&mutex_);
        auto found = live_.find(frame.id);
        if (found == live_.end() || found->second != frame.generation) return false;
        frames_[frame.id] = std::move(frame);
        if (scheduled_) return false;
        scheduled_ = true; return true;
    }
    std::vector<Frame> take() {
        QMutexLocker lock(&mutex_); scheduled_ = false;
        std::vector<Frame> result;
        for (auto& [id, frame] : frames_) { (void)id; result.push_back(std::move(frame)); }
        frames_.clear(); return result;
    }
private:
    QMutex mutex_;
    bool scheduled_ = false;
    std::map<QString, quint64> live_;
    std::map<QString, Frame> frames_;
};
class ScreenService final : public QObject {
    Q_OBJECT
public:
    ScreenService(Signaling* signaling, QObject* parent = nullptr, ScreenCall::SourceMode mode = ScreenCall::SourceMode::Native, VideoConfig config = {}, ScreenCall::MediaKind media = ScreenCall::MediaKind::Screen);
    ~ScreenService() override;
    void start(const CaptureSource& source, bool shareAudio = false);
    void start(const CaptureSource& source, bool shareAudio, VideoConfig config);
    void setAudioOutput(const QByteArray& device);
    void setOutputGain(float gain);
    void setDeafened(bool deafened);
    void setDucking(bool active, float amount = 0.5f);
    void setStreamVolume(const QString& id, float volume);
    void setStreamMuted(const QString& id, bool muted);
    void stop();
    void leave();
    void setFocus(const QString& id);
    void setVideoDisabled(const QString& id, bool disabled);
    void startInjected();
    void startExternal();
    void startExternal(VideoConfig config);
    void sendFrame(const EncodedVideo& frame);
    void sendAudio(const QByteArray& opus);
    void requestThumbnails(const QVector<CaptureSource>& sources, quint64 generation);
    void cancelThumbnails();
signals:
    void roomChanged(bool ready);
    void sharingChanged(bool active);
    void streamsChanged(const QJsonArray& streams);
    void frameReady(const QString& id, const QImage& image);
    void frameRemoved(const QString& id);
    void message(const QString& message);
    void thumbnailReady(quint64 generation, int index, const QImage& image);
    void screenAudio(const QString& peer, const VoiceFrame& frame);
    void keyframeRequested();
    void bitrateRequested(int bitrate);
private:
    QThread thread_;
    ScreenCall* call_;
    std::shared_ptr<ScreenFrameMailbox> mailbox_;
};
}
