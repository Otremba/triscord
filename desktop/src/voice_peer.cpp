#include "voice_peer.h"
#include "ice_config.h"
#include <QMutexLocker>
#include <QRandomGenerator>
#include <QPointer>

namespace triscord {
void VoicePeer::Dispatch::postAudio(QByteArray packet, uint32_t timestamp) {
    QMutexLocker lock(&mutex);
    if (!owner) return;
    if (audio.size() >= 10) audio.pop_front();
    audio.emplace_back(std::move(packet), timestamp);
    if (audioScheduled) return;
    audioScheduled = true;
    QMetaObject::invokeMethod(owner, [dispatch = shared_from_this()] {
        std::deque<std::pair<QByteArray, uint32_t>> packets;
        QPointer<VoicePeer> target;
        {
            QMutexLocker lock(&dispatch->mutex);
            target = dispatch->owner;
            packets.swap(dispatch->audio);
            dispatch->audioScheduled = false;
        }
        for (const auto& [bytes, timestamp] : packets) {
            if (!target) break;
            emit target->audioReceived(bytes, timestamp);
        }
    }, Qt::QueuedConnection);
}
void VoicePeer::Dispatch::post(std::function<void(VoicePeer*)> callback) {
    QMutexLocker lock(&mutex);
    if (owner) QMetaObject::invokeMethod(owner, [target = owner, callback = std::move(callback)] {
        callback(target);
    }, Qt::QueuedConnection);
}
VoicePeer::VoicePeer(const rtc::Configuration& config, QObject* parent)
    : QObject(parent), dispatch_(std::make_shared<Dispatch>()) {
    dispatch_->owner = this;
    auto manual = config;
    manual.disableAutoNegotiation = true;
    pc_ = std::make_shared<rtc::PeerConnection>(manual);
    const auto dispatch = dispatch_;
    pc_->onLocalDescription([dispatch](rtc::Description desc) {
        const auto sdp = QString::fromStdString(std::string(desc));
        const auto type = QString::fromStdString(desc.typeString());
        dispatch->post([sdp, type](VoicePeer* self) { emit self->localDescription(sdp, type); });
    });
    pc_->onLocalCandidate([dispatch](rtc::Candidate candidate) {
        const auto value = QString::fromStdString(std::string(candidate));
        const auto mid = QString::fromStdString(candidate.mid());
        dispatch->post([value, mid](VoicePeer* self) { emit self->localCandidate(value, mid); });
    });
    pc_->onStateChange([dispatch](rtc::PeerConnection::State state) {
        dispatch->post([state](VoicePeer* self) {
            if (state == rtc::PeerConnection::State::Connected) logSelectedPath("voice", *self->pc_);
            emit self->connectionChanged(state == rtc::PeerConnection::State::Connected);
            if (state == rtc::PeerConnection::State::Failed) emit self->failed();
        });
    });
    const auto ssrc = QRandomGenerator::global()->generate() | 1U;
    rtc::Description::Audio description("0", rtc::Description::Direction::SendRecv);
    description.addOpusCodec(111);
    description.addSSRC(ssrc, "triscord-mic", "triscord", "mic");
    audio_ = pc_->addTrack(description);
    auto configRtp = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, "triscord-mic", 111, VoiceRate);
    auto packetizer = std::make_shared<rtc::OpusRtpPacketizer>(configRtp);
    packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(configRtp));
    packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>());
    // Incoming chains run in reverse: RTCP must inspect the RTP header before
    // the depacketizer removes it. Outgoing runs forward and packetizes once.
    auto depacketizer = std::make_shared<rtc::OpusRtpDepacketizer>();
    depacketizer->addToChain(std::make_shared<rtc::RtcpReceivingSession>());
    depacketizer->addToChain(packetizer);
    audio_->setMediaHandler(depacketizer);
    audio_->onFrame([dispatch](rtc::binary bytes, rtc::FrameInfo info) {
        if (bytes.empty() || bytes.size() > 1275) return;
        const QByteArray packet(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        dispatch->postAudio(packet, info.timestamp);
    });
}
VoicePeer::~VoicePeer() {
    { QMutexLocker lock(&dispatch_->mutex); dispatch_->owner = nullptr; }
    audio_->resetCallbacks();
    pc_->resetCallbacks();
    audio_->close();
    pc_->close();
}
void VoicePeer::offer() { pc_->setLocalDescription(rtc::Description::Type::Offer); }
void VoicePeer::applyDescription(const QString& sdp, const QString& type) {
    pc_->setRemoteDescription(rtc::Description(sdp.toStdString(), type.toStdString()));
    if (type == "offer") pc_->setLocalDescription(rtc::Description::Type::Answer);
}
void VoicePeer::addCandidate(const QString& candidate, const QString& mid) {
    pc_->addRemoteCandidate(rtc::Candidate(candidate.toStdString(), mid.toStdString()));
}
bool VoicePeer::connected() const { return pc_->state() == rtc::PeerConnection::State::Connected; }
bool VoicePeer::sendOpus(const QByteArray& packet) {
    timestamp_ += VoiceSamples;
    if (!audio_->isOpen() || audio_->bufferedAmount() > 4096) return false;
    audio_->sendFrame(reinterpret_cast<const rtc::byte*>(packet.constData()), packet.size(), rtc::FrameInfo(timestamp_));
    return true;
}
}
