#include "video_rtp.h"
#include <bit>
#include <vector>
#include <algorithm>

namespace triscord {
std::optional<qint64> VideoRtpClock::accept(uint32_t timestamp) {
    if (!last_) { last_ = timestamp; return 0; }
    const auto difference = std::bit_cast<int32_t>(uint32_t(timestamp - *last_));
    if (difference <= 0) return {};
    elapsed_ += uint32_t(difference); last_ = timestamp;
    return qint64(elapsed_ / 90000 * 10000000 + elapsed_ % 90000 * 10000000 / 90000);
}
namespace {
uint8_t byte(const QByteArray& data, qsizetype n) { return uint8_t(data[n]); }
uint16_t word(const QByteArray& data, qsizetype n) { return uint16_t(byte(data, n) << 8 | byte(data, n + 1)); }
uint32_t dword(const QByteArray& data, qsizetype n) { return uint32_t(word(data, n)) << 16 | word(data, n + 2); }
int distance(uint16_t value, uint16_t reference) { return std::bit_cast<int16_t>(uint16_t(value - reference)); }
}
void VideoRtpAssembler::discard() {
    packets_.clear(); bytes_ = 0; dropping_ = true;
    waitingForIdr_ = true; recovery_ = true;
}
bool VideoRtpAssembler::takeRecoveryRequest() { const auto result = recovery_; recovery_ = false; return result; }
std::optional<ReceivedVideo> VideoRtpAssembler::push(const QByteArray& rtp) {
    if (rtp.size() < 12 || rtp.size() > 1500 || (byte(rtp, 0) >> 6) != 2 || (byte(rtp, 1) & 127) != 102) {
        discard(); return {};
    }
    qsizetype offset = 12 + 4 * (byte(rtp, 0) & 15);
    if (offset > rtp.size()) { discard(); return {}; }
    if (byte(rtp, 0) & 16) {
        if (offset + 4 > rtp.size()) { discard(); return {}; }
        offset += 4 + 4 * word(rtp, offset + 2);
    }
    qsizetype end = rtp.size();
    if (byte(rtp, 0) & 32) {
        const int padding = byte(rtp, end - 1);
        if (!padding || padding > end - offset) { discard(); return {}; }
        end -= padding;
    }
    if (offset >= end) { discard(); return {}; }
    const auto stamp = dword(rtp, 4), ssrc = dword(rtp, 8);
    const auto sequence = word(rtp, 2);
    if (ssrc_ && *ssrc_ != ssrc) { discard(); return {}; }
    ssrc_ = ssrc;
    if (timestamp_ && stamp != *timestamp_) {
        if (std::bit_cast<int32_t>(uint32_t(stamp - *timestamp_)) <= 0) return {};
        if (!completed_) discard();
        expectedFirst_ = marker_ ? std::optional<uint16_t>(uint16_t(*marker_ + 1)) : std::nullopt;
        packets_.clear(); bytes_ = 0; marker_.reset(); dropping_ = completed_ = false;
    }
    if (!timestamp_) dropping_ = completed_ = false;
    if (!timestamp_ || stamp != *timestamp_) { timestamp_ = stamp; started_ = std::chrono::steady_clock::now(); }
    if (completed_ || dropping_) return {};
    if (std::chrono::steady_clock::now() - started_ > std::chrono::milliseconds(200)) { discard(); return {}; }
    if (packets_.contains(sequence)) return {}; // Duplicate does not consume capacity.
    if ((expectedFirst_ && (distance(sequence, *expectedFirst_) < 0 || distance(sequence, *expectedFirst_) >= VideoPacketLimit)) ||
        packets_.size() >= size_t(VideoPacketLimit) || bytes_ + end - offset > VideoFrameLimit) { discard(); return {}; }
    if (byte(rtp, 1) & 128) {
        if (marker_ && *marker_ != sequence) { discard(); return {}; }
        marker_ = sequence;
    }
    packets_.emplace(sequence, rtp.mid(offset, end - offset)); bytes_ += end - offset;
    return assemble();
}
std::optional<ReceivedVideo> VideoRtpAssembler::assemble() {
    if (!marker_) return {};
    std::vector<std::pair<uint16_t, const QByteArray*>> ordered;
    for (const auto& [sequence, payload] : packets_) {
        const int relative = distance(sequence, *marker_);
        if (relative > 0 || relative <= -VideoPacketLimit) { discard(); return {}; }
        ordered.emplace_back(sequence, &payload);
    }
    std::sort(ordered.begin(), ordered.end(), [&](const auto& a, const auto& b) { return distance(a.first, *marker_) < distance(b.first, *marker_); });
    if (expectedFirst_ && ordered.front().first != *expectedFirst_) return {};
    for (size_t n = 1; n < ordered.size(); ++n)
        if (uint16_t(ordered[n - 1].first + 1) != ordered[n].first) return {};
    QByteArray frame;
    const QByteArray separator = QByteArray::fromHex("00000001");
    bool fragment = false, idr = false, sps = false, pps = false;
    uint8_t fragmentHeader = 0;
    auto addNal = [&](const QByteArray& nal) {
        if (nal.isEmpty() || (byte(nal, 0) & 128) || !(byte(nal, 0) & 31) || (byte(nal, 0) & 31) >= 24) return false;
        const auto type = byte(nal, 0) & 31;
        idr |= type == 5; sps |= type == 7; pps |= type == 8;
        frame += separator; frame += nal; return true;
    };
    for (const auto& [sequence, ptr] : ordered) {
        (void)sequence;
        const auto& payload = *ptr;
        const auto header = byte(payload, 0);
        const auto type = header & 31;
        if (header & 128) { discard(); return {}; }
        if (type == 28) {
            if (payload.size() <= 2) { discard(); return {}; }
            const auto fu = byte(payload, 1);
            const auto original = uint8_t((header & 224) | (fu & 31));
            if ((fu & 32) || !(fu & 31) || (fu & 31) >= 24 || (fu & 192) == 192) { discard(); return {}; }
            if (fu & 128) {
                if (fragment) { discard(); return {}; }
                fragment = true; fragmentHeader = original;
                idr |= (fu & 31) == 5; sps |= (fu & 31) == 7; pps |= (fu & 31) == 8;
                frame += separator; frame += char(original);
            } else if (!fragment) return {}; // Earlier start may still arrive reordered.
            if (original != fragmentHeader) { discard(); return {}; }
            frame += payload.mid(2);
            if (fu & 64) fragment = false;
        } else if (type == 24) {
            if (fragment) { discard(); return {}; }
            qsizetype offset = 1;
            while (offset < payload.size()) {
                if (offset + 2 > payload.size()) { discard(); return {}; }
                const auto length = word(payload, offset); offset += 2;
                if (!length || offset + length > payload.size() || !addNal(payload.mid(offset, length))) { discard(); return {}; }
                offset += length;
            }
        } else if (fragment || !addNal(payload)) { discard(); return {}; }
        if (frame.size() > VideoFrameLimit) { discard(); return {}; }
    }
    if (fragment || frame.isEmpty()) { discard(); return {}; }
    completed_ = true; packets_.clear(); bytes_ = 0;
    if (waitingForIdr_ && !(idr && sps && pps)) { recovery_ = true; return {}; }
    waitingForIdr_ = false;
    return ReceivedVideo{std::move(frame), *timestamp_, idr};
}
VideoRtpReorder::Result VideoRtpReorder::push(const QByteArray& rtp, std::chrono::steady_clock::time_point now) {
    Result result;
    if (rtp.size() < 12) { result.ready.push_back(rtp); return result; }   // malformed: the assembler rejects it
    const auto sequence = word(rtp, 2);
    if (!started_) { next_ = sequence; started_ = true; }
    const int64_t extended = next_ + distance(sequence, uint16_t(next_));
    if (extended < next_) return result;   // released or given up already: a late retransmission or a duplicate
    if (extended - next_ >= VideoPacketLimit) {   // a jump (sender restarted): hand over what is held and follow it
        for (auto& [held, packet] : held_) { (void)held; result.ready.push_back(std::move(packet)); }
        held_.clear(); nacked_.clear(); blocked_.reset();
        next_ = extended;
    }
    if (!held_.emplace(extended, rtp).second) return result;
    if (nacked_.erase(extended)) ++recovered_;
    for (int64_t missing = next_; missing < extended; ++missing)
        if (!held_.contains(missing) && nacked_.insert(missing).second) result.nack.push_back(uint16_t(missing));
    release(result);
    if (blocked_ && (now - *blocked_ >= std::chrono::milliseconds(HoldMs) || held_.size() >= size_t(VideoPacketLimit))) {
        result.lost += int(held_.begin()->first - next_);
        next_ = held_.begin()->first; blocked_.reset();
        release(result);
    }
    if (!held_.empty() && !blocked_) blocked_ = now;
    nacked_.erase(nacked_.begin(), nacked_.lower_bound(next_));
    return result;
}
void VideoRtpReorder::release(Result& result) {
    for (auto it = held_.begin(); it != held_.end() && it->first == next_; it = held_.erase(it)) {
        result.ready.push_back(std::move(it->second)); ++next_;
    }
    if (held_.empty()) blocked_.reset();
}
QByteArray rtcpNack(uint32_t mediaSsrc, const std::vector<uint16_t>& missing) {
    std::vector<std::pair<uint16_t, uint16_t>> fields;   // PID + bitmask of the 16 packets after it
    for (const auto sequence : missing) {
        if (!fields.empty()) {
            const int after = distance(sequence, fields.back().first);
            if (after >= 1 && after <= 16) { fields.back().second |= uint16_t(1U << (after - 1)); continue; }
        }
        if (fields.size() >= 64) break;
        fields.emplace_back(sequence, uint16_t(0));
    }
    if (fields.empty()) return {};
    QByteArray out(12 + 4 * qsizetype(fields.size()), ' ');
    auto put16 = [&](qsizetype n, uint16_t value) { out[n] = char(value >> 8); out[n + 1] = char(value & 255); };
    out[0] = char(0x81); out[1] = char(205);   // V=2, FMT=1 (Generic NACK), PT=205 (RTPFB)
    put16(2, uint16_t(2 + fields.size()));
    // Sender and media SSRC both the stream's, as libdatachannel's own PLI does (RtcpReceivingSession::pushPLI).
    for (qsizetype n : {4, 8}) { put16(n, uint16_t(mediaSsrc >> 16)); put16(n + 2, uint16_t(mediaSsrc & 0xffff)); }
    for (size_t n = 0; n < fields.size(); ++n) { put16(12 + 4 * qsizetype(n), fields[n].first); put16(14 + 4 * qsizetype(n), fields[n].second); }
    return out;
}
}
