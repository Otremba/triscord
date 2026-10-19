#include "video_peer.h"
#include "ice_config.h"
#include <QMutexLocker>
#include <QPointer>
#include <QRandomGenerator>
#include <rtc/plihandler.hpp>
#include <stdexcept>
#include <mutex>
#include <chrono>
#include <cstdio>

namespace triscord {
void VideoPeer::Dispatch::audioFrame(QByteArray packet, uint32_t timestamp) {
    QMutexLocker lock(&mutex); if (!owner) return;
    if (audio.size() >= 10) audio.pop_front(); audio.emplace_back(std::move(packet), timestamp);
    if (audioScheduled) return; audioScheduled = true;
    QMetaObject::invokeMethod(owner, [dispatch = shared_from_this()] {
        std::deque<std::pair<QByteArray, uint32_t>> packets; QPointer<VideoPeer> target;
        { QMutexLocker lock(&dispatch->mutex); target = dispatch->owner; packets.swap(dispatch->audio); dispatch->audioScheduled = false; }
        for (const auto& [packet, timestamp] : packets) { if (!target) break; emit target->audioReceived(packet, timestamp); }
    }, Qt::QueuedConnection);
}
namespace {
class BoundedH264 final : public rtc::MediaHandler {
public:
    std::function<void()> recovery;
    void incoming(rtc::message_vector& messages, const rtc::message_callback& send) override {
        std::lock_guard lock(mutex_);
        rtc::message_vector result;
        const auto now = std::chrono::steady_clock::now();
        for (const auto& message : messages) {
            if (message->type == rtc::Message::Control) { result.push_back(message); continue; }
            if (message->size() > 1500) {
                assembler_.push({}); assembler_.takeRecoveryRequest();
                if (recovery) recovery();
                continue;
            }
            const QByteArray rtp(reinterpret_cast<const char*>(message->data()), qsizetype(message->size()));
            auto ordered = reorder_.push(rtp, now);
            if (!ordered.nack.empty()) {
                const auto ssrc = uint32_t(uint8_t(rtp[8])) << 24 | uint32_t(uint8_t(rtp[9])) << 16 | uint32_t(uint8_t(rtp[10])) << 8 | uint8_t(rtp[11]);
                const auto nack = rtcpNack(ssrc, ordered.nack);
                if (!nack.isEmpty()) send(rtc::make_message(reinterpret_cast<const rtc::byte*>(nack.constData()),
                    reinterpret_cast<const rtc::byte*>(nack.constData()) + nack.size(), rtc::Message::Control));
            }
            lost_ += ordered.lost;
            for (const auto& packet : ordered.ready) {
                auto frame = assembler_.push(packet);
                if (assembler_.takeRecoveryRequest() && recovery) recovery();
                if (frame) {
                    auto info = std::make_shared<rtc::FrameInfo>(frame->timestamp);
                    info->payloadType = 102;
                    result.push_back(rtc::make_message(reinterpret_cast<const rtc::byte*>(frame->annexB.constData()),
                        reinterpret_cast<const rtc::byte*>(frame->annexB.constData()) + frame->annexB.size(), info));
                }
            }
        }
        // For the log a user can send: whether a bad stream is packet loss on the way (19/10, "maybe his internet").
        if (now - reported_ >= std::chrono::seconds(10)) {
            const int recovered = reorder_.recovered() - reportedRecovered_;
            if (recovered || lost_) {
                std::printf("video: %d lost packets recovered by retransmission, %d unrecoverable (last 10 s)\n", recovered, lost_);
                std::fflush(stdout);
            }
            reported_ = now; reportedRecovered_ = reorder_.recovered(); lost_ = 0;
        }
        messages.swap(result);
    }
private:
    std::mutex mutex_;
    VideoRtpReorder reorder_;
    VideoRtpAssembler assembler_;
    std::chrono::steady_clock::time_point reported_ = std::chrono::steady_clock::now();
    int reportedRecovered_ = 0, lost_ = 0;
};
bool idr(const QByteArray& bytes) {
    bool idr = false, sps = false, pps = false;
    for (qsizetype n = 0; n + 3 < bytes.size(); ++n) {
        if (bytes[n] || bytes[n + 1]) continue;
        const auto skip = bytes[n + 2] == 1 ? 3 : (n + 4 < bytes.size() && !bytes[n + 2] && bytes[n + 3] == 1 ? 4 : 0);
        if (skip) {
            const auto type = uint8_t(bytes[n + skip]) & 31;
            idr |= type == 5; sps |= type == 7; pps |= type == 8;
        }
    }
    return idr && sps && pps;
}
}
void VideoPeer::Dispatch::post(std::function<void(VideoPeer*)> callback) {
    QMutexLocker lock(&mutex);
    if (owner) QMetaObject::invokeMethod(owner, [target = owner, callback = std::move(callback)] { callback(target); }, Qt::QueuedConnection);
}
void VideoPeer::Dispatch::schedule() {
    if (!owner || scheduled) return;
    scheduled = true;
    QMetaObject::invokeMethod(owner, [dispatch = shared_from_this()] {
        std::deque<ReceivedVideo> values;
        QPointer<VideoPeer> target;
        bool reset = false, request = false;
        {
            QMutexLocker lock(&dispatch->mutex);
            target = dispatch->owner; values.swap(dispatch->frames);
            reset = dispatch->reset; request = dispatch->request;
            dispatch->reset = dispatch->request = dispatch->scheduled = false;
        }
        if (!target) return;
        if (request) target->requestKeyframe();
        if (reset && target) emit target->recoveryNeeded();
        for (const auto& value : values) {
            if (!target) break;
            emit target->videoReceived(value.annexB, value.timestamp, value.keyframe);
        }
    }, Qt::QueuedConnection);
}
void VideoPeer::Dispatch::frame(ReceivedVideo value) {
    QMutexLocker lock(&mutex);
    if (!owner) return;
    // A retransmission releases the frames held behind it at once: only a real backlog (200 ms at 60 fps) is overload.
    if (frames.size() >= 12) { frames.clear(); waiting = reset = request = true; }
    if (waiting && !value.keyframe) { request = true; schedule(); return; }
    if (value.keyframe) waiting = false;
    frames.push_back(std::move(value)); schedule();
}
void VideoPeer::Dispatch::recover() {
    QMutexLocker lock(&mutex);
    if (!owner) return;
    frames.clear();
    if (!waiting) reset = true;
    waiting = request = true; schedule();
}
void VideoPeer::Dispatch::pli() {
    QMutexLocker lock(&mutex);
    if (!owner || pliScheduled) return;
    pliScheduled = true;
    QMetaObject::invokeMethod(owner, [dispatch = shared_from_this()] {
        QPointer<VideoPeer> target;
        { QMutexLocker lock(&dispatch->mutex); target = dispatch->owner; dispatch->pliScheduled = false; }
        if (target && (!target->lastRemotePli_.isValid() || target->lastRemotePli_.elapsed() >= 250)) {
            target->lastRemotePli_.start(); emit target->keyframeRequested();
        }
    }, Qt::QueuedConnection);
}
VideoPeer::VideoPeer(const rtc::Configuration& config, QObject* parent, bool withAudio)
    : QObject(parent), videoMid_(withAudio ? "screen" : "camera"), dispatch_(std::make_shared<Dispatch>()) {
    dispatch_->owner = this;
    auto manual = config; manual.disableAutoNegotiation = true;
    pc_ = std::make_shared<rtc::PeerConnection>(manual);
    const auto dispatch = dispatch_;
    pc_->onLocalDescription([dispatch](rtc::Description description) {
        const auto sdp = QString::fromStdString(std::string(description)), type = QString::fromStdString(description.typeString());
        dispatch->post([sdp, type](VideoPeer* self) { emit self->localDescription(sdp, type); });
    });
    pc_->onLocalCandidate([dispatch](rtc::Candidate candidate) {
        const auto value = QString::fromStdString(std::string(candidate)), mid = QString::fromStdString(candidate.mid());
        dispatch->post([value, mid](VideoPeer* self) { emit self->localCandidate(value, mid); });
    });
    pc_->onStateChange([dispatch](rtc::PeerConnection::State state) {
        dispatch->post([state](VideoPeer* self) {
            if (state == rtc::PeerConnection::State::Connected) logSelectedPath("video", *self->pc_);
            const QPointer<VideoPeer> target(self);
            emit self->connectionChanged(state == rtc::PeerConnection::State::Connected);
            if (target && state == rtc::PeerConnection::State::Failed) emit target->failed();
        });
    });
    const auto ssrc = QRandomGenerator::global()->generate() | 1U;
    const auto mid = videoMid_.toStdString();
    rtc::Description::Video description(mid, rtc::Description::Direction::SendRecv);
    description.addH264Codec(102, "packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=42e02a");
    description.addSSRC(ssrc, "triscord-" + mid, "triscord", mid);
    video_ = pc_->addTrack(description);
    auto configRtp = std::make_shared<rtc::RtpPacketizationConfig>(ssrc, "triscord-" + mid, 102, 90000);
    auto packetizer = std::make_shared<rtc::H264RtpPacketizer>(rtc::NalUnit::Separator::StartSequence, configRtp, 1100);
    packetizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(configRtp));
    packetizer->addToChain(std::make_shared<rtc::PliHandler>([dispatch] { dispatch->pli(); }));
    packetizer->addToChain(std::make_shared<rtc::RtcpNackResponder>(256));
    auto depacketizer = std::make_shared<BoundedH264>();
    depacketizer->recovery = [dispatch] { dispatch->recover(); };
    depacketizer->addToChain(std::make_shared<rtc::RtcpReceivingSession>());
    depacketizer->addToChain(packetizer);
    video_->setMediaHandler(depacketizer);
    video_->onFrame([dispatch](rtc::binary bytes, rtc::FrameInfo info) {
        if (bytes.empty() || bytes.size() > size_t(VideoFrameLimit)) { dispatch->recover(); return; }
        QByteArray data(reinterpret_cast<const char*>(bytes.data()), qsizetype(bytes.size()));
        const bool keyframe = idr(data);
        dispatch->frame({std::move(data), info.timestamp, keyframe});
    });
    if (!withAudio) return;
    const auto audioSsrc = QRandomGenerator::global()->generate() | 1U;
    rtc::Description::Audio audioDescription("screen-audio", rtc::Description::Direction::SendRecv);
    audioDescription.addOpusCodec(111); audioDescription.addSSRC(audioSsrc, "triscord-screen-audio", "triscord", "screen-audio");
    audio_ = pc_->addTrack(audioDescription);
    auto audioConfig = std::make_shared<rtc::RtpPacketizationConfig>(audioSsrc, "triscord-screen-audio", 111, 48000);
    auto audioPacketizer = std::make_shared<rtc::OpusRtpPacketizer>(audioConfig);
    audioPacketizer->addToChain(std::make_shared<rtc::RtcpSrReporter>(audioConfig));
    audioPacketizer->addToChain(std::make_shared<rtc::RtcpNackResponder>(64));
    auto audioReceiver = std::make_shared<rtc::OpusRtpDepacketizer>();
    audioReceiver->addToChain(std::make_shared<rtc::RtcpReceivingSession>()); audioReceiver->addToChain(audioPacketizer);
    audio_->setMediaHandler(audioReceiver);
    audio_->onFrame([dispatch](rtc::binary bytes, rtc::FrameInfo info) {
        if (bytes.empty() || bytes.size() > 1275) return;
        dispatch->audioFrame(QByteArray(reinterpret_cast<const char*>(bytes.data()), qsizetype(bytes.size())), info.timestamp);
    });
}
VideoPeer::~VideoPeer() {
    if (audio_) { audio_->resetCallbacks(); audio_->close(); }
    { QMutexLocker lock(&dispatch_->mutex); dispatch_->owner = nullptr; dispatch_->frames.clear(); }
    video_->resetCallbacks(); pc_->resetCallbacks(); video_->close(); pc_->close();
}
void VideoPeer::offer() { pc_->setLocalDescription(rtc::Description::Type::Offer); }
void VideoPeer::applyDescription(const QString& sdp, const QString& type) {
    if (sdp.size() > 262144 || (type != "offer" && type != "answer")) throw std::invalid_argument("Invalid screen SDP");
    pc_->setRemoteDescription(rtc::Description(sdp.toStdString(), type.toStdString()));
    if (type == "offer") pc_->setLocalDescription(rtc::Description::Type::Answer);
}
void VideoPeer::addCandidate(const QString& candidate, const QString& mid) {
    if (candidate.size() > 4096 || (mid != videoMid_ && (!audio_ || mid != "screen-audio"))) throw std::invalid_argument("Invalid video candidate");
    pc_->addRemoteCandidate(rtc::Candidate(candidate.toStdString(), mid.toStdString()));
}
bool VideoPeer::connected() const { return pc_->state() == rtc::PeerConnection::State::Connected && video_->isOpen(); }
bool VideoPeer::sendAudio(const QByteArray& opus) {
    if (!audio_ || opus.isEmpty() || opus.size() > 1275) return false;
    audioTimestamp_ += 960;
    if (!audio_->isOpen() || audio_->bufferedAmount() > 4096) return false;
    audio_->sendFrame(reinterpret_cast<const rtc::byte*>(opus.constData()), size_t(opus.size()), rtc::FrameInfo(audioTimestamp_)); return true;
}
bool VideoPeer::sendVideo(const EncodedVideo& frame) {
    if (frame.annexB.isEmpty() || frame.annexB.size() > VideoFrameLimit || frame.time100ns < 0 || frame.time100ns <= lastSent_)
        throw std::invalid_argument("Invalid screen video frame");
    if (!connected()) return false;
    if (video_->bufferedAmount() > 256 * 1024) {
        emit congested();
        sendWaitingForIdr_ = true; dispatch_->pli(); return false;
    }
    const bool keyframe = idr(frame.annexB);
    if (sendWaitingForIdr_ && !keyframe) return false;
    const auto time = uint64_t(frame.time100ns);
    const uint32_t timestamp = uint32_t((time / 10000000) * 90000 + (time % 10000000) * 9 / 1000);
    video_->sendFrame(reinterpret_cast<const rtc::byte*>(frame.annexB.constData()), size_t(frame.annexB.size()), rtc::FrameInfo(timestamp));
    lastSent_ = frame.time100ns; sendWaitingForIdr_ = false;
    return true;
}
bool VideoPeer::requestKeyframe() {
    if (!connected() || (lastPli_.isValid() && lastPli_.elapsed() < 250)) return false;
    const bool sent = video_->requestKeyframe();
    if (sent) lastPli_.start();
    return sent;
}
}
