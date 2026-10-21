#include "core_session.h"
#include "error_reports.h"
#include <QTimeZone>
#include <QScopedValueRollback>
#include "screen_quality.h"

#include <QDateTime>
#include <QDesktopServices>
#include <algorithm>

#include "auth_session.h"
#include "google_auth.h"
#include "camera_publisher.h"
#include "device_share.h"
#include "hub_api.h"
#include "ice_config.h"
#include "screen_service.h"
#include "signaling.h"
#include "voice_service.h"
#include "voice_mix.h"
#include "voice_deepfilter.h"
#include "sound_player.h"
#include "notification_policy.h"
#include "window_lifecycle.h"
#include <QCoreApplication>
#include "profile_media.h"
#include "markdown_web.h"
#include <QCache>
#include <QRegularExpression>

#include <QBuffer>
#include <exception>
#include <QCameraDevice>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPainter>
#include <QImageReader>
#include <memory>
#include <QSettings>
#include <QUrl>
#include <QUuid>
#include <cstdio>
#include <utility>
#include <QVideoFrame>

namespace triscord {
namespace {

constexpr int kProtocolVersion = 1;
constexpr int kMaxNameLength = 32;   // sanitizeRoomName on the hub
const QString kLocal = QStringLiteral("$local");   // id the media services use for our own camera/share

QJsonObject message(const char* type) { return {{"v", kProtocolVersion}, {"type", type}}; }

// "Abrir o Triscord ao iniciar o Windows" writes the Run key with this executable: not from a development build or an
// end-to-end run (TRISCORD_SETTINGS_PATH), which would register a throwaway binary for every logon.
bool loginSupported() {
#ifdef TRISCORD_WEB_DEVTOOLS
    return false;
#else
    return qEnvironmentVariable("TRISCORD_SETTINGS_PATH").isEmpty();
#endif
}

bool loginEnabled() {
    if (!loginSupported()) return false;
    const auto run = LoginItem::registryStore();
    return LoginItem(run.get()).enabled(QCoreApplication::applicationFilePath());
}

// Allowed fields per command (besides "name"); anything else makes the command invalid.
const QHash<QString, QSet<QString>>& commandFields() {
    static const QHash<QString, QSet<QString>> fields{
        {"requestSnapshot", {}},
        {"signIn", {}},
        {"setNick", {"nick"}},
        {"signInNick", {"nick", "password"}},
        {"setPassword", {"password", "currentPassword"}},
        {"signOut", {}},
        {"setCustomStatus", {"text"}},
        {"createServer", {"serverName"}},
        {"acceptInvite", {"invite"}},
        {"selectServer", {"serverId"}},
        {"selectChannel", {"channelId"}},
        {"joinVoice", {"channelId"}},
        {"leaveVoice", {}},
        {"createChannel", {"channelName"}},
        {"sendChatMessage", {"text"}},
        {"deleteChatMessage", {"messageId"}},
        {"toggleReaction", {"messageId", "emoji"}},
        {"copyMessageText", {"messageId"}},
        {"openChatLink", {"messageId", "url"}},
        {"playSound", {"soundId"}},
        {"previewSound", {"soundId"}},
        {"stopSoundPreview", {}},
        {"getOwnProfile", {}},
        {"getParticipantProfile", {"socketId"}},
        {"closeParticipantProfile", {}},
        {"saveOwnProfile", {"fields"}},
        {"beginProfileMedia", {"kind", "size"}},
        {"appendProfileMedia", {"uploadId", "offset", "data"}},
        {"finishProfileMedia", {"uploadId"}},
        {"cancelProfileMedia", {"uploadId"}},
        {"removeProfileMedia", {"kind"}},
        {"setMuted", {"muted"}},
        {"setPeerAudio", {"socketId", "volume", "pan", "muted", "streamVolume", "streamMuted"}},
        {"setServerMuted", {"socketId", "muted"}},
        {"disconnectParticipant", {"socketId"}},
        {"setDeafened", {"deafened"}},
        {"setCamera", {"on"}},
        {"startCameraPreview", {"previewId"}},
        {"keepCameraPreview", {"previewId"}},
        {"stopCameraPreview", {"previewId"}},
        {"setCallFullscreen", {"on"}},
        {"setCallPopout", {"on"}},
        {"setCallPopoutOnTop", {"on"}},
        {"setStreamHidden", {"streamId", "hidden"}},
        {"listShareSources", {}},
        {"startScreenShare", {"generation", "index"}},
        {"startDeviceShare", {"deviceId"}},
        {"stopScreenShare", {}},
        {"openAudioMenu", {"device"}},
        {"createInvite", {"serverId"}},
        {"deleteServer", {"serverId"}},
        {"leaveServer", {"serverId"}},
        {"copyInvite", {"code"}},
        {"openServerDialog", {}},
        {"openSettings", {}},
        {"setSetting", {"key", "value"}},
        {"sendErrorReport", {}},
        {"requestDevices", {}},
        {"window", {"action"}},
        {"videoAck", {"index", "seq"}},
        {"videoSurface", {"streamId", "rect", "scale"}},
        {"videoOccluders", {"rects"}},
        {"videoStageOccluders", {"rects"}},
        {"videoRole", {"streamId", "role"}},
        {"videoIdle", {"idle"}},
        {"setCallFocus", {"key", "filmOpen"}},
        {"videoStats", {"streamId", "presented", "dropped"}},
    };
    return fields;
}

QString imageDataUrl(const QImage& image) {
    QByteArray bytes;
    QBuffer buffer(&bytes);
    buffer.open(QIODevice::WriteOnly);
    image.scaled(439, 247, Qt::KeepAspectRatio, Qt::SmoothTransformation).save(&buffer, "JPEG", 70);
    return "data:image/jpeg;base64," + QString::fromLatin1(bytes.toBase64());
}

} // namespace

CoreSession::CoreSession(Signaling* signaling, VoiceService* voice, AuthSession* auth, HubApi* hub,
                         QString hubUrl, QString groupInvite, Media media, QObject* parent)
    : QObject(parent), signaling_(signaling), voice_(voice), auth_(auth), hub_(hub), media_(media),
      hubUrl_(std::move(hubUrl)), groupInvite_(std::move(groupInvite)) {
    QSettings settings;
    reporter_ = new ErrorReporter(hub_, QStringLiteral(TRISCORD_VERSION), this);
    reportTimer_.setSingleShot(true);
    connect(&reportTimer_, &QTimer::timeout, this, &CoreSession::sendScheduledErrorReport);
    sounds_ = new SoundPlayer(this);
    // Notifications (same rule as the Qt client): mentions of you and people entering your room, while in the
    // background. "Ativar notificações na área de trabalho" / "Ativar alerta na barra de tarefas" pick how.
    notifications_ = new NotificationPolicy(this);
    connect(notifications_, &NotificationPolicy::deliver, this, [this](const QString& title, const QString& body) {
        QSettings settings;
        emit notify(title, body, settings.value("desktopNotifications", true).toBool(), settings.value("taskbarAlert", true).toBool());
    });
    {
        QSettings settings;
        notifications_->setEnabled(settings.value("desktopNotifications", true).toBool() || settings.value("taskbarAlert", true).toBool());
    }
    profileMedia_ = new ProfileMediaClient(this);
    uploadDeadline_.setSingleShot(true);
    connect(&uploadDeadline_, &QTimer::timeout, this, [this] { upload_ = {}; });
    connect(&RemoteImageCache::instance(), &RemoteImageCache::loaded, this, [this](const QString& url) {
        updateParticipantImage(url);
        applyPrefetchedAvatar(url);
        if (!auth_->isValid() || (url != avatarSource_ && url != bannerSource_)) return;
        const auto bytes = RemoteImageCache::instance().bytes(url);
        const auto mime = sniffProfileImageMime(bytes); if (mime.isEmpty()) return;
        const auto image = "data:" + mime + ";base64," + QString::fromLatin1(bytes.toBase64());
        if (url == avatarSource_) {
            avatarData_ = image;
            const auto frame = QImage::fromData(bytes).scaled(128,128,Qt::KeepAspectRatio,Qt::SmoothTransformation);
            QByteArray first; QBuffer buffer(&first); buffer.open(QIODevice::WriteOnly); frame.save(&buffer,"PNG");
            accountAvatarData_ = first.isEmpty() ? QString() : "data:image/png;base64," + QString::fromLatin1(first.toBase64());
        }
        if (url == bannerSource_) bannerData_ = image;
        publishOwnProfile();
    });
    connect(sounds_, &SoundPlayer::changed, this, [this](const QString& id) { patch({{"soundboardPlayingId", id}}); });
    connect(sounds_, &SoundPlayer::failed, this, [this](const QString& reason) {
        patch({{"soundboardError", reason}}); emit notice(reason);
    });
    connect(sounds_, &SoundPlayer::decoded, this, &CoreSession::soundDecoded);
    // Relays expire (the hub hands out sets with at least 300 s left; resolveIceServers trusts them 280 s).
    iceRefresh_.setInterval(240000);
    connect(&iceRefresh_, &QTimer::timeout, this, &CoreSession::refreshIce);
    soundAckDeadline_.setSingleShot(true);
    connect(&soundAckDeadline_, &QTimer::timeout, this, [this] {
        finishSoundRequest("O servidor não confirmou esse som. Tente novamente.");
    });
    userId_ = settings.value("userId").toString();
    if (userId_.isEmpty()) { userId_ = "native_" + QUuid::createUuid().toString(QUuid::WithoutBraces); settings.setValue("userId", userId_); }
    session_ = {
        {"connection", "offline"},
        {"auth", QJsonObject{{"state", auth_->isValid() ? "signedIn" : "signedOut"}}},
        {"account", accountJson()},
        {"servers", QJsonArray{}},   // the account's servers (GET /servers); the old fixed group is gone (user, 18/10)
        {"selectedServerId", settings.value("lastServerId").toString()},
        {"categories", QJsonArray{QJsonObject{{"id", "voice"}, {"name", "Canais de Voz"}, {"channels", QJsonArray{}}}}},
        {"muted", false}, {"deafened", false}, {"camera", false}, {"sharing", false},
        {"streams", QJsonArray{}},
        {"soundboard", SoundPlayer::catalog()},
    };
    connect(voice_, &VoiceService::devicesChanged, this, [this](const QJsonArray& inputs, const QJsonArray& outputs) {
        inputDevices_ = inputs; outputDevices_ = outputs; publishSettings();
    });
    applyAudioSettings();
    publishSettings();
    connect(signaling_, &Signaling::eventReceived, this, &CoreSession::onEvent);
    connect(signaling_, &Signaling::connected, this, [this] { patch({{"connection", "connected"}}); });
    connect(signaling_, &Signaling::disconnected, this, [this] {
        if (const auto channel = session_.value("connectedChannelId").toString(); !channel.isEmpty() && !leavingVoice_) {
            // session_'s callServerId is still the call's server here; connectSignaling() to another server has
            // already changed callServerId_, so a server switch never matches and never rejoins.
            rejoin_.channel = channel; rejoin_.server = session_.value("callServerId").toString(); rejoin_.name.clear(); rejoin_.age.start();
            for (const auto& room : rooms_)
                if (room.toObject().value("id").toString() == channel) rejoin_.name = room.toObject().value("name").toString();
        }
        finishSoundRequest("A conexão caiu antes de confirmar o som.");
        sounds_->stop();
        if (!session_.value("connectedChannelId").toString().isEmpty()) sounds_->playCue("disconnect");
        if (session_.value("callFullscreen").toBool()) emit windowAction("exitCallFullscreen");
        hiddenStreams_.clear();
        cameraReady_ = false; clearCameraIntent();
        clearParticipantProfile(); participantAvatars_.clear(); participantAnimated_.clear(); avatarPrefetch_.clear(); avatarRequested_.clear();
        peerAudio_.clear();
        rooms_ = {};
        speaking_.clear();
        for (const auto& id : streams_.keys()) emit videoRemoved(id);
        streams_.clear();
        patch({{"connection", "reconnecting"}, {"connectedChannelId", QJsonValue()}, {"streams", QJsonArray{}},
               {"categories", QJsonArray{QJsonObject{{"id", "voice"}, {"name", "Canais de Voz"}, {"channels", QJsonArray{}}}}}});
        // The hub also closes the socket when the server was deleted or we were removed from it; the handshake is
        // refused from then on, so without a fresh list the client retried that server forever (18/10).
        if (!switchingServer_) refreshServers();
    });
    // Voice problems ("Reconectando a voz de um participante", device failures) are not shown in this interface; the
    // log keeps them, each text at most once per 10 s (a failing send repeats it for every packet).
    connect(voice_, &VoiceService::message, this, [](const QString& text) {
        static QHash<QString, qint64> last;
        const auto now = QDateTime::currentMSecsSinceEpoch();
        auto& at = last[text];
        if (at && now - at < 10000) return;
        at = now;
        std::printf("voice: %s\n", qPrintable(text)); std::fflush(stdout);
    });
    connect(voice_, &VoiceService::speakingChanged, this, [this](const QString& peer, bool active) {
        const bool changed = active ? !speaking_.contains(peer) : speaking_.contains(peer);
        if (!changed) return;
        if (active) speaking_.insert(peer); else speaking_.remove(peer);
        publishCategories();
    });

    previewTimer_.setInterval(200); // Local thumbnail only, bounded to 5 fps and 640x360; never sent to WebRTC.
    previewLease_.setSingleShot(true); previewLease_.setInterval(6500);
    connect(&previewLease_, &QTimer::timeout, this, [this] { stopCameraPreview("A prévia foi encerrada."); });
    connect(&previewTimer_, &QTimer::timeout, this, [this] {
        if (previewId_.isEmpty()) return;
        QImage image;
        if (media_.syntheticCamera && !previewUsesPublished_) {
            image = QImage(640,360,QImage::Format_RGB32); image.fill(QColor("#5865f2"));
            QPainter(&image).fillRect((previewTick_++ * 18) % 640, 0, 60, 360, Qt::white);
        } else if (previewUsesPublished_) image = previewImage_;
        else if (previewFrame_.isValid()) {
            try {
                image = cameraImage(previewFrame_);
                if (previewFrame_.mirrored()) image = image.mirrored(true,false);
            } catch (const std::exception&) {
                stopCameraPreview("Não foi possível processar a imagem da câmera."); return;
            }
            previewFrame_ = {};
        }
        if (image.isNull()) return;
        image = image.scaled(640,360,Qt::KeepAspectRatio,Qt::FastTransformation);
        QByteArray bytes; QBuffer buffer(&bytes); buffer.open(QIODevice::WriteOnly);
        if (!image.save(&buffer,"JPEG",70) || bytes.size() > 128*1024) return;
        emit event({{"v",kProtocolVersion},{"type","event"},{"name","cameraPreviewFrame"},{"previewId",previewId_},
                    {"image",QString("data:image/jpeg;base64,")+QString::fromLatin1(bytes.toBase64())}});
    });
    if (media_.camera) {
        cameraStartDeadline_.setSingleShot(true);
        connect(&cameraStartDeadline_, &QTimer::timeout, this, [this] {
            if (!cameraWanted_ || session_.value("camera").toBool()) return;
            clearCameraIntent(); media_.camera->stop();
            emit notice("Não foi possível iniciar a câmera. Tente novamente.");
        });
        connect(media_.camera, &CameraPublisher::roomChanged, this, [this](bool ready) {
            cameraReady_ = ready;
            if (!ready) cameraStarting_ = false;
            else startCameraIfReady();
        });
        connect(media_.camera, &CameraPublisher::publishingChanged, this, [this](bool active) {
            if (!active && previewUsesPublished_) stopCameraPreview("A câmera foi desligada.");
            cameraStarting_ = false;
            if (active && !cameraWanted_) { media_.camera->stop(); return; }
            if (active) {
                cameraStartDeadline_.stop();
                if (media_.syntheticCamera) syntheticCamera_.start();
            } else syntheticCamera_.stop();
            if (!leavingVoice_ && !session_.value("connectedChannelId").toString().isEmpty() && active != session_.value("camera").toBool()) sounds_->playCue(active ? "camera_on" : "camera_off");
            patch({{"camera", active}, {"cameraPending", cameraWanted_ && !active}});
        });
        connect(media_.camera, &CameraPublisher::image, this, [this](const QString& id, const QImage& image) {
            if (id == kLocal && previewUsesPublished_ && !previewId_.isEmpty()) previewImage_ = image;
            addStreamFrame("cam:" + id, id, "camera", image);
        });
        connect(media_.camera, &CameraPublisher::removed, this, [this](const QString& id) { removeStream("cam:" + id); });
        connect(media_.camera, &CameraPublisher::message, this, [this](const QString& message) { clearCameraIntent(); emit notice(message); });
        connect(media_.camera, &CameraPublisher::devicesReady, this, [this](const QList<QCameraDevice>& devices) {
            QJsonArray list;
            for (const auto& device : devices) list.append(QJsonObject{{"id", QString::fromLatin1(device.id().toHex())}, {"name", device.description()}, {"isDefault", device.isDefault()}});
            cameraDevices_ = list; publishSettings();
        });
        // Synthetic source for tests: a moving bar, 30 fps, through the same encoder path as a real camera.
        syntheticCamera_.setInterval(33);
        connect(&syntheticCamera_, &QTimer::timeout, this, [this] {
            QImage frame(640, 360, QImage::Format_RGB32);
            frame.fill(QColor(30, 90, 160));
            QPainter(&frame).fillRect((syntheticTick_++ * 8) % 640, 0, 60, 360, Qt::white);
            media_.camera->submitFrame(QVideoFrame(frame));
        });
    }
    if (media_.screen) {
        connect(media_.screen, &ScreenService::sharingChanged, this, [this](bool active) {
            if (!leavingVoice_ && !session_.value("connectedChannelId").toString().isEmpty() && active != session_.value("sharing").toBool()) sounds_->playCue(active ? "stream_started" : "stream_ended");
            if (!active && deviceShare_) deviceShare_->stop();
            patch(active ? QJsonObject{{"sharing", true}} : QJsonObject{{"sharing", false}, {"sharingName", QJsonValue()}});
            if (active && !streams_.contains("scr:$local")) {
                streams_.insert("scr:$local", {kLocal, "screen", QSize(16, 9), false});
                publishStreams();
            }
        });
        // Announce the share before its first decoded frame; otherwise a slow/lost IDR hides the entire tile.
        connect(media_.screen, &ScreenService::streamsChanged, this, [this](const QJsonArray& list) {
            QSet<QString> announced;
            bool changed = false;
            if (!session_.value("connectedChannelId").toString().isEmpty()) {
                for (const auto& value : list) {
                    const auto id = value.toObject().value("id").toString();
                    if (id.isEmpty() || id == signaling_->socketId()) continue;
                    const auto streamId = "scr:" + id;
                    announced.insert(streamId);
                    if (!streams_.contains(streamId)) {
                        streams_.insert(streamId, {id, "screen", QSize(16, 9), false});
                        applyStreamAudio(id); changed = true;
                    }
                }
            }
            QStringList removed;
            for (auto it = streams_.cbegin(); it != streams_.cend(); ++it)
                if (it->kind == "screen" && it->ownerId != kLocal && !announced.contains(it.key())) removed.append(it.key());
            for (const auto& id : removed) removeStream(id);
            if (changed) publishStreams();
        });
        deviceShare_ = new DeviceShare(media_.screen, this);
        connect(deviceShare_, &DeviceShare::image, this, [this](const QImage& image) {
            if (session_.value("sharing").toBool()) addStreamFrame("scr:$local", "$local", "screen", image);
        });
        connect(deviceShare_, &DeviceShare::message, this, [this](const QString& text) { media_.screen->stop(); emit notice(text); });
        connect(media_.screen, &ScreenService::frameReady, this, [this](const QString& id, const QImage& image) {
            addStreamFrame("scr:" + id, id, "screen", image);
        });
        connect(media_.screen, &ScreenService::frameRemoved, this, [this](const QString& id) {
            const auto streamId = "scr:" + id;
            auto stream = streams_.find(streamId);
            if (id == kLocal || stream == streams_.end()) { removeStream(streamId); return; }
            // A new peer generation clears the old image, but the publisher is still sharing.
            stream->hasFrame = false;
            emit videoRemoved(streamId);
            publishStreams();
        });
        connect(media_.screen, &ScreenService::message, this, &CoreSession::notice);
        connect(media_.screen, &ScreenService::thumbnailReady, this, [this](quint64 generation, int index, const QImage& image) {
            if (generation != thumbnailGeneration_) return;
            auto event = message("event");
            event.insert("name", "shareThumbnail");
            event.insert("generation", QString::number(generation));
            event.insert("index", index);
            event.insert("image", imageDataUrl(image));
            emit this->event(event);
        });
    }
}

QJsonObject CoreSession::accountJson() const {
    const auto nick = auth_->nick().isEmpty() ? QSettings().value("username").toString() : auth_->nick();
    const auto display = ownProfile_.value("display_name").toString().trimmed();
    return {{"id", auth_->id()}, {"displayName", display.isEmpty() ? nick : display}, {"username", nick}, {"status", "online"}, {"customStatus", auth_->isValid() ? QSettings().value("accountStatus/" + auth_->id()).toString() : QString()}, {"avatarUrl", accountAvatarData_}};
}

QJsonObject CoreSession::ownProfileJson() const {
    QJsonObject result;
    for (const char* key : {"display_name", "pronouns", "bio", "note", "banner_color", "profile_theme_start", "profile_theme_end", "created_at"})
        result.insert(key, ownProfile_.value(key));
    result.insert("avatarDataUrl", avatarData_); result.insert("bannerDataUrl", bannerData_);
    result.insert("hasAvatar", !ownProfile_.value("avatar_url").toString().isEmpty());
    result.insert("hasBanner", !ownProfile_.value("banner_url").toString().isEmpty());
    // Sign-in methods (Minha conta): whether a password is set, and whether the account came from Google.
    result.insert("hasPassword", ownProfile_.value("has_password").toBool());
    result.insert("google", ownProfile_.value("google").toBool(!auth_->id().startsWith("n_")));
    return result;
}
void CoreSession::publishOwnProfile() { patch({{"profile", ownProfileJson()}, {"account", accountJson()}}); publishAvatars(); }
void CoreSession::applyOwnProfile(const QJsonObject& account) {
    ownProfile_ = account;
    for (const bool avatar : {true, false}) {
        const auto source = account.value(avatar ? "avatar_url" : "banner_url").toString();
        auto& old = avatar ? avatarSource_ : bannerSource_;
        auto& data = avatar ? avatarData_ : bannerData_;
        if (source != old) { old = source; data.clear(); if(avatar) accountAvatarData_.clear(); }
        if (source.isEmpty()) continue;
        const QUrl url(source), authUrl(authServerUrl());
        const bool ownMedia = url.scheme() == authUrl.scheme() && url.host() == authUrl.host() && url.port() == authUrl.port()
            && url.path().startsWith("/media/" + QString::fromUtf8(QUrl::toPercentEncoding(auth_->id())) + "/");
        const bool google = avatar && url.scheme() == "https" && (url.host() == "googleusercontent.com" || url.host().endsWith(".googleusercontent.com"));
        if ((ownMedia || google) && url.userInfo().isEmpty()) RemoteImageCache::instance().fetch(source);
    }
    publishOwnProfile();
}
void CoreSession::loadOwnProfile(const QString& requestId) {
    const auto token = auth_->session();
    QNetworkRequest request(QUrl(authServerUrl() + "/me")); request.setTransferTimeout(15000);
    request.setRawHeader("Authorization", "Bearer " + token.toUtf8());
    auto* reply = network_.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply, token, requestId] {
        reply->deleteLater();
        if (token != auth_->session()) { if (!requestId.isEmpty()) emit this->reply(error(requestId, "stale_session", "A sessão mudou.")); return; }
        const auto account = QJsonDocument::fromJson(reply->readAll()).object().value("account").toObject();
        if (reply->error() != QNetworkReply::NoError || account.isEmpty()) {
            if (!requestId.isEmpty()) emit this->reply(error(requestId, "profile_unavailable", "Não foi possível carregar seu perfil.")); return;
        }
        applyOwnProfile(account);
        if (!requestId.isEmpty()) emit this->reply(ok(requestId, ownProfileJson()));
    });
}


// Only a server-verified identity currently visible in the directory may be resolved by the UI.
QJsonObject CoreSession::participant(const QString& socketId) const {
    for (const auto& room : rooms_)
        for (const auto& value : room.toObject().value("users").toArray()) {
            const auto user = value.toObject();
            if (user.value("socketId").toString() == socketId && user.value("authenticated").toBool()) return user;
        }
    return {};
}
void CoreSession::clearParticipantProfile() {
    ++participantGeneration_; participantProfile_ = {};
    const auto pending = participantReply_; participantReply_ = nullptr;
    if (pending) pending->abort();
    participantSocket_.clear(); participantAccount_.clear(); participantAvatarSource_.clear(); participantBannerSource_.clear();
    patch({{"participantProfile", QJsonValue()}});
}
QString CoreSession::firstFramePng(const QByteArray& bytes) {
    auto copy = bytes; QBuffer input(&copy); input.open(QIODevice::ReadOnly); QImageReader reader(&input);
    const auto size = reader.size();
    if (!size.isValid() || size.width() > 4096 || size.height() > 4096) return {};
    const auto frame = reader.read().scaled(QSize(128,128), Qt::KeepAspectRatio, Qt::SmoothTransformation);
    if (frame.isNull()) return {};
    QByteArray png; QBuffer output(&png); output.open(QIODevice::WriteOnly); frame.save(&output,"PNG");
    return "data:image/png;base64," + QString::fromLatin1(png.toBase64());
}
QString CoreSession::animatedGif(const QByteArray& bytes) {
    if (sniffProfileImageMime(bytes) != "image/gif" || bytes.size() > 1048576) return {};
    auto copy = bytes; QBuffer input(&copy); input.open(QIODevice::ReadOnly); QImageReader reader(&input);
    return reader.supportsAnimation() && reader.imageCount() != 1 ? "data:image/gif;base64," + QString::fromLatin1(bytes.toBase64()) : QString();
}
void CoreSession::prefetchAvatar(const QString& account) {
    if (!auth_->isValid() || avatarRequested_.contains(account)) return;
    avatarRequested_.insert(account);
    QNetworkRequest request(QUrl(authServerUrl() + "/profile/" + QString::fromUtf8(QUrl::toPercentEncoding(account))));
    request.setTransferTimeout(15000);
    auto* reply = network_.get(request); reply->setReadBufferSize(65537);
    const auto token = auth_->session();
    connect(reply, &QNetworkReply::finished, this, [this, reply, account, token] {
        reply->deleteLater();
        const auto body = reply->read(65537);
        if (reply->error() != QNetworkReply::NoError || body.size() > 65536 || token != auth_->session()) { avatarRequested_.remove(account); return; }
        const auto profile = QJsonDocument::fromJson(body).object().value("profile").toObject();
        if (profile.value("id").toString() != account) return;
        const auto source = profile.value("avatar_url").toString();
        const QUrl url(source), base(authServerUrl());
        // Same origin rules as the profile card: the account's own media on the auth server, or a Google photo.
        const bool media = url.scheme() == base.scheme() && url.host() == base.host() && url.port() == base.port()
            && url.path().startsWith("/media/" + QString::fromUtf8(QUrl::toPercentEncoding(account)) + "/");
        const bool google = url.scheme() == "https" && (url.host() == "googleusercontent.com" || url.host().endsWith(".googleusercontent.com"));
        if (!(media || google) || !url.userInfo().isEmpty()) return;
        avatarPrefetch_.insert(source, account);
        RemoteImageCache::instance().fetch(source);
    });
}
void CoreSession::applyPrefetchedAvatar(const QString& url) {
    const auto account = avatarPrefetch_.take(url);
    if (account.isEmpty() || !auth_->isValid()) return;
    const auto bytes = RemoteImageCache::instance().bytes(url);
    const auto still = firstFramePng(bytes);
    if (still.isEmpty()) return;
    if (participantAvatars_.size() >= 64 && !participantAvatars_.contains(account)) { participantAvatars_.clear(); participantAnimated_.clear(); }
    participantAvatars_.insert(account, still);
    const auto animated = animatedGif(bytes);
    if (animated.isEmpty()) participantAnimated_.remove(account); else participantAnimated_.insert(account, animated);
    publishCategories(); publishAvatars();
}
void CoreSession::publishAvatars() {
    QJsonObject avatars;
    for (auto it = participantAvatars_.begin(); it != participantAvatars_.end(); ++it)
        avatars.insert(it.key(), QJsonObject{{"still", it.value()}, {"animated", participantAnimated_.value(it.key())}});
    if (auth_->isValid() && !accountAvatarData_.isEmpty())
        avatars.insert(auth_->id(), QJsonObject{{"still", accountAvatarData_}, {"animated", avatarData_.startsWith("data:image/gif;base64,") ? avatarData_ : QString()}});
    if (session_.value("avatars").toObject() != avatars) patch({{"avatars", avatars}});
}
void CoreSession::updateParticipantImage(const QString& url) {
    if (!auth_->isValid() || participantSocket_.isEmpty() || (url != participantAvatarSource_ && url != participantBannerSource_)) return;
    if (participant(participantSocket_).value("userId").toString() != participantAccount_) return;
    auto bytes = RemoteImageCache::instance().bytes(url);
    QBuffer input(&bytes); input.open(QIODevice::ReadOnly); QImageReader reader(&input);
    const auto size = reader.size();
    if (!size.isValid() || size.width() > 4096 || size.height() > 4096) return;
    const bool avatar = url == participantAvatarSource_;
    // An animated GIF stays animated on the profile card (Discord animates avatars and banners there), as the own
    // profile already did; the lists keep the static first frame. 18/10: a friend saw the GIFs frozen.
    const bool animated = sniffProfileImageMime(bytes) == "image/gif" && bytes.size() <= 1048576
        && reader.supportsAnimation() && reader.imageCount() != 1;
    const auto frame = reader.read().scaled(avatar ? QSize(128,128) : QSize(600,210), Qt::KeepAspectRatio, Qt::SmoothTransformation);
    if (frame.isNull()) return;
    QByteArray png; QBuffer output(&png); output.open(QIODevice::WriteOnly); frame.save(&output,"PNG");
    const auto image = "data:image/png;base64," + QString::fromLatin1(png.toBase64());
    participantProfile_.insert(avatar ? "avatarDataUrl" : "bannerDataUrl",
                               animated ? "data:image/gif;base64," + QString::fromLatin1(bytes.toBase64()) : image);
    if (avatar) {
        if (participantAvatars_.size() >= 64 && !participantAvatars_.contains(participantAccount_)) { participantAvatars_.clear(); participantAnimated_.clear(); }
        participantAvatars_.insert(participantAccount_, image);
        if (animated) participantAnimated_.insert(participantAccount_, "data:image/gif;base64," + QString::fromLatin1(bytes.toBase64()));
        else participantAnimated_.remove(participantAccount_);
        publishCategories(); publishAvatars();
    }
    patch({{"participantProfile", participantProfile_}});
}
void CoreSession::loadParticipantProfile(const QString& socketId, const QString& requestId) {
    clearParticipantProfile();
    participantSocket_ = socketId; participantAccount_ = participant(socketId).value("userId").toString();
    const auto account = participantAccount_, token = auth_->session(); const auto generation = participantGeneration_;
    QNetworkRequest request(QUrl(authServerUrl() + "/profile/" + QString::fromUtf8(QUrl::toPercentEncoding(account))));
    request.setTransferTimeout(15000);
    auto* reply = network_.get(request); participantReply_ = reply; reply->setReadBufferSize(65537);
    const auto body = std::make_shared<QByteArray>();
    connect(reply,&QIODevice::readyRead,this,[reply,body] {
        body->append(reply->read(65537-body->size()));
        if (body->size() > 65536) reply->abort();
    });
    connect(reply,&QNetworkReply::finished,this,[this,reply,body,token,account,socketId,generation,requestId] {
        reply->deleteLater();
        if (generation != participantGeneration_ || token != auth_->session() || participant(socketId).value("userId").toString() != account) {
            emit this->reply(error(requestId,"stale_participant","O participante não está mais disponível.")); return;
        }
        body->append(reply->read(65537-body->size()));
        const auto profile = QJsonDocument::fromJson(*body).object().value("profile").toObject();
        if (reply->error() != QNetworkReply::NoError || body->size() > 65536 || profile.value("id").toString() != account) {
            emit this->reply(error(requestId,"profile_unavailable","Não foi possível carregar este perfil.")); return;
        }
        // Explicit public DTO: no note, email, token or remote URLs enter the renderer.
        participantProfile_ = {{"socketId",socketId},{"username",profile.value("nick").toString().left(32)},
            {"displayName",profile.value("display_name").toString().left(32)}, {"pronouns",profile.value("pronouns").toString().left(40)},
            {"bio",profile.value("bio").toString().left(190)}, {"created_at",profile.value("created_at")}, {"avatarDataUrl",""},{"bannerDataUrl",""}};
        if (participantProfile_.value("displayName").toString().trimmed().isEmpty()) participantProfile_.insert("displayName", profile.value("nick").toString().left(32));
        for (const char* key : {"banner_color","profile_theme_start","profile_theme_end"}) {
            const auto color = profile.value(key).toString();
            if (QRegularExpression("^#[0-9a-fA-F]{6}$").match(color).hasMatch()) participantProfile_.insert(key,color);
        }
        participantAvatars_.remove(account); publishCategories(); patch({{"participantProfile",participantProfile_}});
        emit this->reply(ok(requestId));
        for (const bool avatar : {true,false}) {
            const auto source = profile.value(avatar ? "avatar_url" : "banner_url").toString();
            const QUrl url(source), base(authServerUrl());
            const bool media = url.scheme() == base.scheme() && url.host() == base.host() && url.port() == base.port()
                && url.path().startsWith("/media/" + QString::fromUtf8(QUrl::toPercentEncoding(account)) + "/");
            const bool google = avatar && url.scheme() == "https" && (url.host() == "googleusercontent.com" || url.host().endsWith(".googleusercontent.com"));
            if (!(media || google) || !url.userInfo().isEmpty()) continue;
            (avatar ? participantAvatarSource_ : participantBannerSource_) = source;
            RemoteImageCache::instance().fetch(source);
        }
    });
}

QJsonObject CoreSession::userData() const {
    // Same payload as MainWindow::joinRoom: the hub derives the identity from the session token.
    return {{"userId", userId_}, {"username", accountJson().value("displayName")}, {"sessionToken", auth_->session()},
            {"status", accountJson().value("customStatus")}, {"avatar", "#5865f2"}, {"isMuted", session_.value("muted")}, {"isDeafened", session_.value("deafened")},
            {"appVersion", "native-web-0.1"}};
}

void CoreSession::setCallPopout(bool open, bool onTop) {
    onTop = open && onTop;
    if (session_.value("callPopout").toBool() == open && session_.value("callPopoutOnTop").toBool() == onTop) return;
    QJsonObject changes{{"callPopout", open}, {"callPopoutOnTop", onTop}};
    if (!open) changes.insert("callPopoutFullscreen", false);
    patch(changes);
    emit callPopout(open, onTop);
}

void CoreSession::setCallPopoutFullscreenState(bool fullscreen) {
    fullscreen = fullscreen && session_.value("callPopout").toBool();
    if (session_.value("callPopoutFullscreen").toBool() != fullscreen) patch({{"callPopoutFullscreen", fullscreen}});
}

void CoreSession::closeCallPopout() { setCallPopout(false); }

void CoreSession::setCallFullscreenState(bool fullscreen) {
    if (session_.value("callFullscreen").toBool() != fullscreen) patch({{"callFullscreen",fullscreen}});
    if (fullscreen && session_.value("connectedChannelId").toString().isEmpty()) emit windowAction("exitCallFullscreen");
}

void CoreSession::start() {
    hub_->setBaseUrl(hubUrl_);
    if (auth_->isValid()) startSignedIn();   // otherwise the interface shows the login screen
}

void CoreSession::setLogDirectory(const QString& directory) {
    reporter_->setLogDirectory(directory);
    publishSettings();
}

// Error reports (error_reports.h): 20 s after sign-in what the previous run's log did not send yet (a crash shows
// there), then every 30 minutes the new part of the running one, including during calls.
void CoreSession::sendScheduledErrorReport() {
    bool customInterval = false;   // tests shorten the interval
    const int interval = qEnvironmentVariableIntValue("TRISCORD_REPORT_INTERVAL_MS", &customInterval);
    if (!auth_->isValid()) return;
    if (QSettings().value("errorReports", true).toBool()) { reporter_->sendPrevious(); reporter_->sendCurrent(true); }
    reportTimer_.start(customInterval ? interval : 30 * 60 * 1000);
}

// 18/10: the WebView2 client never fetched the hub's TURN relays, so calls only had STUN. Between two homes behind
// CGNAT/symmetric NAT the direct path fails and nobody hears anybody; the relay carries the audio then.
void CoreSession::refreshIce() {
    if (!auth_->isValid()) return;
    hub_->fetchIce([this](int status, const QJsonArray& iceServers) {
        const auto entries = parseRtcIceServers(iceServers);
        if (status != 200 || entries.empty() || !auth_->isValid()) return;   // a hub without /ice: STUN only
        setSessionIceServers(entries, QDateTime::currentMSecsSinceEpoch() + 280000);
        if (!iceRefresh_.isActive()) iceRefresh_.start();
    });
}

void CoreSession::startSignedIn() {
    if (ownProfile_.value("id").toString() != auth_->id()) {
        ownProfile_={}; avatarSource_.clear(); bannerSource_.clear(); avatarData_.clear(); bannerData_.clear(); accountAvatarData_.clear();
        upload_={}; uploadDeadline_.stop(); patch({{"profile", QJsonValue()}});
    }
    hub_->setSession(auth_->session());
    refreshIce();
    patch({{"auth", QJsonObject{{"state", "signedIn"}}}, {"account", accountJson()}});
    refreshServers();   // picks the server to show and connects to it
    if (!session_.value("selectedServerId").toString().isEmpty()) connectSignaling();
    loadOwnProfile();
    bool customDelay = false;   // tests shorten the wait
    const int reportDelay = qEnvironmentVariableIntValue("TRISCORD_REPORT_DELAY_MS", &customDelay);
    if (!reportTimer_.isActive()) reportTimer_.start(customDelay ? reportDelay : 20000);
}

void CoreSession::setAuthState(const QString& state, const QString& error, const QString& suggestion) {
    if (state != "signedIn") stopCameraPreview();
    QJsonObject auth{{"state", state}};
    if (!error.isEmpty()) auth.insert("error", error);
    if (!suggestion.isEmpty()) auth.insert("suggestedNick", suggestion);
    patch({{"auth", auth}});
}

QJsonObject CoreSession::ok(const QString& requestId, const QJsonValue& value) const {
    auto result = message("result");
    result.insert("requestId", requestId);
    result.insert("ok", true);
    if (!value.isUndefined()) result.insert("value", value);
    return result;
}

bool CoreSession::browsing() const { return browse_ && session_.value("selectedServerId").toString() != callServerId_; }

void CoreSession::openBrowse(const QString& serverId) {
    closeBrowse();
    browse_ = new Signaling(this);
    connect(browse_, &Signaling::eventReceived, this, [this](const QString& event, const QJsonArray& args) {
        if (event != "rooms-update" || args.isEmpty() || !args.first().isArray()) return;
        browseRooms_ = args.first().toArray();
        if (browsing()) publishCategories();
    });
    browse_->connectTo(QUrl(hubUrl_), {}, {{"serverId", serverId}, {"sessionToken", auth_->session()}});
    publishCategories();   // empty until the viewed server's directory arrives
}

void CoreSession::closeBrowse() {
    if (!browse_) return;
    browse_->disconnect(this); browse_->disconnectFromServer(); browse_->deleteLater(); browse_ = nullptr;
    browseRooms_ = {};
}

// Leaves the call (if any) and moves signaling_ to the viewed server; `then` runs on its first directory.
void CoreSession::switchCallServer(std::function<void()> then) {
    leaveVoice();
    afterSwitch_ = std::move(then);
    connectSignaling();
}

void CoreSession::connectSignaling() {
    closeBrowse();
    const auto serverId = session_.value("selectedServerId").toString();
    callServerId_ = serverId;
    if (serverId.isEmpty()) {   // no server: nothing to connect to (the old fixed group was removed)
        signaling_->disconnectFromServer();
        rooms_ = {}; publishCategories();
        patch({{"connection", "offline"}, {"callServerId", QJsonValue()}});
        return;
    }
    {
        QScopedValueRollback<bool> switching(switchingServer_, true);
        signaling_->connectTo(QUrl(hubUrl_), {}, {{"serverId", serverId}, {"sessionToken", auth_->session()}});
    }
    patch({{"connection", "connecting"}, {"callServerId", serverId}});
}

void CoreSession::refreshServers() {
    if (!hub_->canCall()) return;
    // An answer older than one already applied is dropped (it could lack a server just created or joined), and so
    // is one that arrives after signing out or into another account.
    const auto generation = ++serverListIssued_;
    const auto token = auth_->session();
    hub_->listServers([this, generation, token](int status, const QList<HubServer>& servers) {
        if (status != 200 || generation <= serverListApplied_ || !auth_->isValid() || token != auth_->session()) return;
        serverListApplied_ = generation;
        QJsonArray list;
        for (const auto& server : servers)
            list.append(QJsonObject{{"id", server.id}, {"name", server.name}, {"owned", server.ownerAccountId == auth_->id()}});
        // Checked against the NEW list (the e2e test caught the old-list check). With the selected server gone (or none
        // yet), show the first one; with no server at all, none. A call on another server stays up (18/10: leaving the
        // viewed server moved the main connection and dropped the call), and a deleted call server is left.
        const bool inCall = !session_.value("connectedChannelId").toString().isEmpty();
        const auto plan = HubApi::planServerList(servers, session_.value("selectedServerId").toString(), callServerId_, inCall);
        QJsonObject changes{{"servers", list}};
        if (plan.selectionChanged) {
            changes.insert("selectedServerId", plan.selected);
            changes.insert("selectedChannelId", plan.showCallServer ? session_.value("connectedChannelId") : QJsonValue());
            if (!plan.selected.isEmpty()) QSettings().setValue("lastServerId", plan.selected);
        }
        patch(changes);
        if (plan.leaveCall) leaveVoice();
        if (plan.showCallServer) { closeBrowse(); publishCategories(); }
        else if (plan.reconnect) connectSignaling();
    });
}

void CoreSession::patch(const QJsonObject& changes) {
    const int base = revision_;
    const auto previousCall = session_.value("connectedChannelId");
    for (auto it = changes.begin(); it != changes.end(); ++it) {
        if (it.value().isNull()) session_.remove(it.key()); else session_.insert(it.key(), it.value());
    }
    ++revision_;
    auto delta = message("delta");
    delta.insert("baseRevision", base);
    delta.insert("revision", revision_);
    delta.insert("patch", changes);
    emit this->delta(delta);
    // The popout shows the call it was opened for: leaving it or moving to another room closes the window, as
    // Discord's channel call view does when its channel is no longer the call (module 540462, componentDidUpdate).
    if (changes.contains("connectedChannelId") && changes.value("connectedChannelId") != previousCall) {
        if (session_.value("callPopout").toBool()) setCallPopout(false);
        if (session_.contains("callFocus")) patch({{"callFocus", QJsonValue()}});
    }
}

QJsonObject CoreSession::snapshotMessage() const {
    auto snapshot = message("snapshot");
    snapshot.insert("revision", revision_);
    snapshot.insert("session", session_);
    return snapshot;
}

bool CoreSession::hasServer(const QString& id) const {
    for (const auto& server : session_.value("servers").toArray()) if (server.toObject().value("id").toString() == id) return true;
    return false;
}

bool CoreSession::hasChannel(const QString& id) const {
    // Channel rows belong to the server shown in the sidebar (the browse connection's while another server is viewed).
    for (const auto& room : browsing() ? browseRooms_ : rooms_) if (room.toObject().value("id").toString() == id) return true;
    return false;
}

// Share picker captions (SHARE.md): monitors are "Tela 1", "Tela 2"... in enumeration order; windows show their title.
QString CoreSession::shareSourceName(int index) const {
    if (index < 0 || index >= shareSources_.size()) return {};
    const auto& source = shareSources_[index];
    if (source.kind != CaptureSource::Kind::Monitor) return source.name.mid(QStringLiteral("Janela — ").size());
    int number = 0;
    for (int i = 0; i <= index; ++i) if (shareSources_[i].kind == CaptureSource::Kind::Monitor) ++number;
    return QString("Tela %1").arg(number);
}
QString CoreSession::displayNameOf(const QString& socketId) const {
    if (socketId == kLocal || socketId == signaling_->socketId()) return accountJson().value("displayName").toString();
    for (const auto& room : rooms_)
        for (const auto& u : room.toObject().value("users").toArray())
            if (u.toObject().value("socketId").toString() == socketId) return u.toObject().value("username").toString().left(64);
    return {};
}

bool CoreSession::canControlPeer(const QString& socketId) const {
    if (socketId.isEmpty() || socketId == signaling_->socketId()) return false;
    const auto connected = session_.value("connectedChannelId").toString();
    if (connected.isEmpty()) return false;
    for (const auto& value : rooms_) {
        const auto room = value.toObject();
        if (room.value("id").toString() != connected) continue;
        for (const auto& user : room.value("users").toArray())
            if (user.toObject().value("socketId").toString() == socketId) return true;
    }
    return false;
}
void CoreSession::applyStreamAudio(const QString& socketId) {
    if (!media_.screen || !peerAudio_.contains(socketId)) return;
    const auto audio = peerAudio_.value(socketId);
    media_.screen->setStreamVolume(socketId, audio.streamVolume / 100.f);
    media_.screen->setStreamMuted(socketId, audio.streamMuted);
}
QString CoreSession::peerAudioSettingsKey(const QString& socketId) const {
    const auto account = participant(socketId).value("userId").toString();
    if (!auth_->isValid() || auth_->id().isEmpty() || account.isEmpty()) return {};
    // Stable, server-verified accounts; never persist by nickname or socket ID.
    return "peerAudio/" + QString::fromLatin1(auth_->id().toUtf8().toHex()) + "/"
        + QString::fromLatin1(account.toUtf8().toHex());
}
void CoreSession::restorePeerAudio(const QString& socketId) {
    if (peerAudio_.contains(socketId) || !canControlPeer(socketId)) return;
    PeerAudio audio;
    const auto key = peerAudioSettingsKey(socketId);
    if (!key.isEmpty()) {
        QSettings settings; settings.beginGroup(key);
        audio.volume = std::clamp(settings.value("volume", 100).toInt(), 0, 200);
        audio.pan = std::clamp(settings.value("pan", 0).toInt(), -100, 100);
        audio.muted = settings.value("muted", false).toBool();
        audio.streamVolume = std::clamp(settings.value("streamVolume", 100).toInt(), 0, 200);
        audio.streamMuted = settings.value("streamMuted", false).toBool();
    }
    peerAudio_.insert(socketId, audio);
    voice_->setPeerVolume(socketId, audio.volume / 100.f);
    voice_->setPeerPan(socketId, audio.pan / 100.f);
    voice_->setPeerMuted(socketId, audio.muted);
    applyStreamAudio(socketId);
}
void CoreSession::savePeerAudio(const QString& socketId) {
    const auto key = peerAudioSettingsKey(socketId);
    if (key.isEmpty() || !peerAudio_.contains(socketId)) return;
    const auto audio = peerAudio_.value(socketId);
    QSettings settings; settings.beginGroup(key);
    settings.setValue("volume", audio.volume); settings.setValue("pan", audio.pan);
    settings.setValue("muted", audio.muted); settings.setValue("streamVolume", audio.streamVolume);
    settings.setValue("streamMuted", audio.streamMuted);
}

bool CoreSession::canModerate(const QString& socketId) const {
    const auto self = signaling_->socketId();
    const auto connected = session_.value("connectedChannelId").toString();
    if (socketId.isEmpty() || self.isEmpty() || connected.isEmpty()) return false;
    for (const auto& value : rooms_) {
        const auto room = value.toObject();
        if (room.value("id").toString() != connected) continue;
        bool owner = false, present = false;
        for (const auto& u : room.value("users").toArray()) {
            const auto user = u.toObject();
            if (user.value("socketId").toString() == self) owner = !room.value("ownerUserId").toString().isEmpty() && user.value("userId") == room.value("ownerUserId");
            if (user.value("socketId").toString() == socketId) present = true;
        }
        return owner && present;
    }
    return false;
}

void CoreSession::publishCategories() {
    for (auto it = peerAudio_.begin(); it != peerAudio_.end(); ) {
        if (!canControlPeer(it.key())) it = peerAudio_.erase(it); else ++it;
    }
    // Restore the active call even while the sidebar browses another server.
    for (const auto& room : rooms_)
        for (const auto& user : room.toObject().value("users").toArray())
            restorePeerAudio(user.toObject().value("socketId").toString());
    const auto self = signaling_->socketId();
    if (!participantSocket_.isEmpty() && participant(participantSocket_).value("userId").toString() != participantAccount_) clearParticipantProfile();
    QStringList prefetch;
    auto toChannel = [&](const QJsonObject& room) {
        QJsonArray users;
        QString ownerId;   // socket of the room owner (the hub's ownerUserId), who may moderate
        for (const auto& u : room.value("users").toArray()) {
            const auto user = u.toObject();
            const auto id = user.value("socketId").toString(user.value("userId").toString());
            if (!room.value("ownerUserId").toString().isEmpty() && user.value("userId") == room.value("ownerUserId")) ownerId = id;
            const auto audio = peerAudio_.value(id);
            const bool camera = streams_.contains("cam:" + (id == self ? kLocal : id));
            const bool live = streams_.contains("scr:" + (id == self ? kLocal : id));
            const auto account = user.value("userId").toString();
            if (id != self && user.value("authenticated").toBool() && !account.isEmpty() && !avatarRequested_.contains(account)) prefetch.append(account);
            users.append(QJsonObject{{"id", id}, {"name", user.value("username").toString().left(64)}, {"self", id == self}, {"profileAvailable", user.value("authenticated").toBool()}, {"avatarUrl", id == self ? accountAvatarData_ : user.value("authenticated").toBool() ? participantAvatars_.value(account) : QString()},
                                     {"accountId", user.value("authenticated").toBool() ? account : QString()},
                                     {"localMuted", audio.muted}, {"volume", audio.volume}, {"pan", audio.pan},
                                     {"streamVolume", audio.streamVolume}, {"streamMuted", audio.streamMuted},
                                     {"muted", user.value("isMuted").toBool()}, {"deafened", user.value("isDeafened").toBool()},
                                     {"customStatus", user.value("status").toString().left(64)}, {"speaking", speaking_.contains(id)}, {"camera", camera}, {"live", live},
                                     {"serverMuted", user.value("isServerMuted").toBool()}});
        }
        QJsonObject channel{{"id", room.value("id").toString()}, {"name", room.value("name").toString().left(64)}, {"kind", "voice"}, {"users", users}};
        if (!ownerId.isEmpty()) channel.insert("ownerId", ownerId);
        return channel;
    };
    // The hub lists rooms in its map order, which changes when a room is saved again (joining moved "Jogos" above
    // "Geral", audit 18/10); Discord keeps channel positions. Keep the order in which each room was first seen.
    const auto server = session_.value("selectedServerId").toString();
    QList<QJsonObject> shown;
    for (const auto& value : browsing() ? browseRooms_ : rooms_) {
        const auto key = server + "/" + value.toObject().value("id").toString();
        if (!roomOrder_.contains(key)) roomOrder_.insert(key, roomOrder_.size());
        shown.append(value.toObject());
    }
    std::stable_sort(shown.begin(), shown.end(), [&](const QJsonObject& a, const QJsonObject& b) {
        return roomOrder_.value(server + "/" + a.value("id").toString()) < roomOrder_.value(server + "/" + b.value("id").toString());
    });
    QJsonArray channels;
    for (const auto& room : shown) channels.append(toChannel(room));
    // The call's channel, from the call's own connection: the voice panel and the call keep working while another
    // server is shown in the sidebar.
    QJsonValue callChannel;
    for (const auto& value : rooms_)
        if (value.toObject().value("id") == session_.value("connectedChannelId")) callChannel = toChannel(value.toObject());
    patch({{"categories", QJsonArray{QJsonObject{{"id", "voice"}, {"name", "Canais de Voz"}, {"channels", channels}}}}, {"callChannel", callChannel}});
    for (const auto& account : prefetch) QTimer::singleShot(0, this, [this, account] { prefetchAvatar(account); });
}

void CoreSession::publishStreams() {
    QJsonArray list;
    for (auto it = streams_.cbegin(); it != streams_.cend(); ++it) {
        const auto owner = it->ownerId;
        emit videoLabel(it.key(), displayNameOf(owner));
        const bool ownShare = it->kind == "screen" && owner == kLocal;
        emit videoLive(it.key(), it->kind == "screen", ownShare ? QSettings().value("shareFps", 30).toInt() : 0,
                       ownShare ? QSettings().value("shareResolution", 720).toInt() : 0);
        list.append(QJsonObject{{"id", it.key()}, {"kind", it->kind}, {"ownerId", owner == kLocal ? signaling_->socketId() : owner},
                                {"title", displayNameOf(owner)}, {"width", it->size.width()}, {"height", it->size.height()},
                                {"path", "native-overlay"}, {"loading", !it->hasFrame}, {"hidden", hiddenStreams_.contains(it.key())}});
    }
    patch({{"streams", list}});
    publishCategories();   // camera / live markers on the participant rows
}

void CoreSession::addStreamFrame(const QString& streamId, const QString& ownerId, const QString& kind, const QImage& image) {
    if (image.isNull() || session_.value("connectedChannelId").toString().isEmpty()) return;
    if (ownerId != kLocal && !canControlPeer(ownerId)) return;
    if (ownerId == kLocal && kind == "camera" && !cameraWanted_) return;
    const bool known = streams_.contains(streamId);
    auto& stream = streams_[streamId];
    if (!known || !stream.hasFrame || stream.size != image.size()) {
        stream.ownerId = ownerId; stream.kind = kind; stream.size = image.size(); stream.hasFrame = true;
        publishStreams();
        if (!known && kind == "screen" && ownerId != kLocal) applyStreamAudio(ownerId);   // settings made before it started
    }
    if (!hiddenStreams_.contains(streamId)) emit videoFrame(streamId, image);
}

void CoreSession::removeStream(const QString& streamId) {
    if (!streams_.remove(streamId)) return;
    hiddenStreams_.remove(streamId);
    emit videoRemoved(streamId);
    publishStreams();
}

QString CoreSession::validateCommand(const QJsonObject& command) const {
    const auto name = command.value("name").toString();
    const auto& allowed = commandFields();
    if (!allowed.contains(name)) return "unknown_command";
    for (auto it = command.begin(); it != command.end(); ++it)
        if (it.key() != "name" && !allowed.value(name).contains(it.key())) return "unexpected_field";
    auto string = [&](const char* key, int max) { const auto v = command.value(key); return v.isString() && v.toString().size() <= max; };
    if (QStringList{"startCameraPreview","keepCameraPreview","stopCameraPreview"}.contains(name)) {
        if (!string("previewId",64) || !QRegularExpression("^[A-Za-z0-9-]{1,64}$").match(command.value("previewId").toString()).hasMatch()) return "invalid_preview";
        if (name == "startCameraPreview" && session_.value("cameraPending").toBool()) return "camera_busy";
        return name == "startCameraPreview" && (!auth_->isValid() || !media_.camera) ? QString("unavailable") : QString();
    }
    const bool profileCommand = QStringList{"getOwnProfile", "saveOwnProfile", "beginProfileMedia", "appendProfileMedia", "finishProfileMedia", "cancelProfileMedia", "removeProfileMedia"}.contains(name);
    if (profileCommand) {
        if (!auth_->isValid()) return "signed_out";
        if (profileMediaBusy_ && (name == "beginProfileMedia" || name == "finishProfileMedia" || name == "removeProfileMedia")) return "media_busy";
        if (name == "getOwnProfile") return {};
        if (name == "saveOwnProfile") {
            if (!command.value("fields").isObject()) return "invalid_fields";
            const auto fields = command.value("fields").toObject();
            const QHash<QString, int> text{{"display_name",32},{"pronouns",40},{"bio",190},{"note",256}};
            for (auto it = fields.begin(); it != fields.end(); ++it) {
                if (text.contains(it.key())) { if (!it.value().isNull() && (!it.value().isString() || it.value().toString().size() > text[it.key()])) return "invalid_field"; }
                else if (QStringList{"banner_color","profile_theme_start","profile_theme_end"}.contains(it.key())) {
                    if (!it.value().isNull() && (!it.value().isString() || !QRegularExpression("^#[0-9a-fA-F]{6}$").match(it.value().toString()).hasMatch())) return "invalid_color";
                } else return "unknown_field";
            }
            return {};
        }
        if (name == "removeProfileMedia" || name == "beginProfileMedia") {
            const auto kind = command.value("kind").toString(); if (kind != "avatar" && kind != "banner") return "invalid_kind";
            if (name == "removeProfileMedia") return {};
            const auto size = command.value("size"); const int max = kind == "avatar" ? 524288 : 1048576;
            return size.isDouble() && size.toDouble() == size.toInt() && size.toInt() > 0 && size.toInt() <= max ? QString() : "invalid_size";
        }
        if (!string("uploadId",64) || upload_.id.isEmpty() || command.value("uploadId").toString() != upload_.id) return "stale_upload";
        if (name == "appendProfileMedia") {
            const auto offset = command.value("offset");
            return offset.isDouble() && offset.toDouble() == upload_.bytes.size() && string("data",32768) ? QString() : "invalid_chunk";
        }
        return {};
    }
    if (name == "playSound" || name == "previewSound")
        return string("soundId", 64) && SoundPlayer::contains(command.value("soundId").toString()) ? QString() : "unknown_sound";
    if (name == "selectServer" || name == "createInvite" || name == "deleteServer" || name == "leaveServer")
        return string("serverId", 64) && hasServer(command.value("serverId").toString()) ? QString() : "unknown_server";
    if (name == "selectChannel" || name == "joinVoice")
        return string("channelId", 128) && hasChannel(command.value("channelId").toString()) ? QString() : "unknown_channel";
    // Chat (hub limits, server/sanitize.js): text up to 2000 characters after trimming, six reactions; only our
    // own messages can be deleted and only messages of the room we are in can be touched.
    if (name == "sendChatMessage") {
        const auto text = command.value("text").toString().trimmed();
        return command.value("text").isString() && !text.isEmpty() && text.size() <= 2000 ? QString() : "invalid_text";
    }
    if (name == "openChatLink") {
        if (!string("messageId", 128) || !string("url", 2000)) return "invalid_link";
        for (const auto& value : chat_) {
            const auto m = value.toObject();
            if (m.value("id").toString() == command.value("messageId").toString())
                return markdownHasWebLink(parseDiscordMarkdown(m.value("text").toString()), command.value("url").toString()) ? QString() : "invalid_link";
        }
        return "unknown_message";
    }
    if (name == "deleteChatMessage" || name == "toggleReaction" || name == "copyMessageText") {
        const auto id = command.value("messageId").toString();
        QJsonObject found;
        for (const auto& m : chat_) if (m.toObject().value("id").toString() == id) { found = m.toObject(); break; }
        if (!command.value("messageId").isString() || found.isEmpty()) return "unknown_message";
        if (name == "deleteChatMessage") return found.value("senderUserId").toString() == hubUserId() ? QString() : "not_owner";
        if (name == "copyMessageText") return QString();
        static const QSet<QString> reactions{QString::fromUtf8("\U0001F44D"), QString::fromUtf8("\u2764\uFE0F"), QString::fromUtf8("\U0001F602"),
                                             QString::fromUtf8("\U0001F62E"), QString::fromUtf8("\U0001F622"), QString::fromUtf8("\U0001F389")};
        return reactions.contains(command.value("emoji").toString()) ? QString() : "invalid_emoji";
    }
    // Settings (same QSettings keys and ranges as the Qt client's settings page, main_window.cpp).
    if (name == "setSetting") {
        const auto key = command.value("key").toString();
        const auto value = command.value("value");
        auto known = [&](const QJsonArray& list) {
            if (!value.isString()) return false;
            if (value.toString().isEmpty()) return true;
            for (const auto& d : list) if (d.toObject().value("id").toString() == value.toString()) return true;
            return false;
        };
        if (key == "inputDevice") return known(inputDevices_) ? QString() : "unknown_device";
        if (key == "outputDevice") return known(outputDevices_) ? QString() : "unknown_device";
        if (key == "cameraDevice") return known(cameraDevices_) ? QString() : "unknown_device";
        if (key == "inputVolume") return value.isDouble() && value.toInt() >= 0 && value.toInt() <= 100 ? QString() : "invalid_value";
        if (key == "outputVolume") return value.isDouble() && value.toInt() >= 0 && value.toInt() <= 200 ? QString() : "invalid_value";
        if (key == "noiseSuppressionStrength") return value.isDouble() && value.toDouble() >= 0 && value.toDouble() <= 100 && value.toDouble() == value.toInt() ? QString() : "invalid_value";
        if (key == "noiseSuppression" || key == "automaticGainControl") return value.isBool() ? QString() : "invalid_value";
        if (key == "noiseSuppressionMode") return value.toString() == "standard" || value.toString() == "high" ? QString() : "invalid_value";
        if (key == "desktopNotifications" || key == "taskbarAlert" || key == "callSounds") return value.isBool() ? QString() : "invalid_value";
        if (key == "closeToTray" || key == "startMinimized") return value.isBool() ? QString() : "invalid_value";
        if (key == "errorReports") return value.isBool() ? QString() : "invalid_value";
        if (key == "openAtLogin") return !value.isBool() ? "invalid_value" : loginSupported() ? QString() : "unsupported";
        if (key == "soundboardVolume") return value.isDouble() && value.toInt() >= 0 && value.toInt() <= 100 ? QString() : "invalid_value";
        if (key == "theme") return QStringList{"light", "dark", "darker", "midnight", "cotton-candy"}.contains(value.toString()) ? QString() : "invalid_value";
        // Share picker's stream mode block (same keys as the Qt picker): mode, SD/HD, system audio.
        if (key == "shareMode") return value.toString() == "game" || value.toString() == "screen" ? QString() : "invalid_value";
        if (key == "shareHd" || key == "shareAudio") return value.isBool() ? QString() : "invalid_value";
        return "unknown_setting";
    }
    if (name == "copyInvite")
        return command.value("code").isString() && invites_.contains(command.value("code").toString()) ? QString() : "unknown_invite";
    if (name == "createChannel") {
        const auto text = command.value("channelName").toString().trimmed();
        return command.value("channelName").isString() && !text.isEmpty() && text.size() <= kMaxNameLength ? QString() : "invalid_name";
    }
    if (name == "setNick") {
        const auto nick = command.value("nick").toString().trimmed();
        return command.value("nick").isString() && nick.size() >= 2 && nick.size() <= 32 ? QString() : "invalid_nick";
    }
    if (name == "createServer") {
        const auto text = command.value("serverName").toString().trimmed();
        return command.value("serverName").isString() && !text.isEmpty() && text.size() <= kMaxNameLength ? QString() : "invalid_name";
    }
    // Nick sign-in: the password is optional for a new account (set later in Minha conta), 6-128 characters.
    if (name == "signInNick") {
        const auto nick = command.value("nick").toString().trimmed();
        const auto password = command.value("password");
        if (!command.value("nick").isString() || nick.size() < 2 || nick.size() > 32) return "invalid_nick";
        if (!password.isUndefined() && (!password.isString() || (!password.toString().isEmpty() && (password.toString().size() < 6 || password.toString().size() > 128))))
            return "invalid_password";
        return {};
    }
    if (name == "setPassword") {
        const auto password = command.value("password").toString();
        const auto current = command.value("currentPassword");
        if (!command.value("password").isString() || password.size() < 6 || password.size() > 128) return "invalid_password";
        if (!current.isUndefined() && (!current.isString() || current.toString().size() > 128)) return "invalid_password";
    }
    if (name == "acceptInvite") return string("invite", 256) ? QString() : "invalid_value";
    // Everything but the sign-in steps needs a session.
    if (name != "requestSnapshot" && name != "signIn" && name != "signInNick" && name != "setNick" && name != "window" && name != "requestDevices" && !auth_->isValid()) return "signed_out";
    if (name == "getParticipantProfile") return string("socketId",128) && !participant(command.value("socketId").toString()).isEmpty() ? QString() : "unknown_participant";
    if (name == "setCallFullscreen") {
        if (!command.value("on").isBool()) return "invalid_value";
        const auto connected = session_.value("connectedChannelId").toString();
        return !command.value("on").toBool() || (!connected.isEmpty() && session_.value("selectedChannelId").toString() == connected) ? QString() : "not_in_call";
    }
    // Popout: opened only from a call (Discord shows the button in a call with video; the UI checks that part);
    // "Mostrar sempre" only while the popout exists.
    if (name == "setCallPopout")
        return command.value("on").isBool() && (!command.value("on").toBool() || !session_.value("connectedChannelId").toString().isEmpty()) ? QString() : "not_in_call";
    if (name == "setCallPopoutOnTop") return command.value("on").isBool() && session_.value("callPopout").toBool() ? QString() : "no_popout";
    if (name == "setStreamHidden") return command.value("hidden").isBool() && string("streamId",128) && streams_.contains(command.value("streamId").toString()) ? QString() : "invalid_stream";
    // "Silenciar voz na sala" may also target ourselves (Discord's voice-mute does); "Desconectar" never does.
    if (name == "setServerMuted")
        return string("socketId", 128) && command.value("muted").isBool() && canModerate(command.value("socketId").toString()) ? QString() : "not_owner";
    if (name == "disconnectParticipant")
        return string("socketId", 128) && command.value("socketId").toString() != signaling_->socketId() && canModerate(command.value("socketId").toString()) ? QString() : "not_owner";
    if (name == "setPeerAudio") {
        if (!string("socketId",128) || !canControlPeer(command.value("socketId").toString())) return "not_in_call";
        if (!command.contains("volume") && !command.contains("pan") && !command.contains("muted") && !command.contains("streamVolume") && !command.contains("streamMuted"))
            return "empty_settings";
        for (const char* key : {"volume", "pan", "streamVolume"}) {
            if (!command.contains(key)) continue;
            const auto value = command.value(key); const bool pan = QString::fromLatin1(key) == "pan";
            if (!value.isDouble() || value.toDouble() != value.toInt() || value.toInt() < (pan ? -100 : 0) || value.toInt() > (pan ? 100 : 200)) return "invalid_value";
        }
        for (const char* key : {"muted", "streamMuted"})
            if (command.contains(key) && !command.value(key).isBool()) return "invalid_value";
        return {};
    }
    if (name == "setCustomStatus") return string("text", 64) && !QRegularExpression("[\\x00-\\x1f\\x7f]").match(command.value("text").toString()).hasMatch() ? QString() : "invalid_status";
    if (name == "setMuted") {
        if (!command.value("muted").isBool()) return "invalid_value";
        if (!command.value("muted").toBool() && participant(signaling_->socketId()).value("isServerMuted").toBool()) return "server_muted";
        return {};
    }
    if (name == "setDeafened") return command.value("deafened").isBool() ? QString() : "invalid_value";
    if (name == "setCamera") return command.value("on").isBool() && media_.camera ? QString() : "invalid_value";
    if (name == "startDeviceShare") {
        const auto id = command.value("deviceId").toString();
        if (!media_.screen || !command.value("deviceId").isString() || id.isEmpty()) return "unknown_device";
        for (const auto& d : cameraDevices_) if (d.toObject().value("id").toString() == id) return {};
        return "unknown_device";
    }
    if (name == "startScreenShare") {
        const int index = command.value("index").toInt(-1);
        return media_.screen && string("generation", 20) && command.value("generation").toString() == QString::number(thumbnailGeneration_)
                   && index >= 0 && index < shareSources_.size() ? QString() : "stale_source";
    }
    if (name == "videoIdle") return command.value("idle").isBool() ? QString() : "invalid_value";
    // Visão ampliada state, kept by the core so every window shows the same focus (Discord's popout opened on the card
    // focused in the main window, observed 17/10): the card key (stream id or participant id) or null, and the filmstrip.
    if (name == "setCallFocus") {
        const auto key = command.value("key");
        return (key.isNull() || (key.isString() && key.toString().size() <= 128)) && command.value("filmOpen").isBool()
                   && !session_.value("connectedChannelId").toString().isEmpty() ? QString() : "invalid_value";
    }
    if (name == "videoRole")
        return string("streamId", 128) && QStringList{"grid", "stage", "film"}.contains(command.value("role").toString()) ? QString() : "invalid_value";
    if (name == "videoOccluders" || name == "videoStageOccluders") {
        const auto rects = command.value("rects");
        if (!rects.isArray() || rects.toArray().size() > 8) return "invalid_value";
        for (const auto& value : rects.toArray()) {
            const auto rect = value.toObject();
            if (!value.isObject() || rect.size() != 4) return "invalid_value";
            for (const char* key : {"x", "y", "width", "height"})
                if (!rect.value(key).isDouble() || rect.value(key).toInt() < -10000 || rect.value(key).toInt() > 10000) return "invalid_value";
        }
        return {};
    }
    if (name == "videoSurface") {
        const auto rect = command.value("rect").toObject();
        for (const char* key : {"x", "y", "width", "height"})
            if (!rect.value(key).isDouble() || rect.value(key).toInt() < -10000 || rect.value(key).toInt() > 10000) return "invalid_value";
        return string("streamId", 128) && command.value("scale").isDouble() ? QString() : "invalid_value";
    }
    if (name == "openAudioMenu") { const auto d = command.value("device").toString(); return d == "input" || d == "output" ? QString() : "invalid_value"; }
    // move / resize-*: the frameless popout window's own bar and edges (Qt startSystemMove/startSystemResize).
    if (name == "window") {
        static const QStringList actions{"minimize", "maximize", "close", "move", "resize-n", "resize-s", "resize-e", "resize-w",
                                         "resize-ne", "resize-nw", "resize-se", "resize-sw"};
        return actions.contains(command.value("action").toString()) ? QString() : "invalid_value";
    }
    return {};
}

QJsonObject CoreSession::error(const QString& requestId, const QString& code, const QString& text) const {
    auto result = message("result");
    result.insert("requestId", requestId);
    result.insert("ok", false);
    result.insert("error", QJsonObject{{"code", code}, {"message", text}});
    return result;
}

void CoreSession::stopCameraPreview(const QString& reason) {
    const auto id = previewId_;
    previewId_.clear(); previewTimer_.stop(); previewLease_.stop();
    previewImage_ = {}; previewFrame_ = {}; previewUsesPublished_ = false;
    // Destruction waits for the capture worker to release the device before publishing can start.
    delete previewCapture_; previewCapture_ = nullptr;
    if (!id.isEmpty()) emit event({{"v",kProtocolVersion},{"type","event"},{"name","cameraPreviewClosed"},
                                  {"previewId",id},{"reason",reason}});
}

void CoreSession::startCameraPreview(const QString& id) {
    if (id == previewId_) { previewLease_.start(); return; }
    stopCameraPreview("A prévia foi aberta em outra janela.");
    previewId_ = id; previewUsesPublished_ = session_.value("camera").toBool();
    previewLease_.start(); previewTimer_.start();
    if (previewUsesPublished_ || media_.syntheticCamera) return;
    previewCapture_ = new CameraService(this);
    connect(previewCapture_, &CameraService::frameReady, this, [this](const QVideoFrame& frame) { previewFrame_ = frame; });
    connect(previewCapture_, &CameraService::message, this, [this](const QString& text) {
        // Defer deletion: the service is still dispatching this signal.
        const auto id = previewId_;
        QTimer::singleShot(0,this,[this,id,text] { if (previewId_ == id) stopCameraPreview(text); });
    });
    previewCapture_->start(QSettings().value("cameraDevice").toByteArray());
}

void CoreSession::clearCameraIntent() {
    cameraWanted_ = false; cameraStarting_ = false; cameraStartDeadline_.stop(); syntheticCamera_.stop();
    if (session_.value("cameraPending").toBool()) patch({{"cameraPending",false}});
}
void CoreSession::startCameraIfReady() {
    if (!media_.camera || !cameraWanted_ || !cameraReady_ || cameraStarting_ || session_.value("camera").toBool()
        || session_.value("connectedChannelId").toString().isEmpty()) return;
    cameraStarting_ = true;
    media_.camera->start(media_.syntheticCamera ? QByteArray() : QSettings().value("cameraDevice").toByteArray());
}
void CoreSession::leaveVoice() {
    stopCameraPreview();
    finishSoundRequest("Você saiu da chamada antes de confirmar o som.");
    cameraReady_ = false; clearCameraIntent();
    if (session_.value("callFullscreen").toBool()) emit windowAction("exitCallFullscreen");
    hiddenStreams_.clear();
    sounds_->stop(); peerAudio_.clear();
    rejoin_.channel.clear();   // leaving on purpose (or moving to another server) cancels a pending rejoin
    if (session_.value("connectedChannelId").toString().isEmpty()) return;
    QScopedValueRollback<bool> leaving(leavingVoice_, true);
    sounds_->playCue("disconnect");
    signaling_->sendEvent("leave-room", {});
    voice_->leave();
    syntheticCamera_.stop();
    if (media_.screen) media_.screen->leave();
    if (media_.camera) media_.camera->leave();
    for (const auto& id : streams_.keys()) emit videoRemoved(id);
    streams_.clear();
    speaking_.clear();
    chat_ = {};
    patch({{"connectedChannelId", QJsonValue()}, {"streams", QJsonArray{}}, {"camera", false}, {"sharing", false}, {"sharingName", QJsonValue()}, {"connectedAt", QJsonValue()}, {"chat", QJsonArray{}}});
    publishCategories();
}

// The id the hub gives us: the account id when signed in (worker.js join verifies the session), else the local
// userId we sent. Reactions and message authors use it.
QString CoreSession::hubUserId() const { return auth_->isValid() && !auth_->id().isEmpty() ? auth_->id() : userId_; }

void CoreSession::setWindowActive(bool active) {
    background_ = !active || qEnvironmentVariableIsSet("TRISCORD_TEST_BACKGROUND");   // tests: always background
}

// Applies the stored audio choices to the voice engine (and the share audio output), as the Qt client does.
void CoreSession::applyAudioSettings() {
    QSettings settings;
    const auto input = settings.value("audioInput").toString(), output = settings.value("audioOutput").toString();
    voice_->setDevices(QByteArray::fromHex(input.toLatin1()), QByteArray::fromHex(output.toLatin1()));
    sounds_->setOutput(QByteArray::fromHex(output.toLatin1()));
    sounds_->refreshSettings();
    voice_->setInputGain(sliderToGain(settings.value("audioInputVolume", 100).toInt()));
    voice_->setOutputGain(sliderToGain(settings.value("audioOutputVolume", 100).toInt()));
    voice_->setProcessing(settings.value("noiseSuppression", true).toBool(), false, settings.value("automaticGainControl", true).toBool(),
        settings.value("noiseSuppressionMode", "high").toString() == "high",
        std::clamp(settings.value("noiseSuppressionStrength", 100).toInt(), 0, 100));
    if (media_.screen) {
        media_.screen->setAudioOutput(QByteArray::fromHex(output.toLatin1()));
        media_.screen->setOutputGain(sliderToGain(settings.value("audioOutputVolume", 100).toInt()));
    }
}

// Settings for the UI: device lists, current choices and values (ids are hex strings; '' = Windows default).
void CoreSession::publishSettings() {
    QSettings settings;
    patch({{"settings", QJsonObject{
        {"inputDevices", inputDevices_}, {"outputDevices", outputDevices_}, {"cameraDevices", cameraDevices_},
        {"inputDevice", settings.value("audioInput").toString()}, {"outputDevice", settings.value("audioOutput").toString()},
        {"cameraDevice", QString::fromLatin1(settings.value("cameraDevice").toByteArray().toHex())},
        {"inputVolume", settings.value("audioInputVolume", 100).toInt()}, {"outputVolume", settings.value("audioOutputVolume", 100).toInt()},
        {"noiseSuppression", settings.value("noiseSuppression", true).toBool()},
        // "Alta qualidade" (DeepFilterNet 3) by default; the client falls back to "Padrão" (RNNoise) without it.
        {"noiseSuppressionMode", settings.value("noiseSuppressionMode", "high").toString() == "standard" ? "standard" : "high"},
        {"noiseSuppressionHighAvailable", DeepFilter::available()},
        {"noiseSuppressionStrength", std::clamp(settings.value("noiseSuppressionStrength", 100).toInt(), 0, 100)},
        {"automaticGainControl", settings.value("automaticGainControl", true).toBool()},
        {"callSounds", settings.value("callSounds", true).toBool()},
        {"soundboardVolume", std::clamp(settings.value("soundboardVolume", 70).toInt(), 0, 100)},
        {"desktopNotifications", settings.value("desktopNotifications", true).toBool()},
        {"taskbarAlert", settings.value("taskbarAlert", true).toBool()},
        {"closeToTray", WindowPrefs::load(settings).closeToTray},
        {"startMinimized", WindowPrefs::load(settings).startMinimized},
        {"openAtLogin", loginEnabled()},
        {"loginSupported", loginSupported()},
        // Error reports (error_reports.h): on by default.
        {"errorReports", settings.value("errorReports", true).toBool()},
        {"errorReportsAvailable", reporter_->hasLog()},
        {"shareMode", settings.value("shareMode", "game").toString() == "screen" ? "screen" : "game"},
        {"shareHd", settings.value("shareResolution", 720).toInt() >= 1080},
        {"shareAudio", settings.value("shareSystemAudio", false).toBool()},
        // Theme default: Discord's for an account with no preference, "Escuro" (ThemeStore: UNSET -> NJ8.DARK = theme-darker).
        {"theme", settings.value("webTheme", "darker").toString()}}}});
}

// Chat for the UI: hub messages reduced to what the panel shows; reactions as {emoji, count, me}.
void CoreSession::publishChat() {
    // Bounded by encoded tree bytes; reaction/presence updates reuse the existing parse.
    static QCache<QString, QJsonArray> markdownCache(512 * 1024);
    const auto me = hubUserId();
    QJsonArray list;
    for (const auto& value : chat_) {
        const auto m = value.toObject();
        QJsonArray reactions;
        const auto byEmoji = m.value("reactions").toObject();
        for (auto it = byEmoji.begin(); it != byEmoji.end(); ++it) {
            const auto users = it.value().toArray();
            reactions.append(QJsonObject{{"emoji", it.key()}, {"count", users.size()}, {"me", users.contains(QJsonValue(me))}});
        }
        const auto text = m.value("text").toString();
        const auto cached = markdownCache.object(text);
        const auto markdown = cached ? *cached : discordMarkdownForWeb(text);
        if (!cached) markdownCache.insert(text, new QJsonArray(markdown), qMax(1, int(QJsonDocument(markdown).toJson(QJsonDocument::Compact).size())));
        // Chat authors' avatars (18/10: messages showed only the initial). Only account ids (Google or nick).
        static const QRegularExpression accountId("^(\\d{6,32}|n_[0-9a-f]{24})$");
        const auto sender = m.value("senderUserId").toString();
        if (sender != me && !avatarRequested_.contains(sender) && accountId.match(sender).hasMatch())
            QTimer::singleShot(0, this, [this, sender] { prefetchAvatar(sender); });
        list.append(QJsonObject{{"id", m.value("id")}, {"authorId", m.value("senderUserId")}, {"authorName", m.value("senderName")},
                                {"text", m.value("text")}, {"timestamp", m.value("timestamp")}, {"own", m.value("senderUserId").toString() == me},
                                {"reactions", reactions}, {"markdown", markdown}});
    }
    patch({{"chat", list}});
}

QJsonObject CoreSession::handleMessage(const QJsonObject& incoming) {
    const auto requestId = incoming.value("requestId").toString().left(64);
    if (incoming.value("v").toInt() != kProtocolVersion || incoming.value("type").toString() != "command" || !incoming.value("command").isObject())
        return error(requestId, "bad_message", "Mensagem inválida.");
    const auto command = incoming.value("command").toObject();
    if (const auto problem = validateCommand(command); !problem.isEmpty()) return error(requestId, problem, "Comando recusado.");
    const auto name = command.value("name").toString();
    QJsonValue value;

    if (name == "startCameraPreview") { startCameraPreview(command.value("previewId").toString()); return ok(requestId); }
    if (name == "keepCameraPreview") { if (command.value("previewId").toString() == previewId_) previewLease_.start(); return ok(requestId); }
    if (name == "stopCameraPreview") { if (command.value("previewId").toString() == previewId_) stopCameraPreview(); return ok(requestId); }
    if (name == "getParticipantProfile") { loadParticipantProfile(command.value("socketId").toString(),requestId); return {}; }
    if (name == "closeParticipantProfile") { clearParticipantProfile(); return ok(requestId); }
    if (name == "getOwnProfile") { loadOwnProfile(requestId); return {}; }
    if (name == "saveOwnProfile") {
        const auto token = auth_->session();
        QNetworkRequest request(QUrl(authServerUrl() + "/profile")); request.setTransferTimeout(15000);
        request.setRawHeader("Authorization", "Bearer " + token.toUtf8()); request.setHeader(QNetworkRequest::ContentTypeHeader,"application/json");
        auto* reply = network_.sendCustomRequest(request,"PATCH",QJsonDocument(command.value("fields").toObject()).toJson(QJsonDocument::Compact));
        connect(reply, &QNetworkReply::finished, this, [this, reply, token, requestId] {
            reply->deleteLater();
            const auto account = QJsonDocument::fromJson(reply->readAll()).object().value("account").toObject();
            if (token != auth_->session()) { emit this->reply(error(requestId,"stale_session","A sessão mudou.")); return; }
            if (reply->error() != QNetworkReply::NoError || account.isEmpty()) { emit this->reply(error(requestId,"save_failed","Não foi possível salvar o perfil. Tente novamente.")); return; }
            applyOwnProfile(account); emit this->reply(ok(requestId,ownProfileJson()));
        }); return {};
    }
    if (name == "beginProfileMedia") {
        upload_ = {QUuid::createUuid().toString(QUuid::WithoutBraces),command.value("kind").toString(),command.value("size").toInt(),{}};
        uploadDeadline_.start(30000); return ok(requestId,QJsonObject{{"uploadId",upload_.id}});
    }
    if (name == "appendProfileMedia") {
        const auto chunk = QByteArray::fromBase64Encoding(command.value("data").toString().toLatin1(),QByteArray::AbortOnBase64DecodingErrors);
        if (!chunk || chunk.decoded.isEmpty() || upload_.bytes.size()+chunk.decoded.size()>upload_.size) return error(requestId,"invalid_chunk","Arquivo inválido.");
        upload_.bytes += chunk.decoded; uploadDeadline_.start(30000); return ok(requestId);
    }
    if (name == "cancelProfileMedia") { upload_={}; uploadDeadline_.stop(); return ok(requestId); }
    if (name == "finishProfileMedia" || name == "removeProfileMedia") {
        const auto token = auth_->session();
        const auto done = [this,token,requestId](int status,const QJsonObject& account,const QJsonObject&) {
            profileMediaBusy_ = false;
            if (token != auth_->session()) { emit reply(error(requestId,"stale_session","A sessão mudou.")); return; }
            if (status != 200) { emit reply(error(requestId,"media_failed",status==413 ? "Imagem grande demais." : status==415 ? "Use PNG, JPEG ou GIF válido." : "Não foi possível atualizar a imagem.")); return; }
            applyOwnProfile(account); emit reply(ok(requestId,ownProfileJson()));
        };
        const auto kind = (name == "finishProfileMedia" ? upload_.kind : command.value("kind").toString()) == "avatar" ? ProfileMediaKind::Avatar : ProfileMediaKind::Banner;
        if (name == "removeProfileMedia") { profileMediaBusy_ = true; profileMedia_->remove(token,kind,done); }
        else {
            if (upload_.bytes.size() != upload_.size) return error(requestId,"incomplete_upload","O arquivo não foi recebido por completo.");
            const auto bytes = upload_.bytes; upload_={}; uploadDeadline_.stop(); profileMediaBusy_ = true; profileMedia_->upload(token,kind,bytes,done);
        }
        return {};
    }
    if (name == "playSound" || name == "previewSound") {
        if (!auth_->isValid()) return error(requestId, "signed_out", "Entre com o Google primeiro.");
        if (session_.value("deafened").toBool()) return error(requestId, "deafened", "Reative o áudio para ouvir os efeitos sonoros.");
        const auto id = command.value("soundId").toString();
        patch({{"soundboardError", ""}});
        if (name == "previewSound") sounds_->play(id, true);
        else {
            if (!signaling_->ready() || session_.value("connectedChannelId").toString().isEmpty()) return error(requestId, "not_in_call", "Entre numa sala para tocar um som.");
            const auto now = QDateTime::currentMSecsSinceEpoch();
            if (!pendingSoundRequest_.isEmpty()) return error(requestId, "sound_pending", "Aguarde a confirmação do som anterior.");
            if (now - lastSoundRequest_ < 1000) return error(requestId, "rate_limited", "Aguarde antes de tocar outro som.");
            lastSoundRequest_ = now;
            pendingSoundRequest_ = requestId; pendingSoundId_ = id;
            soundAckDeadline_.start(5000);
            signaling_->sendEvent("soundboard-play", {{"soundId", id}});
            return {}; // Resolve only when the hub broadcasts back to the sender as well as its peers.
        }
        return ok(requestId);
    }
    if (name == "stopSoundPreview") { sounds_->stopPreview(); return ok(requestId); }
    if (name == "signIn") {
        if (session_.value("auth").toObject().value("state").toString() == "signingIn") return ok(requestId);
        setAuthState("signingIn");
        auto* flow = new GoogleAuthFlow(this);
        connect(flow, &GoogleAuthFlow::succeeded, this, [this, flow](const GoogleIdentity& identity) {
            flow->deleteLater();
            auth_->setSignedIn(identity.session, identity.id, identity.email, identity.nick, identity.avatarUrl,
                               QDateTime::fromString(identity.expiresAt, Qt::ISODate));
            if (identity.isNew) setAuthState("needsNick", {}, (identity.nick.isEmpty() ? identity.email.section('@', 0, 0) : identity.nick).left(32));
            else startSignedIn();
        });
        connect(flow, &GoogleAuthFlow::failed, this, [this, flow](const QString& reason) {
            flow->deleteLater();
            setAuthState("signedOut", reason == "missing-client-secret" ? QString("Login com Google indisponível: configuração ausente.")
                                    : reason == "cancelled" || reason == "timeout" ? QString("O login não foi concluído. Tente novamente.")
                                    : QString("Não foi possível entrar com o Google. Verifique sua conexão e tente novamente."));
        });
        flow->start();
        return ok(requestId);
    }
    if (name == "signInNick") {
        // POST /auth/nick (cloudflare-auth): a free nick creates the account, a taken one needs its password.
        const auto nick = command.value("nick").toString().trimmed(), password = command.value("password").toString();
        if (session_.value("auth").toObject().value("state").toString() == "signingIn") return error(requestId, "busy", "Aguarde o login em andamento.");
        QNetworkRequest post(QUrl(authServerUrl() + "/auth/nick"));
        post.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        post.setTransferTimeout(15000);
        QJsonObject body{{"nick", nick}};
        if (!password.isEmpty()) body.insert("password", password);
        auto* answer = network_.post(post, QJsonDocument(body).toJson(QJsonDocument::Compact));
        connect(answer, &QNetworkReply::finished, this, [this, answer, requestId] {
            answer->deleteLater();
            const auto body = QJsonDocument::fromJson(answer->readAll()).object();
            const auto account = body.value("account").toObject();
            if (answer->error() == QNetworkReply::NoError && !body.value("session").toString().isEmpty() && !account.isEmpty()) {
                const auto nick = account.value("nick").toString();
                auth_->setSignedIn(body.value("session").toString(), account.value("id").toString(), account.value("email").toString(), nick,
                                   account.value("avatar_url").toString(),
                                   QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(body.value("expires_at").toDouble()), QTimeZone::UTC));
                QSettings().setValue("username", nick);
                emit reply(ok(requestId, QJsonObject{{"created", body.value("created").toBool()}}));
                startSignedIn();
                return;
            }
            const auto code = body.value("error").toString();
            const auto status = answer->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            emit reply(error(requestId, code.isEmpty() ? (status == 0 ? "offline" : "unknown_error") : code,
                code == "nick_taken" ? "Esse nome já está em uso. Escolha outro."
                : code == "password_required" ? "Essa conta tem senha. Digite a senha para entrar."
                : code == "invalid_credentials" ? "Nome de usuário ou senha incorretos."
                : code == "too_many_attempts" ? "Muitas tentativas. Tente de novo em alguns minutos."
                : code == "invalid_password" ? "A senha precisa ter de 6 a 128 caracteres."
                : code == "invalid_nick" ? "Use de 2 a 32 caracteres."
                : status == 0 ? "Sem conexão com o servidor. Verifique sua internet e tente novamente."
                : "Não foi possível entrar agora. Tente novamente."));
        });
        return {};   // answered later through reply()
    }
    if (name == "setPassword") {
        QNetworkRequest post(QUrl(authServerUrl() + "/password"));
        post.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        post.setRawHeader("Authorization", "Bearer " + auth_->session().toUtf8());
        post.setTransferTimeout(15000);
        QJsonObject body{{"password", command.value("password").toString()}};
        if (command.value("currentPassword").isString()) body.insert("current_password", command.value("currentPassword").toString());
        auto* answer = network_.post(post, QJsonDocument(body).toJson(QJsonDocument::Compact));
        connect(answer, &QNetworkReply::finished, this, [this, answer, requestId] {
            answer->deleteLater();
            const auto body = QJsonDocument::fromJson(answer->readAll()).object();
            if (answer->error() == QNetworkReply::NoError && !body.value("account").toObject().isEmpty()) {
                applyOwnProfile(body.value("account").toObject());
                emit reply(ok(requestId));
                return;
            }
            const auto code = body.value("error").toString();
            emit reply(error(requestId, code.isEmpty() ? "unknown_error" : code,
                code == "invalid_credentials" ? "A senha atual está incorreta."
                : code == "invalid_password" ? "A senha precisa ter de 6 a 128 caracteres."
                : "Não foi possível salvar a senha. Tente novamente."));
        });
        return {};
    }
    if (name == "setNick") {
        if (!auth_->isValid()) return error(requestId, "signed_out", "Entre com o Google primeiro.");
        const auto nick = command.value("nick").toString().trimmed();
        QNetworkRequest post(QUrl(authServerUrl() + "/nick"));
        post.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        post.setRawHeader("Authorization", "Bearer " + auth_->session().toUtf8());
        auto* answer = network_.post(post, QJsonDocument(QJsonObject{{"nick", nick}}).toJson(QJsonDocument::Compact));
        connect(answer, &QNetworkReply::finished, this, [this, answer, nick, requestId] {
            answer->deleteLater();
            const auto body = QJsonDocument::fromJson(answer->readAll()).object();
            if (answer->error() == QNetworkReply::NoError && !body.value("account").toObject().isEmpty()) {
                auth_->setNick(nick);
                QSettings().setValue("username", nick);
                emit reply(ok(requestId));
                startSignedIn();
                return;
            }
            // Same messages as the Qt nick chooser (nick_dialog.cpp).
            const auto code = body.value("error").toString();
            emit reply(error(requestId, code.isEmpty() ? "unknown_error" : code,
                             code == "nick_taken" ? "Esse nome já está em uso. Escolha outro." : "Não foi possível salvar o nome. Tente novamente."));
        });
        return {};   // answered later through reply()
    }
    if (name == "signOut") {
        stopCameraPreview();
        clearParticipantProfile(); participantAvatars_.clear(); participantAnimated_.clear(); avatarPrefetch_.clear(); avatarRequested_.clear(); patch({{"avatars", QJsonValue()}});
        upload_={}; uploadDeadline_.stop(); ownProfile_={}; avatarData_.clear(); bannerData_.clear(); accountAvatarData_.clear(); avatarSource_.clear(); bannerSource_.clear();
        leaveVoice();
        QNetworkRequest post(QUrl(authServerUrl() + "/logout"));
        post.setRawHeader("Authorization", "Bearer " + auth_->session().toUtf8());
        auto* bye = network_.post(post, QByteArray());   // best effort: the local session is dropped either way
        connect(bye, &QNetworkReply::finished, bye, &QObject::deleteLater);
        closeBrowse(); afterSwitch_ = nullptr;
        signaling_->disconnectFromServer();
        auth_->clearSession();
        hub_->setSession({});
        clearSessionIceServers(); iceRefresh_.stop();
        patch({{"profile", QJsonValue()}, {"auth", QJsonObject{{"state", "signedOut"}}}, {"connection", "offline"}, {"account", accountJson()},
               {"servers", QJsonArray{}}, {"selectedServerId", ""}});
        return ok(requestId);
    }
    if (name == "sendErrorReport") {
        if (!reporter_->hasLog()) return error(requestId, "no_log", "Este Triscord não está gravando o log.");
        reporter_->sendCurrent(false, [this, requestId](int status, const QStringList&) {
            if (status == 201) { emit reply(ok(requestId)); return; }
            emit reply(error(requestId, status == 429 ? "rate_limited" : status == 0 ? "offline" : "failed",
                             status == 429 ? "Muitos logs enviados na última hora. Tente de novo mais tarde."
                             : status == 0 ? "Sem conexão com o servidor. Tente novamente." : "Não foi possível enviar o log agora."));
        });
        return {};
    }
    if (name == "createServer") {
        hub_->createServer(command.value("serverName").toString().trimmed(), [this, requestId](int status, const HubServer& server) {
            if (status != 201 || server.id.isEmpty()) {
                emit reply(error(requestId, status == 404 ? "no_server_layer" : status == 0 ? "offline" : "failed",
                                 status == 404 ? "O servidor de sinalização publicado ainda não oferece servidores."
                                 : status == 0 ? "Sem conexão com o servidor. Tente novamente." : "Não foi possível criar o servidor agora."));
                return;
            }
            emit reply(ok(requestId, QJsonObject{{"serverId", server.id}}));
            QSettings().setValue("lastServerId", server.id);
            leaveVoice();
            patch({{"selectedServerId", server.id}, {"selectedChannelId", QJsonValue()}});
            refreshServers();
            connectSignaling();
        });
        return {};
    }
    if (name == "acceptInvite") {
        // JOIN_GUILD errors recovered from Discord (REA_CLAUDE_20261016.md: IRq5ah, GEYI+Z, dDZRdy).
        const auto text = command.value("invite").toString().trimmed();
        const auto code = HubApi::extractInviteCode(text);
        if (code.isEmpty()) return error(requestId, "invalid_invite", "Insira um link de convite ou um código de convite válido.");
        hub_->acceptInvite(code, [this, requestId](int status, const QString& serverId) {
            if (status != 200 || serverId.isEmpty()) {
                emit reply(error(requestId, status == 410 ? "invite_invalid" : "failed",
                                 status == 410 ? "O convite expirou ou não é mais válido." : "Não foi possível aceitar o convite"));
                return;
            }
            emit reply(ok(requestId, QJsonObject{{"serverId", serverId}}));
            QSettings().setValue("lastServerId", serverId);
            leaveVoice();
            patch({{"selectedServerId", serverId}, {"selectedChannelId", QJsonValue()}});
            refreshServers();
            connectSignaling();
        });
        return {};
    }
    if (name == "deleteServer" || name == "leaveServer") {
        // "Excluir servidor" (owner) / "Sair do servidor" (member), texts of Discord's modals in the web client.
        const auto id = command.value("serverId").toString();
        const bool remove = name == "deleteServer";
        auto done = [this, requestId, id, remove](int status) {
            if (status != 200) {
                emit reply(error(requestId, status == 403 ? "forbidden" : status == 0 ? "offline" : "failed",
                                 status == 403 ? (remove ? "Só quem criou o servidor pode excluí-lo." : "Você não faz parte deste servidor.")
                                 : status == 409 ? "Quem criou o servidor não pode sair dele; exclua o servidor."
                                 : status == 0 ? "Sem conexão com o servidor. Tente novamente."
                                 : remove ? "Não foi possível excluir o servidor agora." : "Não foi possível sair do servidor agora."));
                return;
            }
            emit reply(ok(requestId));
            // Out of a call in that server, and off its view; refreshServers() then picks the remaining list.
            if (callServerId_ == id && !session_.value("connectedChannelId").toString().isEmpty()) leaveVoice();
            if (QSettings().value("lastServerId").toString() == id) QSettings().remove("lastServerId");
            refreshServers();   // a removed selected server is replaced by the first remaining one
        };
        if (remove) hub_->deleteServer(id, done); else hub_->leaveServer(id, done);
        return {};
    }
    if (name == "createInvite") {
        // Only the owner may mint invites (POST /servers/:id/invites answers 403 otherwise); same messages as
        // the Qt client (MainWindow::createInvite).
        hub_->createInvite(command.value("serverId").toString(), [this, requestId](int status, const QString& code) {
            if (status != 201 || code.isEmpty()) {
                emit reply(error(requestId, status == 403 ? "forbidden" : status == 0 ? "offline" : "failed",
                                 status == 403 ? "Só quem criou o servidor pode convidar pessoas." : "Não foi possível criar o convite agora."));
                return;
            }
            invites_.insert(code);
            emit reply(ok(requestId, QJsonObject{{"code", code}}));
        });
        return {};
    }
    if (name == "selectServer") {
        const auto id = command.value("serverId").toString();
        if (id != session_.value("selectedServerId").toString()) {
            QSettings().setValue("lastServerId", id);
            const bool inCall = !session_.value("connectedChannelId").toString().isEmpty();
            // In a call, only the view changes (Discord keeps the call): back on the call's server the main
            // connection's directory shows again, elsewhere a browse connection lists that server.
            patch({{"selectedServerId", id}, {"selectedChannelId", inCall && id == callServerId_ ? session_.value("connectedChannelId") : QJsonValue()}});
            if (!inCall) connectSignaling();
            else if (id == callServerId_) { closeBrowse(); publishCategories(); }
            else openBrowse(id);
        }
    } else if (name == "selectChannel") {
        if (session_.value("callFullscreen").toBool() && command.value("channelId") != session_.value("connectedChannelId")) emit windowAction("exitCallFullscreen");
        const auto channel = command.value("channelId").toString();
        patch({{"selectedChannelId", channel}});
        // A voice channel row joins on click, as in Discord; in another server the call moves there.
        if (browsing()) switchCallServer([this, channel] { joinVoice(channel); });
        else joinVoice(channel);
    } else if (name == "joinVoice") {
        const auto channel = command.value("channelId").toString();
        if (!hasSessionIceServers()) refreshIce();   // e.g. the first fetch failed while offline
        if (browsing()) switchCallServer([this, channel] { joinVoice(channel); });
        else joinVoice(channel);
    } else if (name == "leaveVoice") {
        leaveVoice();
        if (browse_) connectSignaling();   // the view stays on the other server, whose connection becomes the main one
    } else if (name == "createChannel") {
        if (session_.value("callFullscreen").toBool()) emit windowAction("exitCallFullscreen");
        const auto id = "room_" + QUuid::createUuid().toString(QUuid::WithoutBraces);
        const auto roomName = command.value("channelName").toString().trimmed();
        auto create = [this, id, roomName] {
            signaling_->sendEvent("join-room", {{"roomId", id}, {"roomName", roomName}, {"userData", userData()}});
            patch({{"selectedChannelId", id}});
        };
        if (browsing()) { switchCallServer(create); return ok(requestId); }   // the room belongs to the viewed server
        if (!signaling_->ready()) return error(requestId, "offline", "Conecte ao servidor antes de criar uma sala.");
        create();
    } else if (name == "setCustomStatus") {
        const auto text = command.value("text").toString().trimmed();
        QSettings().setValue("accountStatus/" + auth_->id(), text);
        if (!session_.value("connectedChannelId").toString().isEmpty()) signaling_->sendEvent("user-state-change", {{"status", text}});
        patch({{"account", accountJson()}});
    } else if (name == "setServerMuted") {
        signaling_->sendEvent("force-mute-user", {{"socketId", command.value("socketId")}, {"muted", command.value("muted")}});
    } else if (name == "disconnectParticipant") {
        signaling_->sendEvent("kick-user", {{"socketId", command.value("socketId")}});
    } else if (name == "setPeerAudio") {
        const auto id = command.value("socketId").toString();
        restorePeerAudio(id);
        auto& audio = peerAudio_[id];
        if (command.contains("volume")) { audio.volume = command.value("volume").toInt(); voice_->setPeerVolume(id,audio.volume/100.f); }
        if (command.contains("pan")) { audio.pan = command.value("pan").toInt(); voice_->setPeerPan(id,audio.pan/100.f); }
        if (command.contains("muted")) { audio.muted = command.value("muted").toBool(); voice_->setPeerMuted(id,audio.muted); }
        if (command.contains("streamVolume")) audio.streamVolume = command.value("streamVolume").toInt();
        if (command.contains("streamMuted")) audio.streamMuted = command.value("streamMuted").toBool();
        applyStreamAudio(id);
        savePeerAudio(id);
        publishCategories();
    } else if (name == "setMuted") {
        const bool muted = command.value("muted").toBool();
        if (muted != session_.value("muted").toBool())
            sounds_->playCue(muted ? "mute" : "unmute");
        voice_->setMuted(muted);
        if (!session_.value("connectedChannelId").toString().isEmpty()) signaling_->sendEvent("user-state-change", {{"isMuted", muted}});
        patch({{"muted", muted}});
    } else if (name == "setDeafened") {
        const bool deafened = command.value("deafened").toBool();
        voice_->setDeafened(deafened);
        sounds_->setDeafened(deafened);
        if (deafened != session_.value("deafened").toBool()) sounds_->playCue(deafened ? "deafen" : "undeafen");
        if (media_.screen) media_.screen->setDeafened(deafened);
        if (!session_.value("connectedChannelId").toString().isEmpty()) signaling_->sendEvent("user-state-change", {{"isDeafened", deafened}});
        patch({{"deafened", deafened}});
    } else if (name == "setCallFullscreen") {
        emit windowAction(command.value("on").toBool() ? "enterCallFullscreen" : "exitCallFullscreen");
    } else if (name == "setCallPopout") {
        // The main window cannot stay fullscreen with the call moved out of it (Discord hides "Tela cheia" there).
        if (command.value("on").toBool() && session_.value("callFullscreen").toBool()) emit windowAction("exitCallFullscreen");
        setCallPopout(command.value("on").toBool(), session_.value("callPopoutOnTop").toBool());
    } else if (name == "setCallPopoutOnTop") {
        setCallPopout(true, command.value("on").toBool());
    } else if (name == "setStreamHidden") {
        const auto id = command.value("streamId").toString();
        if (command.value("hidden").toBool()) { hiddenStreams_.insert(id); emit videoRemoved(id); }
        else hiddenStreams_.remove(id);
        publishStreams();
    } else if (name == "setCamera") {
        if (session_.value("connectedChannelId").toString().isEmpty()) return error(requestId, "not_in_call", "Entre numa sala para ligar a câmera.");
        if (command.value("on").toBool() && !session_.value("camera").toBool()) stopCameraPreview();
        cameraWanted_ = command.value("on").toBool();
        if (cameraWanted_) {
            const bool pending = !session_.value("camera").toBool();
            patch({{"cameraPending",pending}});
            if (pending) cameraStartDeadline_.start(10000);
            startCameraIfReady();
        } else { clearCameraIntent(); media_.camera->stop(); }
    } else if (name == "listShareSources") {
        if (!media_.screen) return error(requestId, "unavailable", "Compartilhamento indisponível.");
        shareSources_ = captureSources();
        ++thumbnailGeneration_;
        QJsonArray sources;
        for (int i = 0; i < shareSources_.size(); ++i) {
            const auto& source = shareSources_[i];
            const bool monitor = source.kind == CaptureSource::Kind::Monitor;
            sources.append(QJsonObject{{"index", i}, {"kind", monitor ? "screen" : "window"}, {"name", shareSourceName(i)}});
        }
        media_.screen->requestThumbnails(shareSources_, thumbnailGeneration_);
        value = QJsonObject{{"generation", QString::number(thumbnailGeneration_)}, {"sources", sources}};
    } else if (name == "startScreenShare") {
        if (session_.value("connectedChannelId").toString().isEmpty()) return error(requestId, "not_in_call", "Entre numa sala para compartilhar.");
        media_.screen->cancelThumbnails();
        const auto& source = shareSources_[command.value("index").toInt()];
        // Name shown in the voice panel's stream row (observed: the shared window's title).
        if (deviceShare_) deviceShare_->stop();
        patch({{"sharingName", shareSourceName(command.value("index").toInt())}});
        // Stream mode block (SHARE.md, mapping inferred as in the Qt picker): SD = 720p, HD = 1080p; "Jogos" 30 fps
        // (60 in HD), "Compartilhamento de tela" 15 fps; "Silenciar áudio da transmissão" = no system audio.
        QSettings settings;
        const bool hd = settings.value("shareResolution", 720).toInt() >= 1080, game = settings.value("shareMode", "game").toString() != "screen";
        const auto config = screenPreset(hd ? 1080 : 720, game ? (hd ? 60 : 30) : 15);
        settings.setValue("shareFps", config.fps);
        media_.screen->start(source, settings.value("shareSystemAudio", false).toBool(), config);
    } else if (name == "startDeviceShare") {
        if (session_.value("connectedChannelId").toString().isEmpty()) return error(requestId, "not_in_call", "Entre numa sala para compartilhar.");
        media_.screen->cancelThumbnails();
        const auto id = command.value("deviceId").toString();
        QString deviceName;
        for (const auto& d : cameraDevices_) if (d.toObject().value("id").toString() == id) deviceName = d.toObject().value("name").toString();
        patch({{"sharingName", deviceName}});
        QSettings settings;
        const bool hd = settings.value("shareResolution", 720).toInt() >= 1080, game = settings.value("shareMode", "game").toString() != "screen";
        const auto config = screenPreset(hd ? 1080 : 720, game ? (hd ? 60 : 30) : 15);
        settings.setValue("shareFps", config.fps);
        deviceShare_->start(QByteArray::fromHex(id.toLatin1()), config);
    } else if (name == "stopScreenShare") {
        if (deviceShare_) deviceShare_->stop();
        if (media_.screen) media_.screen->stop();
    } else if (name == "sendChatMessage") {
        const auto room = session_.value("connectedChannelId").toString();
        if (room.isEmpty()) return error(requestId, "not_in_call", "Entre numa sala para conversar.");
        // The panel clears its draft on success, so success must mean "sent": the hub drops a message that arrives
        // within 500 ms of the previous one (worker.js chat-rate-limited), and a socket that cannot take it drops it too.
        const auto now = QDateTime::currentMSecsSinceEpoch();
        if (now - lastChatSend_ < 600) {
            auto notice = message("event"); notice.insert("name", "chatRateLimited"); emit this->event(notice);
            return error(requestId, "rate_limited", "Você está enviando mensagens rápido demais.");
        }
        if (!signaling_->sendEvent("send-chat-message", {{"roomId", room}, {"message", command.value("text").toString().trimmed()}}))
            return error(requestId, "offline", "Sem conexão com o servidor. A mensagem não foi enviada.");
        lastChatSend_ = now;
    } else if (name == "deleteChatMessage") {
        signaling_->sendEvent("delete-chat-message", {{"roomId", session_.value("connectedChannelId")}, {"messageId", command.value("messageId")}});
    } else if (name == "openChatLink") {
        if (!QDesktopServices::openUrl(QUrl(command.value("url").toString(), QUrl::StrictMode)))
            return error(requestId, "open_link_failed", "Não foi possível abrir o link no navegador.");
    } else if (name == "copyMessageText") {
        for (const auto& m : chat_)
            if (m.toObject().value("id") == command.value("messageId")) { emit copyText(m.toObject().value("text").toString()); break; }
    } else if (name == "toggleReaction") {
        signaling_->sendEvent("add-reaction", {{"messageId", command.value("messageId")}, {"emoji", command.value("emoji")}});
    } else if (name == "setSetting") {
        const auto key = command.value("key").toString();
        const auto value = command.value("value");
        static const QHash<QString, QString> stored{{"inputDevice", "audioInput"}, {"outputDevice", "audioOutput"}, {"cameraDevice", "cameraDevice"},
            {"inputVolume", "audioInputVolume"}, {"outputVolume", "audioOutputVolume"}, {"noiseSuppression", "noiseSuppression"}, {"noiseSuppressionMode", "noiseSuppressionMode"}, {"automaticGainControl", "automaticGainControl"}, {"theme", "webTheme"}, {"soundboardVolume", "soundboardVolume"}, {"callSounds", "callSounds"},
            {"noiseSuppressionStrength", "noiseSuppressionStrength"}, {"desktopNotifications", "desktopNotifications"}, {"taskbarAlert", "taskbarAlert"}};
        if (key == "closeToTray" || key == "startMinimized") {
            QSettings().setValue(key, value.toBool());
            emit windowSettingsChanged();
        } else if (key == "openAtLogin") {
            const auto run = LoginItem::registryStore();
            if (!LoginItem(run.get()).setEnabled(value.toBool(), QCoreApplication::applicationFilePath()))
                return error(requestId, "login_item_failed", "Não foi possível alterar a inicialização com o Windows.");
        } else if (key == "errorReports") QSettings().setValue(key, value.toBool());
        else if (key == "shareHd") QSettings().setValue("shareResolution", value.toBool() ? 1080 : 720);
        else if (key == "shareAudio") QSettings().setValue("shareSystemAudio", value.toBool());
        else if (key == "shareMode") QSettings().setValue("shareMode", value.toString());
        else QSettings().setValue(stored.value(key), key == "cameraDevice" ? QVariant(QByteArray::fromHex(value.toString().toLatin1())) : value.toVariant());
        applyAudioSettings();
        { QSettings stored; notifications_->setEnabled(stored.value("desktopNotifications", true).toBool() || stored.value("taskbarAlert", true).toBool()); }
        if (key == "cameraDevice") stopCameraPreview("A câmera foi alterada. Abra a prévia novamente.");
        if (key == "cameraDevice" && session_.value("camera").toBool() && !media_.syntheticCamera)
            media_.camera->start(QByteArray::fromHex(value.toString().toLatin1()));
        publishSettings();
    } else if (name == "requestDevices") {
        // Media Foundation cameras (Qt Multimedia); DirectShow-only virtual cameras (e.g. OBS) are not listed.
        if (media_.camera) media_.camera->requestDevices();
    } else if (name == "copyInvite") {
        emit copyText(command.value("code").toString());
    } else if (name == "videoRole") {
        emit videoRole(command.value("streamId").toString(), command.value("role").toString());
    } else if (name == "videoIdle") {
        emit videoIdle(command.value("idle").toBool());
    } else if (name == "setCallFocus") {
        patch({{"callFocus", QJsonObject{{"key", command.value("key")}, {"filmOpen", command.value("filmOpen")}}}});
    } else if (name == "videoOccluders" || name == "videoStageOccluders") {
        QVector<QRect> rects;
        for (const auto& value : command.value("rects").toArray()) {
            const auto r = value.toObject();
            rects.append(QRect(r.value("x").toInt(), r.value("y").toInt(), r.value("width").toInt(), r.value("height").toInt()));
        }
        if (name == "videoOccluders") emit videoOccluders(rects); else emit videoStageOccluders(rects);
    } else if (name == "videoSurface") {
        const auto rect = command.value("rect").toObject();
        emit videoSurface(command.value("streamId").toString(),
                          QRect(rect.value("x").toInt(), rect.value("y").toInt(), rect.value("width").toInt(), rect.value("height").toInt()),
                          command.value("scale").toDouble(1.0));
    } else if (name == "window") {
        emit windowAction(command.value("action").toString());
    }
    auto result = message("result");
    result.insert("requestId", requestId);
    result.insert("ok", true);
    if (!value.isUndefined()) result.insert("value", value);
    return result;
}

void CoreSession::joinVoice(const QString& channelId) {
    if (channelId == session_.value("connectedChannelId").toString()) return;
    if (!signaling_->ready()) { emit notice("Aguardando conexão para entrar na sala."); return; }
    QString channelName;
    for (const auto& room : rooms_)
        if (room.toObject().value("id").toString() == channelId) channelName = room.toObject().value("name").toString();
    signaling_->sendEvent("join-room", {{"roomId", channelId}, {"roomName", channelName}, {"userData", userData()}});
}

void CoreSession::finishSoundRequest(const QString& failure) {
    soundAckDeadline_.stop();
    if (pendingSoundRequest_.isEmpty()) return;
    const auto request = pendingSoundRequest_;
    pendingSoundRequest_.clear(); pendingSoundId_.clear();
    if (failure.isEmpty()) emit reply(ok(request));
    else { patch({{"soundboardError", failure}}); emit reply(error(request, "sound_failed", failure)); }
}
void CoreSession::onEvent(const QString& event, const QJsonArray& args) {
    if (args.isEmpty()) return;
    const auto data = args.first();
    if (event == "soundboard-played") {
        const auto object = data.toObject();
        if (!session_.value("connectedChannelId").toString().isEmpty() && object.value("roomId") == session_.value("connectedChannelId")) {
            if (object.value("bySocketId").toString() == signaling_->socketId() && object.value("soundId").toString() == pendingSoundId_)
                finishSoundRequest();
            sounds_->play(object.value("soundId").toString(), false);
        }
    } else if (event == "request-error" && !pendingSoundRequest_.isEmpty()) {
        finishSoundRequest("O servidor recusou o som. Aguarde um instante e tente novamente.");
    } else if (event == "room-join-denied") {
        const auto reason = data.toObject().value("message").toString();
        emit notice(reason.isEmpty() ? QStringLiteral("Sala bloqueada ou cheia.") : reason);
    } else if (event == "rooms-update" && data.isArray()) {
        rooms_ = data.toArray();
        publishCategories();
        if (afterSwitch_) { auto then = std::move(afterSwitch_); afterSwitch_ = nullptr; then(); }
        if (!rejoin_.channel.isEmpty()) {
            const auto channel = std::exchange(rejoin_.channel, QString());
            if (rejoin_.server == callServerId_ && rejoin_.age.elapsed() < 60000 && session_.value("connectedChannelId").toString().isEmpty()) {
                std::printf("voice: connection restored, rejoining the call\n"); std::fflush(stdout);
                signaling_->sendEvent("join-room", {{"roomId", channel}, {"roomName", rejoin_.name}, {"userData", userData()}});
            }
        }
    } else if (event == "room-joined") {
        sounds_->stop();
        const auto roomId = data.toObject().value("roomId").toString();
        if (roomId != session_.value("connectedChannelId").toString()) {
            sounds_->playCue("join");
            cameraReady_ = false; clearCameraIntent();
            peerAudio_.clear();
            if (session_.value("callFullscreen").toBool()) emit windowAction("exitCallFullscreen");
        }
        patch({{"connectedChannelId", roomId}, {"selectedChannelId", roomId}, {"connectedAt", QDateTime::currentMSecsSinceEpoch()}});
        chat_ = data.toObject().value("chatHistory").toArray();
        publishChat();
        // The hub admits everyone muted (cloudflare/src/worker.js join): announce our real state right away,
        // as the Qt client does once the voice is ready. Without it every row showed a muted microphone.
        const bool muted = session_.value("muted").toBool() || data.toObject().value("isServerMuted").toBool(), deafened = session_.value("deafened").toBool();
        if (muted != session_.value("muted").toBool()) patch({{"muted", muted}});
        voice_->setMuted(muted);
        voice_->setDeafened(deafened);
        signaling_->sendEvent("user-state-change", {{"isMuted", muted}, {"isDeafened", deafened}});
        publishCategories();
    } else if (event == "kicked") {
        if (data.toObject().value("roomId") == session_.value("connectedChannelId")) { leaveVoice(); if (browse_) connectSignaling(); }
    } else if (event == "user-state-updated") {
        // Live per-user state (mute, deafen, camera, share); rooms-update is not re-sent for these.
        const auto object = data.toObject();
        const auto socketId = object.value("socketId").toString();
        const auto state = object.value("state").toObject();
        const auto previous = participant(socketId);
        if (!previous.isEmpty() && socketId != signaling_->socketId() && state.value("isScreenSharing").isBool() && state.value("isScreenSharing") != previous.value("isScreenSharing"))
            sounds_->playCue(state.value("isScreenSharing").toBool() ? "stream_started" : "stream_ended");
        QJsonArray rooms;
        for (const auto& value : rooms_) {
            auto room = value.toObject();
            QJsonArray users;
            for (const auto& u : room.value("users").toArray()) {
                auto user = u.toObject();
                if (user.value("socketId").toString() == socketId) {
                    for (const char* key : {"isMuted", "isDeafened", "isServerMuted", "isCameraOn", "isScreenSharing"})
                        if (state.value(key).isBool()) user.insert(key, state.value(key));
                    if (state.value("status").isString()) user.insert("status", state.value("status").toString().left(64));
                }
                users.append(user);
            }
            room.insert("users", users);
            rooms.append(room);
        }
        rooms_ = rooms;
        publishCategories();
    } else if (event == "new-chat-message" && data.isObject()) {
        if (data.toObject().value("roomId").toString() != session_.value("connectedChannelId").toString()) return;
        chat_.append(data);
        while (chat_.size() > 200) chat_.removeFirst();
        publishChat();
        notifications_->chatMessage(data.toObject(), signaling_->socketId(), accountJson().value("displayName").toString(), background_);
    } else if (event == "user-joined" && data.isObject()) {
        if (!session_.value("connectedChannelId").toString().isEmpty()) {
            sounds_->playCue("join");
            notifications_->memberEntered(data.toObject().value("userData").toObject().value("username").toString().trimmed(), background_);
        }
    } else if (event == "user-left" && data.isObject()) {
        const auto peer = data.toObject().value("socketId").toString();
        for (const auto& value : rooms_) {
            const auto room = value.toObject();
            if (room.value("id") != session_.value("connectedChannelId")) continue;
            for (const auto& user : room.value("users").toArray())
                if (!peer.isEmpty() && user.toObject().value("socketId").toString() == peer) { sounds_->playCue(user.toObject().value("isScreenSharing").toBool() ? "stream_ended" : "leave"); break; }
        }
    } else if (event == "chat-message-deleted" || event == "message-reaction-updated") {
        const auto object = data.toObject();
        for (int i = 0; i < chat_.size(); ++i) {
            if (chat_[i].toObject().value("id") != object.value("messageId")) continue;
            if (event == "chat-message-deleted") chat_.removeAt(i);
            else { auto m = chat_[i].toObject(); m.insert("reactions", object.value("reactions")); chat_[i] = m; }
            break;
        }
        publishChat();
    } else if (event == "chat-rate-limited") {
        lastChatSend_ = QDateTime::currentMSecsSinceEpoch();
        auto notice = message("event");
        notice.insert("name", "chatRateLimited");
        emit this->event(notice);
    } else if (event == "force-muted") {
        // The room owner muted us: the hub keeps refusing unmute until it is lifted.
        if (data.toObject().value("muted").toBool()) { if (!session_.value("muted").toBool()) sounds_->playCue("mute"); voice_->setMuted(true); patch({{"muted", true}}); }
    }
}

} // namespace triscord
