#pragma once
#include "signaling.h"
#include "voice_service.h"
#include "screen_service.h"
#include "camera_publisher.h"
#include "auth_session.h"
#include "hub_api.h"
#include <QMainWindow>
#include <QJsonArray>
#include <QTimer>
#include <QPointer>

class QLineEdit;
class QListWidget;
class QPlainTextEdit;
class QLabel;
class QPushButton;
class QComboBox;
class QStackedWidget;
namespace triscord {
class ChannelComposer;
class ChatPane;
class ParticipantPane;
class Soundboard;
class CallShortcuts;
class DesktopNotifications;
class SplitAudioButton;
class TitleBar;
class VoicePrejoinView;
class NotificationBadge;
class ServerRail;
class ServerRailItem;
class MainWindow final : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr, VoiceCall::AudioMode audioMode = VoiceCall::AudioMode::Devices);
    ~MainWindow() override;
signals:
    // Emitted when the user signs out of their Google account: the app must
    // return to the login screen (see login_window.h / main.cpp).
    void loggedOut();
private:
    void startConnection();
    void showNotice(const QString& message);
    QTimer noticeTimer_;
    Q_INVOKABLE void receiveEvent(const QString& event, const QJsonArray& args);
    void updateRooms(const QJsonArray& rooms);
    void appendMessage(const QJsonObject& message);
    void joinRoom(const QString& id, const QString& name = {});
    Q_INVOKABLE void leaveRoom();
    void clearParticipantControls();
    void applyMicrophoneState();
    CallShortcuts* shortcuts_;
    DesktopNotifications* notifications_;
    bool pushToTalk_ = false, talkHeld_ = false, effectiveMuted_ = true;
    bool serverMuted_ = false, voiceReady_ = false;
    QSet<QString> roomMutedPeers_;
    void showUserContextMenu(const QString& id, const QString& name, const QPoint& globalPos);
    QSet<QString> speakingPeers_;
    QHash<QString, int> peerVolumePercent_;
    QSet<QString> localMutedPeers_;
    QHash<QString, int> peerPanPercent_;
    QSet<QString> disabledVideoPeers_;
    QHash<QString, int> streamVolumePercent_;
    QSet<QString> streamMutedPeers_;
    qint64 lastMutedNotice_ = 0;
    Signaling signaling_;
    VoiceService voice_;
    ScreenService screen_;
    CameraPublisher camera_;
    QString serverUrl_, groupInvite_, username_;
    AuthSession authSession_;
    // Server (guild) layer of the signaling hub: rail entries, the active server and its invite button.
    // An empty currentServer_.id is the legacy "Triscord" group instance (no serverId on the socket).
    HubApi hub_;
    HubServer currentServer_;
    ServerRail* serverRail_ = nullptr;
    ServerRailItem* legacyRailItem_ = nullptr;
    QList<QPair<ServerRailItem*, HubServer>> railServers_;
    QLabel* serverTitle_ = nullptr;
    QPushButton* inviteButton_ = nullptr;
    QTimer iceRefresh_;
    void refreshServers(const QString& selectId = {});
    void switchServer(const HubServer& server);
    void applyServerChrome();
    void refreshIce();
    void openServerDialog();
    void createInvite();
    void signInWithGoogle();
    void signOutOfGoogle();
    ChannelComposer* message_;
    QListWidget* rooms_;
    QListWidget* members_;
    ChatPane* chat_;
    ParticipantPane* participantCards_;
    Soundboard* soundboard_;
    QPushButton* sounds_ = nullptr;
    QLabel* status_;
    QLabel* memberCount_;
    QPushButton* leaveRoomButton_;
    QPushButton* mute_ = nullptr;
    QPushButton* deafen_ = nullptr;
    QComboBox* inputDevice_;
    QComboBox* outputDevice_;
    bool owner_ = false;
    QString inputPreference_, outputPreference_;
    QString userId_;
    QString roomId_;
    // Set while the signaling connection is down and the user was in a room: the room is joined again
    // as soon as the connection is back (Discord: "Segura firme, vamos te jogar de volta!").
    QString rejoinRoomId_, rejoinRoomName_;
    bool rejoinCamera_ = false;
    // Mirrors rejoinCamera_ for the screen share: set only on an involuntary drop while sharing, so a
    // deliberate stop or a deliberate leave never resumes it (desktop/LIMITES_E_ESTADO.md).
    bool rejoinShare_ = false;
    triscord::CaptureSource rejoinShareSource_;
    bool rejoinShareAudio_ = false;
    triscord::VideoConfig rejoinShareConfig_;
    QJsonArray roomDirectory_;
    QLabel* channelHeaderTitle_ = nullptr;
    QWidget* voiceConnectionBar_ = nullptr;
    QLabel* voiceConnectionRoom_ = nullptr;
    QLabel* userAvatarLabel_ = nullptr;
    QLabel* userNameLabel_ = nullptr;
    QLabel* userTagLabel_ = nullptr;
    QPushButton* userMuteButton_ = nullptr;
    QPushButton* userDeafenButton_ = nullptr;
    QPushButton* voiceBarDisconnect_ = nullptr;
    QWidget* callControlsDock_ = nullptr;
    SplitAudioButton* micGroup_ = nullptr;
    SplitAudioButton* deafenGroup_ = nullptr;
    bool mutedBeforeDeafen_ = false;
    void updateUserProfile();
    void openEditProfileDialog();
    void refreshAudioControls();
    void setSelfDeafened(bool deafened);
    TitleBar* titleBar_ = nullptr;
    VoicePrejoinView* prejoin_ = nullptr;
    QStackedWidget* centerStack_ = nullptr;
    QWidget* centerBody_ = nullptr;
    QWidget* channelHeader_ = nullptr;
    QWidget* accountCard_ = nullptr;
    QWidget* centerSurface_ = nullptr;
    // Channel header extras shown while a tile is focused in the call (the viewer's title, quality and live pills).
    QLabel* focusSeparator_ = nullptr; QLabel* focusAvatar_ = nullptr; QLabel* focusTitle_ = nullptr;
    QLabel* qualityPill_ = nullptr; QLabel* livePill_ = nullptr;
    void updateFocusHeader();
    QPushButton* rtcSounds_ = nullptr;
    SplitAudioButton* barMicGroup_ = nullptr;
    QPushButton* chatToggle_ = nullptr;
    QWidget* chatPanel_ = nullptr;
    QLabel* chatPanelTitle_ = nullptr;
    NotificationBadge* chatUnreadBadge_ = nullptr;
    int unreadChatCount_ = 0;
    QLabel* settingsProfileAvatar_ = nullptr;
    QString viewedRoomId_;
    void showCenterState();
    void updateCallChrome();
    bool centerHovered_ = false;
    QList<QWidget*> callChrome_;
protected:
    bool nativeEvent(const QByteArray& eventType, void* message, qintptr* result) override;
};
}
