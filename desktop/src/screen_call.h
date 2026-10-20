#pragma once
#include "screen_quality.h"
#include "signaling.h"
#include "screen_encoder.h"
#include "video_peer.h"
#include "capture_thumbnails.h"
#include "screen_audio.h"
#include <QElapsedTimer>
#include <QSet>
#include <map>
namespace triscord {
class ScreenCall final : public QObject {
    Q_OBJECT
public:
    enum class SourceMode { Native, Injected, External };
    enum class MediaKind { Screen, Camera };
    ScreenCall(Signaling* signaling, SourceMode mode = SourceMode::Native, VideoConfig config = {}, QObject* parent = nullptr, MediaKind media = MediaKind::Screen);
    ~ScreenCall() override;
    void start(const CaptureSource& source, bool shareAudio = false) { start(source, shareAudio, config_); }
    void start(const CaptureSource& source, bool shareAudio, VideoConfig config);
    void sendAudio(const QByteArray& opus);
    void setAudioOutput(const QByteArray& device) { audio_.setOutput(device); }
    void setOutputGain(float gain) { audio_.setOutputGain(gain); }
    void setDeafened(bool deafened) { audio_.setDeafened(deafened); }
    void setDucking(bool active, float amount = 0.5f) { audio_.setDucking(active, amount); }
    void setStreamVolume(const QString& id, float volume) { if (members_.contains(id)) audio_.setPeerVolume(id, volume); }
    void setStreamMuted(const QString& id, bool muted) { if (members_.contains(id)) audio_.setPeerMuted(id, muted); }
    void startInjected();
    void startExternal();
    void startExternal(VideoConfig config);
    void sendFrame(const EncodedVideo& frame);
    // Replacing a source must not tell the UI to cancel the newly started producer.
    void stop(bool notify = true);
    void leave();
    void setFocus(const QString& id) { focus_ = id; }
    void setVideoDisabled(const QString& id, bool disabled);
    void requestThumbnails(const QVector<CaptureSource>& sources, quint64 generation) { if (!sharing_) thumbnails_.request(sources, generation); }
    void cancelThumbnails() { thumbnails_.cancel(); }
signals:
    void outboundEvent(const QString& name, const QJsonObject& payload);
    void roomChanged(bool ready);
    void sharingChanged(bool active);
    void streamsChanged(const QJsonArray& streams);
    void generationChanged(const QString& id, quint64 generation);
    void generationRemoved(const QString& id);
    void frame(const QString& id, quint64 generation, const QImage& image);
    void message(const QString& message);
    void thumbnailReady(quint64 generation, int index, const QImage& image);
    void screenAudio(const QString& peer, const VoiceFrame& frame);
    void keyframeRequested(); // External encoder input must answer viewer recovery too.
    void bitrateRequested(int bitrate);
private:
    struct Member { QString name; bool sharing = false; bool watching = true; };
    struct Session {
        std::unique_ptr<VideoPeer> peer;
        std::unique_ptr<VideoDecoder> decoder;
        VideoRtpClock clock;
        VideoConfig remoteConfig;
        QString local, remote;
        QJsonArray candidates;
        QElapsedTimer age, rendered;
        quint64 generation = 0;
        int attempts = 0;
        bool described = false, configured = false;
        bool failureReported = false;
        int decodedFrames = 0;   // since the last stats line (logStats)
        bool firstFrameLogged = false;
    };
    Session& create(const QString& id, int attempts = 0);
    void reconcile(const QString& id, bool rebuild = false);
    void remove(const QString& id);
    void list();
    void event(const QString& name, const QJsonArray& args);
    void signal(const QString& name, const QJsonObject& payload);
    void receive(const QString& id, const QString& generation, const QByteArray& bytes, uint32_t timestamp, bool key);
    void tick();
    void recover();
    void requestLocalKeyframe();
    enum class BitrateSignal { Calm, Congested, KeyframeRequest };
    void adaptBitrate(BitrateSignal signal);
    ScreenBitrateControl bitrate_;
    QElapsedTimer bitrateClock_;
    const char* wireType() const { return media_ == MediaKind::Camera ? "native-camera" : "native-screen"; }
    const char* stateKey() const { return media_ == MediaKind::Camera ? "isCameraOn" : "isScreenSharing"; }
    const char* watchEvent() const { return media_ == MediaKind::Camera ? "camera-watch" : "screen-watch"; }
    Signaling* signaling_;
    SourceMode mode_;
    MediaKind media_;
    VideoConfig config_;
    rtc::Configuration rtcConfig_;
    std::vector<rtc::IceServer> pushedIce_;   // the hub's "ice-servers" push, added to resolveIceServers()
    QString socket_, self_, room_, focus_;
    std::map<QString, Member> members_;
    QSet<QString> disabledVideo_;
    std::map<QString, std::unique_ptr<Session>> peers_;
    std::unique_ptr<ScreenEncoder> encoder_;
    QTimer captureTimer_, recoveryTimer_;
    // Once a minute while sharing or watching: frames sent and shown, for "travando" reports (logStats).
    QElapsedTimer statsClock_;
    int sentFrames_ = 0;
    void logStats();
    const char* kind() const { return media_ == MediaKind::Camera ? "camera" : "screen"; }   // log prefix
    CaptureThumbnails thumbnails_{this};
    ScreenAudio audio_{this};
    quint64 nextGeneration_ = 0, localGeneration_ = 0;
    bool sharing_ = false;
};
}
