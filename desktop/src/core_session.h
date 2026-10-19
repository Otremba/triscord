#pragma once
#include <functional>
#include <QPointer>
#include <QNetworkReply>
#include "capture_types.h"
#include <QElapsedTimer>
#include <QHash>
#include <QImage>
#include <QJsonArray>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QString>
#include <QTimer>
#include <QNetworkAccessManager>
#include <QVector>
#include <QVideoFrame>

namespace triscord {

class AuthSession;
class CameraPublisher;
class CameraService;
class DeviceShare;
class HubApi;
class ScreenService;
class Signaling;
class VoiceService;
class SoundPlayer;
class NotificationPolicy;
class ProfileMediaClient;

// Media services the session coordinates (any may be null).
struct CoreMedia {
    ScreenService* screen = nullptr;
    CameraPublisher* camera = nullptr;
    bool syntheticCamera = false;   // tests/e2e: frames generated here instead of a physical camera
};

// Session state for the web interface (desktop/web/src/protocol.ts, desktop/ARQUITETURA_WEBVIEW2.md).
// Built from the existing core services; it does not own media: VoiceService, CameraPublisher and
// ScreenService react to the signaling events by themselves, exactly as with the Qt Widgets client.
//
// Core -> UI: snapshotMessage(), the delta() signal (patch from `base` to `revision`) and event()
//             (ephemeral thumbnails: share picker and a leased local camera preview). Video frames never enter the JSON state:
//             videoFrame()/videoRemoved() feed the native overlays (path A).
// UI -> core: handleMessage() validates the untrusted JSON (allowed command names, field types, no extra
//             fields, ids that exist in the current state, bounded strings) before doing anything.
class CoreSession final : public QObject {
    Q_OBJECT
public:
    using Media = CoreMedia;
    // The host reports whether its window is the active one.
    void setWindowActive(bool active);
    CoreSession(Signaling* signaling, VoiceService* voice, AuthSession* auth, HubApi* hub,
                QString hubUrl, QString groupInvite, Media media = {}, QObject* parent = nullptr);

    void start();
    void setCallFullscreenState(bool fullscreen);
    // Janela destacada (Discord "Nova Janela", ARQUITETURA_WEBVIEW2.md Fase 10): the host closed the call popout window
    // itself (its close button, the main window closing); same effect as "Voltar para o Discord".
    void closeCallPopout();
    void closeCameraPreview() { stopCameraPreview(); } // host window close / renderer restart
    // The popout window entered/left fullscreen ("Tela cheia" inside the janela destacada); kept apart from
    // callFullscreen, which is the main window's.
    void setCallPopoutFullscreenState(bool fullscreen);
    QJsonObject snapshotMessage() const;
    QJsonObject handleMessage(const QJsonObject& message);
    const QJsonObject& session() const { return session_; }
    int revision() const { return revision_; }
    QString validateCommand(const QJsonObject& command) const;

signals:
    void delta(const QJsonObject& message);
    void event(const QJsonObject& message);
    void windowAction(const QString& action);
    // "Minimizar para a bandeja" / "Abrir minimizado" changed: the host shows or removes its tray icon.
    void windowSettingsChanged();
    void notice(const QString& text);
    void soundDecoded(const QString& kind, const QString& id, qint64 samples, double peak);
    void copyText(const QString& text);   // the host puts it on the native clipboard
    // A notification for the host: `toast` = Windows notification, `flash` = taskbar alert (user settings).
    void notify(const QString& title, const QString& body, bool toast, bool flash);
    void videoFrame(const QString& streamId, const QImage& image);
    void videoRemoved(const QString& streamId);
    void videoLabel(const QString& streamId, const QString& label);
    // Screen shares carry the "AO VIVO" badge; fps is known only for our own share (0 = unknown).
    void videoLive(const QString& streamId, bool live, int fps, int height);   // height 0 = the frames' own
    // Late answer to a command handleMessage() deferred (sign-in steps, server creation, invites).
    void reply(const QJsonObject& result);
    void videoSurface(const QString& streamId, const QRect& rect, double scale);
    // Page layers floating over the native video (an open menu), CSS px of the page that sent them.
    void videoOccluders(const QVector<QRect>& rects);
    void videoStageOccluders(const QVector<QRect>& rects);   // cut out of the focused card's window only
    void videoRole(const QString& streamId, const QString& role);   // grid | stage | film (visão ampliada)
    // The call view went idle (Discord hides names, zoom and the filmstrip toggle after 2s without activity).
    void videoIdle(bool idle);
    // The call popout window must open/close, or change its "Mostrar sempre" (always on top) state.
    void callPopout(bool open, bool onTop);

private:
    void patch(const QJsonObject& changes);
    void connectSignaling();
    void refreshServers();
    void onEvent(const QString& event, const QJsonArray& args);
    void publishCategories();
    bool canControlPeer(const QString& socketId) const;
    // Moderation (hub: the room owner may force-mute and kick; cloudflare/src/worker.js). True when we are the owner
    // of the room we are in, and `socketId` (may be ourselves) is in it.
    bool canModerate(const QString& socketId) const;
    // Local listening settings per participant: voice, and the audio of their screen share ("Volume da transmissão",
    // "Silenciar transmissão"; applied again when their stream starts, since ScreenService knows only live members).
    struct PeerAudio { int volume = 100; int pan = 0; bool muted = false; int streamVolume = 100; bool streamMuted = false; };
    void applyStreamAudio(const QString& socketId);
    QString peerAudioSettingsKey(const QString& socketId) const;
    void restorePeerAudio(const QString& socketId);
    void savePeerAudio(const QString& socketId);
    QHash<QString, PeerAudio> peerAudio_;
    void publishStreams();
    void setCallPopout(bool open, bool onTop = false);
    void addStreamFrame(const QString& streamId, const QString& ownerId, const QString& kind, const QImage& image);
    void removeStream(const QString& streamId);
    void leaveVoice();
    void publishChat();
    void publishSettings();
    void applyAudioSettings();
    QString hubUserId() const;
    QString displayNameOf(const QString& socketId) const;
    QJsonObject accountJson() const;
    QJsonObject userData() const;
    bool hasServer(const QString& id) const;
    bool hasChannel(const QString& id) const;
    void joinVoice(const QString& channelId);
    void startSignedIn();
    void startCameraIfReady();
    void clearCameraIntent();
    void startCameraPreview(const QString& id);
    void stopCameraPreview(const QString& reason = {});
    CameraService* previewCapture_ = nullptr;
    QTimer previewTimer_, previewLease_;
    QString previewId_;
    QImage previewImage_;
    QVideoFrame previewFrame_;
    bool previewUsesPublished_ = false;
    int previewTick_ = 0;
    bool cameraReady_ = false, cameraWanted_ = false, cameraStarting_ = false;
    QTimer cameraStartDeadline_;
    void loadOwnProfile(const QString& requestId = {});
    void refreshIce();   // TURN relays from the hub's GET /ice (as MainWindow::refreshIce in the Qt client)
    void applyOwnProfile(const QJsonObject& account);
    void publishOwnProfile();
    QJsonObject participant(const QString& socketId) const;
    void loadParticipantProfile(const QString& socketId, const QString& requestId);
    void clearParticipantProfile();
    void updateParticipantImage(const QString& url);
    // Avatars of the people listed, loaded without opening their profile (18/10: a friend only saw the GIF after a
    // click): the public profile gives the avatar url, the lists get its first frame, the call card the GIF itself.
    void prefetchAvatar(const QString& account);
    void publishAvatars();   // "avatars": account -> {still, animated}; patched only when an image changes
    void applyPrefetchedAvatar(const QString& url);
    static QString firstFramePng(const QByteArray& bytes);
    static QString animatedGif(const QByteArray& bytes);
    QJsonObject participantProfile_;
    QString participantSocket_, participantAccount_, participantAvatarSource_, participantBannerSource_;
    QHash<QString, QString> participantAvatars_;
    QHash<QString, QString> participantAnimated_;   // account -> animated GIF data url (call cards)
    QHash<QString, QString> avatarPrefetch_;        // avatar url -> account, while downloading
    QSet<QString> avatarRequested_;                  // accounts whose profile was already asked this session
    quint64 participantGeneration_ = 0;
    QPointer<QNetworkReply> participantReply_;
    QJsonObject ownProfileJson() const;
    void setAuthState(const QString& state, const QString& error = {}, const QString& suggestion = {});
    QJsonObject ok(const QString& requestId, const QJsonValue& value = QJsonValue::Undefined) const;
    QNetworkAccessManager network_;
    SoundPlayer* sounds_ = nullptr;
    NotificationPolicy* notifications_ = nullptr;
    bool background_ = false;   // the window is not the active one (notifications only then)
    qint64 lastSoundRequest_ = 0;
    qint64 lastChatSend_ = 0;
    quint64 serverListIssued_ = 0, serverListApplied_ = 0;   // GET /servers answers apply in order (refreshServers)
    bool switchingServer_ = false;   // our own connectSignaling() drops the connection: no server list refresh then
    bool leavingVoice_ = false;
    QTimer soundAckDeadline_;
    QTimer iceRefresh_;
    QString pendingSoundRequest_, pendingSoundId_;
    void finishSoundRequest(const QString& failure = {});
    ProfileMediaClient* profileMedia_ = nullptr;
    QJsonObject ownProfile_;
    QString avatarData_, bannerData_, accountAvatarData_, avatarSource_, bannerSource_;
    struct Upload { QString id, kind; int size = 0; QByteArray bytes; } upload_;
    QTimer uploadDeadline_;
    bool profileMediaBusy_ = false;
    QJsonObject error(const QString& requestId, const QString& code, const QString& message) const;

    Signaling* signaling_;
    VoiceService* voice_;
    AuthSession* auth_;
    HubApi* hub_;
    Media media_;
    QString hubUrl_, groupInvite_, userId_;
    QJsonObject session_;
    QJsonArray rooms_;                 // last rooms-update, raw
    QJsonArray inputDevices_, outputDevices_, cameraDevices_;   // [{id (hex), name}] for the settings page
    QJsonArray chat_;                  // messages of the room we are in, raw hub objects (oldest first, <= 200)
    QSet<QString> speaking_;
    QSet<QString> invites_;   // codes created in this session: the only text copyInvite may copy
    struct Stream { QString ownerId, kind; QSize size; bool hasFrame = false; };
    QHash<QString, Stream> streams_;
    QSet<QString> hiddenStreams_;
    QVector<CaptureSource> shareSources_;
    quint64 thumbnailGeneration_ = 0;
    QTimer syntheticCamera_;
    DeviceShare* deviceShare_ = nullptr;
    // Viewing another server during a call (Discord keeps the call): signaling_ stays on the call's server
    // (callServerId_) and browse_, a second connection that never joins a room, lists the viewed server's channels.
    Signaling* browse_ = nullptr;
    QJsonArray browseRooms_;
    QHash<QString, int> roomOrder_;   // "<server>/<room>" -> first time seen: the sidebar order stays put (hub map order moves)
    QString callServerId_;
    std::function<void()> afterSwitch_;   // join/create in the viewed server once signaling_ reconnects there
    // A dropped connection (Wi-Fi blip, hub redeploy, heartbeat timeout) takes us out of the room on the hub: the call
    // is joined again on the first directory after reconnecting, as Discord does, if that happens within 60 s.
    struct Rejoin { QString channel, name, server; QElapsedTimer age; } rejoin_;
    bool browsing() const;
    void openBrowse(const QString& serverId);
    void closeBrowse();
    void switchCallServer(std::function<void()> then);   // "Dispositivos" tab: a capture device streamed as the screen share
    QString shareSourceName(int index) const;
    int syntheticTick_ = 0;
    int revision_ = 0;
};

} // namespace triscord
