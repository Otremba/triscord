#pragma once
#include "video_codec.h"
#include "video_rtp.h"
#include <QObject>
#include <QMutex>
#include <QElapsedTimer>
#include <QMap>
#include <QString>
#include <rtc/rtc.hpp>
#include <deque>

namespace triscord {
// Separate screen media connection; room/session signaling belongs to the
// future call coordinator, not this transport. Must live on a media thread.
class VideoPeer final : public QObject {
    Q_OBJECT
public:
    explicit VideoPeer(const rtc::Configuration& config, QObject* parent = nullptr, bool withAudio = true);
    ~VideoPeer() override;
    void offer();
    void applyDescription(const QString& sdp, const QString& type);
    void addCandidate(const QString& candidate, const QString& mid);
    bool connected() const;
    bool sendVideo(const EncodedVideo& frame);
    bool sendAudio(const QByteArray& opus);
    bool requestKeyframe();
    // Why this side asked the sender for a new keyframe, for the log a user can send: the first time at once, then a
    // summary at most every 10 s ("video: asked the sender for a keyframe: frame backlog x3, ...").
    void noteKeyframeReason(const QString& reason);
signals:
    void localDescription(const QString& sdp, const QString& type);
    void localCandidate(const QString& candidate, const QString& mid);
    void videoReceived(const QByteArray& annexB, uint32_t timestamp, bool keyframe);
    void audioReceived(const QByteArray& opus, uint32_t timestamp);
    void recoveryNeeded(); // Recreate decoder; skip deltas until SPS/PPS + IDR.
    void keyframeRequested(); // Remote PLI/FIR: ask the shared encoder for IDR.
    void connectionChanged(bool connected);
    void failed();
    void congested();
private:
    QString videoMid_;
    struct Dispatch : std::enable_shared_from_this<Dispatch> {
        QMutex mutex;
        VideoPeer* owner = nullptr;
        std::deque<ReceivedVideo> frames;
        std::deque<std::pair<QByteArray, uint32_t>> audio;
        bool audioScheduled = false;
        void audioFrame(QByteArray packet, uint32_t timestamp);
        bool scheduled = false, reset = false, request = false, waiting = false, pliScheduled = false;
        QString reason; // why `request` was set, when it is a cause rather than waiting for the keyframe
        void post(std::function<void(VideoPeer*)> callback);
        void frame(ReceivedVideo value);
        void recover();
        void pli();
        void schedule(); // mutex held
    };
    std::shared_ptr<Dispatch> dispatch_;
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::Track> video_;
    std::shared_ptr<rtc::Track> audio_;
    uint32_t audioTimestamp_ = 0;
    QElapsedTimer lastPli_, lastRemotePli_, keyframeReported_;
    QMap<QString, int> keyframeReasons_;
    qint64 lastSent_ = -1;
    bool sendWaitingForIdr_ = true;
};
}
