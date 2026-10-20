#include "voice_call.h"
#include "ice_config.h"
#include <QUuid>
#include <cstdio>
#include <cmath>
#include <QUrl>

namespace triscord {
VoiceCall::VoiceCall(Signaling* signaling, QObject* parent, AudioMode mode)
    : QObject(parent), signaling_(signaling), devices_(this), useDevices_(mode == AudioMode::Devices) {
    if (useDevices_) {
        for (auto& server : toRtcIceServers(resolveIceServers())) config_.iceServers.push_back(server);
    }
    recovery_.setParent(this);
    playout_.setParent(this);
    connect(signaling_, &Signaling::sessionStarted, this, [this](const QString& id) { socketIdentity_ = id; });
    connect(this, &VoiceCall::outboundEvent, signaling_, [signaling](const QString& name, const QJsonObject& payload) {
        signaling->sendEvent(name, payload); // Runs on the socket's owning thread.
    });
    connect(signaling_, &Signaling::eventReceived, this, &VoiceCall::event);
    connect(signaling_, &Signaling::disconnected, this, &VoiceCall::leave);
    connect(&devices_, &VoiceDevices::error, this, &VoiceCall::message);
    connect(&devices_, &VoiceDevices::captured, this, &VoiceCall::sendOpus);
    connect(&devices_, &VoiceDevices::speakingWhileMuted, this, &VoiceCall::speakingWhileMuted);
    connect(&devices_, &VoiceDevices::speakingChanged, this, [this](bool active) { if (!self_.isEmpty()) emit speakingChanged(self_, active); });
    connect(&devices_, &VoiceDevices::devicesChanged, this, &VoiceCall::devicesChanged);
    connect(&devices_, &VoiceDevices::runningChanged, this, [this](bool ready) { emit activeChanged(ready && !room_.isEmpty()); });
    recovery_.setInterval(2000);
    connect(&recovery_, &QTimer::timeout, this, &VoiceCall::recover);
    playout_.setTimerType(Qt::PreciseTimer);
    playout_.setInterval(20);
    synthetic_ = !useDevices_ && qEnvironmentVariable("TRISCORD_SYNTHETIC_VOICE") == "1";
    // With speakers, the playback tick pulls these frames (VoiceDevices::setFrameSource) so the sound card's clock, not
    // a second free-running timer, paces the jitter buffers; this timer only covers deafened, deviceless and test runs.
    if (useDevices_) devices_.setFrameSource([this] { playoutTick(); });
    connect(&playout_, &QTimer::timeout, this, [this] { if (!(useDevices_ && devices_.pulling())) playoutTick(); });
}
void VoiceCall::playoutTick() {
    if (synthetic_) syntheticTick();
    for (auto& [id, session] : peers_) {
        if (serverMutedPeers_.contains(id)) continue;
        try {
            if (const auto frame = session->jitter.pop()) {
                if (useDevices_) devices_.enqueue(id, *frame);
                if (session->activity.update(&*frame)) emit speakingChanged(id, session->activity.active());
                if (synthetic_) {
                    double energy = 0; for (float v : *frame) energy += double(v) * v; energy /= VoiceSamples;
                    if (energy > 1e-6) { auto& h = heard_[id]; h.first += energy; if (++h.second % 100 == 0) {
                        std::printf("voice: heard peer at %.1f dBFS over %d speech frames\n", 10 * std::log10(h.first / h.second), h.second); std::fflush(stdout); } }
                }
                emit remoteAudio(id, *frame);
            } else if (session->activity.update(nullptr)) emit speakingChanged(id, false);
        } catch (const std::exception&) { /* Invalid packets are dropped. */ }
    }
}
VoiceCall::~VoiceCall() { leave(); }
void VoiceCall::setDevices(const QByteArray& input, const QByteArray& output) {
    if (useDevices_) devices_.setDevices(input, output);
}
void VoiceCall::sendOpus(const QByteArray& packet) {
    if (serverMuted_) return;
    if (packet.isEmpty() || packet.size() > 1275) return;
    for (auto& [id, session] : peers_) {
        try { session->peer->sendOpus(packet); }
        catch (const std::exception&) { emit message("A voz de um participante precisa reconectar."); }
    }
}
void VoiceCall::setMuted(bool muted) { devices_.setMuted(muted || serverMuted_); syntheticMuted_ = muted || serverMuted_; }
void VoiceCall::syntheticTick() {
    if (room_.isEmpty()) return;
    VoiceFrame frame{};
    const bool talking = (syntheticFrame_ / 25) % 3 != 2;   // 1 s talking, 0.5 s pause
    for (int i = 0; i < VoiceSamples; ++i) {
        const double t = double(syntheticFrame_ * VoiceSamples + i) / VoiceRate;
        const double noise = 0.0005 * std::sin(2 * 3.141592653589793 * 3733 * t + 0.7 * std::sin(91 * t));
        const double envelope = 0.5 + 0.5 * std::sin(2 * 3.141592653589793 * 4 * t);
        const double voice = std::sin(2 * 3.141592653589793 * 180 * t) + 0.6 * std::sin(2 * 3.141592653589793 * 360 * t) + 0.4 * std::sin(2 * 3.141592653589793 * 720 * t);
        frame[i] = float(noise + (talking ? 0.012 * envelope * voice : 0.0));
    }
    ++syntheticFrame_;
    if (syntheticMuted_) { if (syntheticActivity_.reset() && !self_.isEmpty()) emit speakingChanged(self_, false); return; }
    const auto processed = syntheticProcessor_.process(frame, {});
    if (syntheticActivity_.update(&processed) && !self_.isEmpty()) emit speakingChanged(self_, syntheticActivity_.active());
    sendOpus(syntheticEncoder_.encode(processed));
}
void VoiceCall::setDeafened(bool deafened) { devices_.setDeafened(deafened); }
void VoiceCall::leave() {
    for (const auto& [id, session] : peers_) {
        if (session->activity.active()) emit speakingChanged(id, false);
        devices_.removePeer(id);
    }
    recovery_.stop(); playout_.stop(); devices_.stop(); peers_.clear(); room_.clear(); self_.clear();
    serverMutedPeers_.clear(); serverMuted_ = false;
    devices_.setMuted(true); devices_.setDeafened(false);
    emit activeChanged(false);
}
VoiceCall::Session& VoiceCall::create(const QString& id, int attempts) {
    removeMember(id, false);
    auto session = std::make_unique<Session>();
    session->localSession = QUuid::createUuid().toString(QUuid::WithoutBraces);
    session->attempts = attempts;
    // Current servers for every new peer: the session's TURN relays (GET /ice, refreshed by the core) can arrive
    // after this call object was created, and they expire. 18/10: a call between two homes had no audio because
    // the list was fixed at startup (STUN only) and then replaced by the hub's STUN-only push.
    if (useDevices_ || iceRelayOnly()) {
        config_.iceServers = toRtcIceServers(resolveIceServers());
        config_.iceServers.insert(config_.iceServers.end(), pushedIce_.begin(), pushedIce_.end());
    }
    if (iceRelayOnly()) config_.iceTransportPolicy = rtc::TransportPolicy::Relay;
    session->peer = std::make_unique<VoicePeer>(config_, this);
    session->age.start();
    const auto generation = session->localSession;
    connect(session->peer.get(), &VoicePeer::localDescription, this, [this, id, generation](const QString& sdp, const QString& type) {
        auto it = peers_.find(id);
        if (it == peers_.end() || it->second->localSession != generation) return;
        QJsonObject signal{{"targetSocketId", id}, {"session", generation}, {"type", "voice"},
                          {type == "offer" ? "offer" : "answer", QJsonObject{{"type", type}, {"sdp", sdp}}}};
        if (!it->second->remoteSession.isEmpty()) signal.insert("targetSession", it->second->remoteSession);
        emit outboundEvent(type == "offer" ? "webrtc-offer" : "webrtc-answer", signal);
    });
    connect(session->peer.get(), &VoicePeer::localCandidate, this, [this, id, generation](const QString& candidate, const QString& mid) {
        auto it = peers_.find(id);
        if (it == peers_.end() || it->second->localSession != generation) return;
        QJsonObject signal{{"targetSocketId", id}, {"session", generation}, {"type", "voice"},
                          {"candidate", QJsonObject{{"candidate", candidate}, {"sdpMid", mid}}}};
        if (!it->second->remoteSession.isEmpty()) signal.insert("targetSession", it->second->remoteSession);
        emit outboundEvent("webrtc-ice-candidate", signal);
    });
    connect(session->peer.get(), &VoicePeer::audioReceived, this, [this, id, generation](const QByteArray& packet, uint32_t timestamp) {
        auto it = peers_.find(id);
        if (it == peers_.end() || it->second->localSession != generation) return;
        if (!serverMutedPeers_.contains(id)) it->second->jitter.push(timestamp, packet);
    });
    connect(session->peer.get(), &VoicePeer::connectionChanged, this, [this, id, generation](bool ready) {
        auto it = peers_.find(id);
        if (it == peers_.end() || it->second->localSession != generation) return;
        it->second->age.restart();
        if (ready) {
            it->second->attempts = 0;
            it->second->failureReported = false;
            emit message("Voz conectada.");
        }
    });
    auto& result = *session;
    peers_[id] = std::move(session);
    return result;
}
void VoiceCall::removeMember(const QString& id, bool forgetSettings) {
    if (const auto it = peers_.find(id); it != peers_.end() && it->second->activity.active()) emit speakingChanged(id, false);
    if (forgetSettings) devices_.removePeer(id); else devices_.resetPeerAudio(id);
    peers_.erase(id);
}
void VoiceCall::addMember(const QString& id) {
    if (id.isEmpty() || id == self_ || peers_.contains(id) || peers_.size() >= 9) return;
    auto& session = create(id);
    if (self_ < id) session.peer->offer(); // Exactly one offerer, independent of join order.
}
void VoiceCall::event(const QString& name, const QJsonArray& args) {
    if (args.isEmpty()) return;
    const auto payload = args.first().toObject();
    try {
        if (name == "ice-servers") {
            if (!useDevices_) return; // Injected local tests never contact STUN/TURN services.
            config_.iceTransportPolicy = args.size() > 1 && args.at(1).toString() == "relay"
                ? rtc::TransportPolicy::Relay : rtc::TransportPolicy::All;
            pushedIce_.clear();
            for (const auto& value : args.first().toArray()) {
                const auto server = value.toObject();
                const auto urls = server.value("urls").isArray() ? server.value("urls").toArray() : QJsonArray{server.value("urls")};
                for (const auto& valueUrl : urls) {
                    try {
                        rtc::IceServer ice(valueUrl.toString().toStdString());
                        ice.username = server.value("username").toString().toStdString();
                        ice.password = server.value("credential").toString().toStdString();
                        pushedIce_.push_back(std::move(ice));
                    } catch (const std::exception&) { /* Unsupported ICE endpoint. */ }
                }
            }
        } else if (name == "room-joined") {
            leave();
            self_ = socketIdentity_;
            room_ = payload.value("roomId").toString();
            serverMuted_ = payload.value("isServerMuted").toBool();
            if (useDevices_) devices_.start(); // Chat and sessions survive unavailable devices.
            else emit activeChanged(true);
            for (const auto& user : payload.value("existingUsers").toArray()) {
                const auto data = user.toObject(); const auto id = data.value("socketId").toString();
                if (data.value("isServerMuted").toBool()) serverMutedPeers_.insert(id);
                addMember(id);
            }
            recovery_.start();
            playout_.start();
            std::printf("voice: joined the room with %d other(s)\n", int(peers_.size())); std::fflush(stdout);
        } else if (name == "user-joined" && !room_.isEmpty()) {
            const auto id = payload.value("socketId").toString();
            if (payload.value("userData").toObject().value("isServerMuted").toBool()) serverMutedPeers_.insert(id);
            addMember(id);
            std::printf("voice: peer %s joined\n", qPrintable(id.left(6))); std::fflush(stdout);
        } else if (name == "user-left") {
            const auto id = payload.value("socketId").toString(); removeMember(id); serverMutedPeers_.remove(id);
            std::printf("voice: peer %s left\n", qPrintable(id.left(6))); std::fflush(stdout);
        }
        else if (name == "user-state-updated" && payload.value("state").toObject().contains("isServerMuted")) {
            const auto id = payload.value("socketId").toString(); const bool muted = payload.value("state").toObject().value("isServerMuted").toBool();
            if (id == self_) { serverMuted_ = muted; if (muted) devices_.setMuted(true); }
            else if (const auto peer = peers_.find(id); peer != peers_.end()) {
                if (muted) serverMutedPeers_.insert(id); else serverMutedPeers_.remove(id);
                devices_.resetPeerAudio(id); peer->second->jitter = VoiceJitter{};
                if (peer->second->activity.reset()) emit speakingChanged(id, false);
            }
        }
        else if (name == "kicked" || name == "session-replaced") leave();
        else if (name.startsWith("webrtc-") && !room_.isEmpty()) receiveSignal(name, payload);
    } catch (const std::exception& error) {
        std::printf("voice: %s failed: %s\n", qPrintable(name), error.what()); std::fflush(stdout);
        emit message("Não foi possível estabelecer a voz. Tente entrar novamente.");
    }
}
void VoiceCall::receiveSignal(const QString& name, const QJsonObject& payload) {
    const auto kind = payload.value("type").toString();
    if (kind != "voice" && !(kind.isEmpty() && name == "webrtc-ice-candidate" &&
        payload.value("candidate").toObject().value("sdpMid").toString() == "0")) return;
    const auto id = payload.value("senderSocketId").toString();
    auto it = peers_.find(id);
    if (it == peers_.end()) return; // Only peers announced in this room.
    auto* session = it->second.get();
    const auto remote = payload.value("session").toString();
    const auto target = payload.value("targetSession").toString();
    if (!target.isEmpty() && target != session->localSession) return;
    if (name == "webrtc-offer") {
        if (self_ < id) return; // Reject glare / unexpected offerer.
        if (!session->remoteSession.isEmpty() && session->remoteSession != remote) session = &create(id);
        session->remoteSession = remote;
        session->peer->applyDescription(payload.value("offer").toObject().value("sdp").toString(), "offer");
        session->remoteDescription = true;
    } else if (name == "webrtc-answer") {
        if (!session->remoteSession.isEmpty() && session->remoteSession != remote) return;
        session->remoteSession = remote;
        session->peer->applyDescription(payload.value("answer").toObject().value("sdp").toString(), "answer");
        session->remoteDescription = true;
    } else if (name == "webrtc-ice-candidate") {
        if (!session->remoteSession.isEmpty() && session->remoteSession != remote) return;
        if (session->candidates.size() < 200) session->candidates.append(payload);
    }
    if (!session->remoteDescription) return;
    const auto candidates = session->candidates;
    session->candidates = {};
    for (const auto& queued : candidates) {
        const auto signal = queued.toObject();
        if (!session->remoteSession.isEmpty() && signal.value("session").toString() != session->remoteSession) continue;
        const auto candidate = signal.value("candidate").toObject();
        if (!candidate.value("candidate").toString().isEmpty()) {
            try { session->peer->addCandidate(candidate.value("candidate").toString(), candidate.value("sdpMid").toString()); }
            catch (const std::exception&) { /* Discard stale candidates. */ }
        }
    }
}
void VoiceCall::recover() {
    QStringList rebuild;
    for (auto& [id, session] : peers_) {
        if (self_ < id && !session->peer->connected() && session->age.elapsed() > 12000 && session->attempts < 3) rebuild.append(id);
        else if (self_ < id && !session->peer->connected() && session->age.elapsed() > 12000 && !session->failureReported) {
            session->failureReported = true;
            std::printf("voice: gave up connecting to peer %s after %d attempts\n", qPrintable(id.left(6)), session->attempts + 1); std::fflush(stdout);
            emit message("Não foi possível conectar a voz de um participante. Confira a rede e entre novamente na sala.");
        }
    }
    for (const auto& id : rebuild) {
        const int attempts = peers_.at(id)->attempts + 1;
        auto& session = create(id, attempts);
        session.peer->offer();
        std::printf("voice: no connection to peer %s after 12 s, retrying (attempt %d)\n", qPrintable(id.left(6)), attempts + 1); std::fflush(stdout);
        emit message("Reconectando a voz de um participante.");
    }
}
}
