#include "screen_call.h"
#include "video_image.h"
#include "screen_quality.h"
#include "ice_config.h"
#include <QUuid>
#include <QDebug>
#include <cstdio>

namespace triscord {
ScreenCall::ScreenCall(Signaling* signaling, SourceMode mode, VideoConfig config, QObject* parent, MediaKind media)
    : QObject(parent), signaling_(signaling), mode_(mode), media_(media), config_(config) {
    if (!config.valid()) throw std::invalid_argument("Invalid screen configuration");
    if (media_ == MediaKind::Camera && mode_ == SourceMode::Native) throw std::invalid_argument("Camera requires an external video source");
    connect(&thumbnails_, &CaptureThumbnails::ready, this, &ScreenCall::thumbnailReady);
    connect(&audio_, &ScreenAudio::captured, this, &ScreenCall::sendAudio);
    connect(&audio_, &ScreenAudio::error, this, &ScreenCall::message);
    connect(&audio_, &ScreenAudio::decoded, this, &ScreenCall::screenAudio);
    audio_.setPlaybackEnabled(media_ == MediaKind::Screen && mode_ != SourceMode::Injected);
    if (mode_ != SourceMode::Injected) {
        for (auto& server : toRtcIceServers(resolveIceServers())) rtcConfig_.iceServers.push_back(server);
    }
    captureTimer_.setParent(this); captureTimer_.setInterval(33); captureTimer_.setTimerType(Qt::PreciseTimer);
    recoveryTimer_.setParent(this); recoveryTimer_.setInterval(2000);
    connect(&captureTimer_, &QTimer::timeout, this, &ScreenCall::tick);
    connect(&recoveryTimer_, &QTimer::timeout, this, &ScreenCall::recover);
    connect(signaling_, &Signaling::sessionStarted, this, [this](const QString& id) { socket_ = id; });
    connect(signaling_, &Signaling::eventReceived, this, &ScreenCall::event);
    connect(signaling_, &Signaling::disconnected, this, &ScreenCall::leave);
    connect(this, &ScreenCall::outboundEvent, signaling_, [signaling](const QString& name, const QJsonObject& payload) { signaling->sendEvent(name, payload); });
}
ScreenCall::~ScreenCall() { leave(); }
void ScreenCall::requestLocalKeyframe() {
    if (encoder_) encoder_->requestKeyframe();
    else if (sharing_) emit keyframeRequested();
}
void ScreenCall::adaptBitrate(BitrateSignal signal) {
    if (!sharing_) return;
    int viewers = 0;
    for (const auto& [id, session] : peers_) {
        const auto member = members_.find(id);
        if (session->peer->connected() && member != members_.end() && member->second.watching) ++viewers;
    }
    const int ceiling = std::max(ScreenBitrateControl::floor(config_.bitrate), config_.bitrate / std::max(1, viewers));
    if (!bitrateClock_.isValid()) bitrateClock_.start();
    const auto now = bitrateClock_.elapsed();
    const int target = signal == BitrateSignal::Congested ? bitrate_.congested(now, config_.bitrate, ceiling)
        : signal == BitrateSignal::KeyframeRequest ? bitrate_.keyframeRequested(now, config_.bitrate, ceiling)
        : bitrate_.calm(now, config_.bitrate, ceiling);
    if (!target) return;
    try {
        if (encoder_) encoder_->setBitrate(target);
        else emit bitrateRequested(target);
        // In the log a user can send: a stream that turns blurry shows here with its cause.
        std::printf("%s: bitrate %d kbps for %d viewer(s)%s\n", media_ == MediaKind::Camera ? "camera" : "screen", target / 1000, viewers,
                    signal == BitrateSignal::Congested ? " (send buffer full)" : signal == BitrateSignal::KeyframeRequest ? " (viewer losses)" : "");
        std::fflush(stdout);
    } catch (const std::exception& error) {
        qWarning("screen: bitrate adjustment failed: %s", error.what());
    }
}
void ScreenCall::setVideoDisabled(const QString& id, bool disabled) {
    if (!members_.contains(id) || disabledVideo_.contains(id) == disabled) return;
    if (disabled) disabledVideo_.insert(id); else disabledVideo_.remove(id);
    if (auto found = peers_.find(id); found != peers_.end()) {
        auto& session = *found->second;
        session.decoder.reset(); session.clock = {};
        if (disabled) emit generationRemoved(id);
        else { session.generation = ++nextGeneration_; emit generationChanged(id, session.generation); session.peer->requestKeyframe(); }
    }
    emit outboundEvent(watchEvent(), {{"targetSocketId", id}, {"watching", !disabled}});
}
void ScreenCall::remove(const QString& id) {
    audio_.remove(id);
    peers_.erase(id); emit generationRemoved(id);
}
void ScreenCall::list() {
    QJsonArray streams;
    for (const auto& [id, member] : members_) if (member.sharing)
        streams.append(QJsonObject{{"id", id}, {"name", member.name}});
    emit streamsChanged(streams);
}
ScreenCall::Session& ScreenCall::create(const QString& id, int attempts) {
    remove(id);
    auto session = std::make_unique<Session>();
    session->local = QUuid::createUuid().toString(QUuid::WithoutBraces);
    session->generation = ++nextGeneration_; session->attempts = attempts; session->age.start();
    // As in VoiceCall::create: current servers (session TURN relays included) for every new peer.
    if (mode_ != SourceMode::Injected || iceRelayOnly()) {
        rtcConfig_.iceServers = toRtcIceServers(resolveIceServers());
        rtcConfig_.iceServers.insert(rtcConfig_.iceServers.end(), pushedIce_.begin(), pushedIce_.end());
    }
    if (iceRelayOnly()) rtcConfig_.iceTransportPolicy = rtc::TransportPolicy::Relay;
    session->peer = std::make_unique<VideoPeer>(rtcConfig_, this, media_ == MediaKind::Screen);
    const auto local = session->local;
    connect(session->peer.get(), &VideoPeer::localDescription, this, [this, id, local](const QString& sdp, const QString& type) {
        auto it = peers_.find(id); if (it == peers_.end() || it->second->local != local) return;
        QJsonObject description{{"type", type}, {"sdp", sdp}, {"video", QJsonObject{{"width", config_.size.width()},
            {"height", config_.size.height()}, {"fps", config_.fps}, {"bitrate", config_.bitrate}}}};
        QJsonObject payload{{"targetSocketId", id}, {"session", local}, {"type", wireType()}, {type, description}};
        if (!it->second->remote.isEmpty()) payload.insert("targetSession", it->second->remote);
        emit outboundEvent(type == "offer" ? "webrtc-offer" : "webrtc-answer", payload);
    });
    connect(session->peer.get(), &VideoPeer::localCandidate, this, [this, id, local](const QString& candidate, const QString& mid) {
        auto it = peers_.find(id); if (it == peers_.end() || it->second->local != local) return;
        QJsonObject payload{{"targetSocketId", id}, {"session", local}, {"type", wireType()},
            {"candidate", QJsonObject{{"candidate", candidate}, {"sdpMid", mid}}}};
        if (!it->second->remote.isEmpty()) payload.insert("targetSession", it->second->remote);
        emit outboundEvent("webrtc-ice-candidate", payload);
    });
    connect(session->peer.get(), &VideoPeer::videoReceived, this, [this, id, local](const QByteArray& bytes, uint32_t stamp, bool key) { receive(id, local, bytes, stamp, key); });
    connect(session->peer.get(), &VideoPeer::audioReceived, this, [this, id, local](const QByteArray& opus, uint32_t stamp) {
        const auto peer = peers_.find(id); const auto member = members_.find(id);
        if (media_ == MediaKind::Screen && peer != peers_.end() && peer->second->local == local && member != members_.end() && member->second.sharing)
            audio_.receive(id, opus, stamp);
    });
    connect(session->peer.get(), &VideoPeer::recoveryNeeded, this, [this, id, local] {
        auto it = peers_.find(id); if (it == peers_.end() || it->second->local != local) return;
        it->second->decoder.reset(); it->second->clock = {};
    });
    connect(session->peer.get(), &VideoPeer::keyframeRequested, this, [this, id, local] {
        const auto it = peers_.find(id);
        if (it != peers_.end() && it->second->local == local) {
            requestLocalKeyframe();
            if (it->second->peer->connected() && it->second->age.elapsed() > 5000) adaptBitrate(BitrateSignal::KeyframeRequest);
        }
    });
    connect(session->peer.get(), &VideoPeer::congested, this, [this] { adaptBitrate(BitrateSignal::Congested); });
    connect(session->peer.get(), &VideoPeer::connectionChanged, this, [this, id, local](bool ready) {
        auto it = peers_.find(id); if (it == peers_.end() || it->second->local != local) return;
        it->second->age.restart();
        if (ready) {
            it->second->attempts = 0; it->second->failureReported = false;
            emit outboundEvent(watchEvent(), {{"targetSocketId", id}, {"watching", !disabledVideo_.contains(id)}});
            requestLocalKeyframe();
        }
    });
    auto& result = *session;
    peers_[id] = std::move(session);
    if (!disabledVideo_.contains(id)) emit generationChanged(id, result.generation);
    return result;
}
void ScreenCall::reconcile(const QString& id, bool rebuild) {
    auto member = members_.find(id); if (member == members_.end()) return;
    if (!sharing_ && !member->second.sharing) { remove(id); return; }
    if (peers_.contains(id) && !rebuild) return;
    if (!peers_.contains(id) && peers_.size() >= 9) return;
    auto& session = create(id);
    if (self_ < id) session.peer->offer();
}
void ScreenCall::start(const CaptureSource& source, bool shareAudio, VideoConfig config) {
    if (mode_ != SourceMode::Native || media_ != MediaKind::Screen) return;
    thumbnails_.cancel();
    if (room_.isEmpty() || mode_ != SourceMode::Native) { emit message("Entre em uma sala antes de compartilhar."); return; }
    if (!config.valid()) { emit message("escolha uma qualidade de transmissão válida"); return; }
    stop(false);
    config_ = config; captureTimer_.setInterval(std::max(1, 1000 / config_.fps));
    try {
        encoder_ = std::make_unique<ScreenEncoder>(source, config_);
        sharing_ = true; localGeneration_ = ++nextGeneration_;
        emit generationChanged("$local", localGeneration_);
        emit outboundEvent("user-state-change", {{stateKey(), true}});
        for (const auto& [id, member] : members_) { (void)member; reconcile(id, true); }
        if (shareAudio) audio_.startCapture();
        captureTimer_.start(); emit sharingChanged(true);
    } catch (const std::exception& error) { qWarning("screen: start failed: %s", error.what()); stop(); emit message("Não foi possível compartilhar. Escolha outra fonte ou confira o driver de vídeo."); }
}
void ScreenCall::startInjected() {
    if (mode_ == SourceMode::Injected) startExternal();
}
void ScreenCall::startExternal() {
    startExternal(config_);
}
void ScreenCall::startExternal(VideoConfig config) {
    // Native mode also takes external frames: the web client's "Dispositivos" tab encodes a capture device itself.
    if (room_.isEmpty() || !config.valid()) return;
    stop(false); config_ = config; sharing_ = true;
    emit outboundEvent("user-state-change", {{stateKey(), true}});
    for (const auto& [id, member] : members_) { (void)member; reconcile(id, true); }
    emit sharingChanged(true);
}
void ScreenCall::stop(bool notify) {
    audio_.stopCapture();
    captureTimer_.stop(); encoder_.reset();
    const bool wasSharing = sharing_; sharing_ = false;
    bitrate_.reset();
    emit generationRemoved("$local");
    if (notify) emit sharingChanged(false);
    if (wasSharing && !room_.isEmpty()) {
        emit outboundEvent("user-state-change", {{stateKey(), false}});
        for (const auto& [id, member] : members_) { (void)member; reconcile(id); }
    }
}
void ScreenCall::leave() {
    audio_.clear();
    thumbnails_.cancel();
    stop(); recoveryTimer_.stop();
    for (const auto& [id, session] : peers_) { (void)session; emit generationRemoved(id); }
    peers_.clear(); members_.clear(); disabledVideo_.clear(); room_.clear(); self_.clear(); focus_.clear(); list(); emit roomChanged(false);
}
void ScreenCall::sendFrame(const EncodedVideo& frame) {
    if (!sharing_) return;
    for (auto& [id, session] : peers_) {
        if (const auto member = members_.find(id); member != members_.end() && !member->second.watching) continue;
        try { session->peer->sendVideo(frame); }
        catch (const std::exception&) { session->age.restart(); }
    }
}
void ScreenCall::sendAudio(const QByteArray& opus) {
    if (!sharing_ || media_ != MediaKind::Screen) return;
    for (auto& [id, session] : peers_) {
        (void)id; try { session->peer->sendAudio(opus); } catch (const std::exception&) { /* Do not accumulate audio on a stalled connection. */ }
    }
}
void ScreenCall::tick() {
    if (!encoder_) return;
    try {
        auto result = encoder_->tick();
        for (const auto& encoded : result.encoded) sendFrame(encoded);
        if (result.preview) emit frame("$local", localGeneration_, result.preview->image);
    } catch (const std::exception& error) { qWarning("screen: capture/encode failed: %s", error.what()); stop(); emit message("O compartilhamento foi interrompido. Confira a fonte e tente novamente."); }
}
void ScreenCall::receive(const QString& id, const QString& local, const QByteArray& bytes, uint32_t stamp, bool key) {
    auto it = peers_.find(id); auto member = members_.find(id);
    if (it == peers_.end() || it->second->local != local || member == members_.end() || !member->second.sharing || !it->second->configured || disabledVideo_.contains(id)) return;
    auto& session = *it->second;
    try {
        if (!session.decoder) {
            if (!key) { session.peer->requestKeyframe(); return; }
            session.decoder = std::make_unique<VideoDecoder>(session.remoteConfig); session.clock = {};
        }
        const auto time = session.clock.accept(stamp); if (!time) return;
        auto render = [&] {
            for (const auto& decoded : session.decoder->poll()) {
                const bool focused = focus_.isEmpty() || focus_ == id;
                if (session.rendered.isValid() && session.rendered.elapsed() < screenRenderInterval(session.remoteConfig, focused)) continue;
                session.rendered.start();
                emit frame(id, session.generation, videoImage(decoded, focused ? session.remoteConfig.size : QSize(320, 180)));
            }
        };
        const EncodedVideo sample{bytes, *time, 10000000 / session.remoteConfig.fps, key};
        // Frames released together after a retransmission can find the decoder full: drain it once before giving up.
        if (!session.decoder->submit(sample)) { render(); if (!session.decoder->submit(sample)) throw std::runtime_error("Video decoder busy"); }
        render();
    } catch (const std::exception&) { session.decoder.reset(); session.clock = {}; session.peer->requestKeyframe(); }
}
void ScreenCall::signal(const QString& name, const QJsonObject& payload) {
    if (payload.value("type").toString() != wireType()) return;
    const auto id = payload.value("senderSocketId").toString();
    if (!members_.contains(id)) return;
    reconcile(id);
    auto it = peers_.find(id); if (it == peers_.end()) return;
    auto* session = it->second.get();
    const auto remote = payload.value("session").toString(), target = payload.value("targetSession").toString();
    if (remote.size() > 64 || QUuid(remote).isNull() || (!target.isEmpty() && target != session->local)) return;
    if (name == "webrtc-offer" || name == "webrtc-answer") {
        if (name == "webrtc-offer" && self_ < id) return;
        if (name == "webrtc-answer" && (self_ > id || target != session->local)) return;
        if (!session->remote.isEmpty() && session->remote != remote) {
            if (name != "webrtc-offer") return;
            session = &create(id);
        }
        const QString type = name == "webrtc-offer" ? "offer" : "answer";
        const auto description = payload.value(type).toObject(), video = description.value("video").toObject();
        VideoConfig config{{video.value("width").toInt(), video.value("height").toInt()}, video.value("fps").toInt(), video.value("bitrate").toInt()};
        if (!config.valid()) return;
        session->remote = remote; session->remoteConfig = config; session->configured = true;
        session->peer->applyDescription(description.value("sdp").toString(), type); session->described = true;
    } else if (name == "webrtc-ice-candidate") {
        if (!session->remote.isEmpty() && session->remote != remote) return;
        if (session->candidates.size() < 200) session->candidates.append(payload);
    }
    if (!session->described) return;
    const auto candidates = session->candidates; session->candidates = {};
    for (const auto& value : candidates) {
        const auto queued = value.toObject(); if (queued.value("session").toString() != session->remote) continue;
        const auto candidate = queued.value("candidate").toObject();
        try { session->peer->addCandidate(candidate.value("candidate").toString(), candidate.value("sdpMid").toString()); }
        catch (const std::exception&) { /* Stale/unsupported ICE candidate. */ }
    }
}
void ScreenCall::event(const QString& name, const QJsonArray& args) {
    if (args.isEmpty()) return;
    const auto payload = args.first().toObject();
    try {
        if (name == "ice-servers" && mode_ != SourceMode::Injected) {
            pushedIce_.clear();
            rtcConfig_.iceTransportPolicy = args.size() > 1 && args[1].toString() == "relay" ? rtc::TransportPolicy::Relay : rtc::TransportPolicy::All;
            for (const auto& value : args.first().toArray()) {
                const auto server = value.toObject();
                const auto urls = server.value("urls").isArray() ? server.value("urls").toArray() : QJsonArray{server.value("urls")};
                for (const auto& url : urls) {
                    try { rtc::IceServer ice(url.toString().toStdString()); ice.username = server.value("username").toString().toStdString();
                        ice.password = server.value("credential").toString().toStdString(); pushedIce_.push_back(std::move(ice)); }
                    catch (const std::exception&) { }
                }
            }
        } else if (name == "room-joined") {
            leave(); self_ = socket_; room_ = payload.value("roomId").toString();
            for (const auto& value : payload.value("existingUsers").toArray()) {
                const auto user = value.toObject(); const auto id = user.value("socketId").toString();
                if (id.isEmpty() || id == self_ || members_.size() >= 9) continue;
                members_[id] = {user.value("username").toString(), user.value(stateKey()).toBool()}; reconcile(id);
            }
            list(); recoveryTimer_.start(); emit roomChanged(true);
        } else if (name == "user-joined" && !room_.isEmpty()) {
            const auto id = payload.value("socketId").toString(); const auto user = payload.value("userData").toObject();
            if (id.isEmpty() || id == self_ || members_.size() >= 9) return;
            members_[id] = {user.value("username").toString(), user.value(stateKey()).toBool()}; reconcile(id); list();
        } else if (name == "user-left") {
            const auto id = payload.value("socketId").toString(); remove(id); audio_.forgetPeer(id); members_.erase(id); disabledVideo_.remove(id); list();
        } else if (name == "user-state-updated") {
            const auto id = payload.value("socketId").toString(); auto member = members_.find(id);
            if (member == members_.end()) return;
            const auto state = payload.value("state").toObject();
            if (state.contains("username")) member->second.name = state.value("username").toString();
            if (state.contains(stateKey()) && member->second.sharing != state.value(stateKey()).toBool()) {
                member->second.sharing = state.value(stateKey()).toBool();
                if (!member->second.sharing) {
                    if (const auto peer = peers_.find(id); peer != peers_.end()) {
                        peer->second->decoder.reset(); peer->second->clock = {};
                        emit generationRemoved(id);
                    }
                }
                // A duplex peer can still carry our own stream when the remote
                // publisher stops. Rebuilding only one side would break it.
                reconcile(id, member->second.sharing);
            }
            list();
        } else if (name == watchEvent()) {
            const auto member = members_.find(payload.value("senderSocketId").toString());
            if (member == members_.end() || !payload.value("watching").isBool()) return;
            member->second.watching = payload.value("watching").toBool();
            if (member->second.watching) requestLocalKeyframe();
        } else if (name == "kicked" || name == "session-replaced") leave();
        else if (name.startsWith("webrtc-") && !room_.isEmpty()) signal(name, payload);
    } catch (const std::exception&) { emit message("Não foi possível conectar uma transmissão. Tente entrar novamente na sala."); }
}
void ScreenCall::recover() {
    adaptBitrate(BitrateSignal::Calm);
    QStringList rebuild;
    for (const auto& [id, session] : peers_) {
        if (session->peer->connected()) {
            // ICE can be healthy while a lost initial IDR leaves the viewer without any picture.
            if (members_.at(id).sharing && !disabledVideo_.contains(id)
                && (session->rendered.isValid() ? session->rendered.elapsed() > 3000 : session->age.elapsed() > 2000))
                session->peer->requestKeyframe();
            continue;
        }
        if (self_ < id && session->age.elapsed() > 12000 && session->attempts < 3) rebuild.append(id);
        else if (!session->failureReported && session->age.elapsed() > (self_ < id ? 12000 : 60000)) {
            session->failureReported = true;
            emit message("Não foi possível conectar a tela de " + members_.at(id).name + ". Tente entrar novamente ou usar outra rede.");
        }
    }
    for (const auto& id : rebuild) { const auto attempts = peers_.at(id)->attempts + 1; create(id, attempts).peer->offer(); }
}
}
