#pragma once
#include "voice_codec.h"
#include <algorithm>
#include <bit>
#include <map>
#include <optional>

namespace triscord {
// Short RTP-time buffer. Decode only in playout order; bound queued packets
// to 200 ms, retaining recent packets across bursts. Three startup packets give
// reorder/FEC headroom; prolonged silence still stops concealment. A queue that
// stays above 80 ms for a second (a burst, or the sender's clock running ahead)
// drains one packet at a time, so the delay never stays at 200 ms.
// An empty queue means the next packet is late, not lost (a lost one leaves later packets behind): concealment then
// holds the timeline so the packet still plays when it lands instead of being dropped as stale (19/10, robotic
// voices over a TURN relay), and the drain target grows to cover such spikes, shrinking again after 15 calm seconds.
class VoiceJitter {
public:
    void push(uint32_t timestamp, const QByteArray& packet) {
        if (packet.isEmpty() || packet.size() > 1275) return;
        if (packets_.contains(timestamp)) return;
        if (!initialized_) { expected_ = timestamp; initialized_ = true; }
        const auto offset = std::bit_cast<int32_t>(timestamp - expected_);
        if (offset < 0) {
            if (primed_ || offset < -VoiceSamples * 10) return;
            expected_ = timestamp;
        }
        if (offset >= VoiceSamples * 10) {
            expected_ = timestamp - VoiceSamples * 9;
            for (auto it = packets_.begin(); it != packets_.end(); ) {
                if (std::bit_cast<int32_t>(it->first - expected_) < 0) it = packets_.erase(it);
                else ++it;
            }
            // A discontinuity larger than the queue: re-anchor without spending
            // nine ticks concealing samples that cannot arrive anymore.
            if (packets_.empty()) { expected_ = timestamp; primed_ = false; }
            missing_ = 0;
        }
        packets_.insert_or_assign(timestamp, packet);
        while (packets_.size() > 10) {
            // Also bound an out-of-order startup burst, including RTP wraparound.
            auto oldest = packets_.begin();
            for (auto it = packets_.begin(); it != packets_.end(); ++it)
                if (std::bit_cast<int32_t>(it->first - expected_) < std::bit_cast<int32_t>(oldest->first - expected_)) oldest = it;
            expected_ = oldest->first + VoiceSamples;
            packets_.erase(oldest);
        }
    }
    std::optional<VoiceFrame> pop() {
        if (!primed_) {
            if (packets_.size() < 3) return {};
            primed_ = true;
        }
        if (++calm_ >= 750 && target_ > 3) { --target_; calm_ = 0; }
        excess_ = packets_.size() > target_ + 1 ? excess_ + 1 : 0;
        if (excess_ >= 50) {
            excess_ = 0;
            // Decoded and dropped (not skipped) so the decoder's state stays continuous.
            if (const auto late = packets_.find(expected_); late != packets_.end()) { decoder_.decode(late->second); packets_.erase(late); }
            expected_ += VoiceSamples;
        }
        QByteArray packet;
        auto it = packets_.find(expected_);
        if (it != packets_.end()) {
            packet = std::move(it->second); packets_.erase(it); missing_ = 0;
            if (stalled_) { target_ = std::min<size_t>(8, std::max<size_t>(target_, 3 + stalled_)); stalled_ = 0; calm_ = 0; }
        } else {
            const auto next = packets_.find(expected_ + VoiceSamples);
            if (next != packets_.end()) {
                expected_ += VoiceSamples; missing_ = 0;
                // Decode the missing frame using the following packet's FEC,
                // retaining that packet for its own normal decode next tick.
                return decoder_.decode(next->second, true);
            }
            if (++missing_ >= 5 && packets_.empty()) {
                primed_ = false; initialized_ = false; excess_ = 0; stalled_ = 0; return {};
            }
            if (packets_.empty()) { ++stalled_; return decoder_.decode({}); }   // late: conceal, keep waiting for it
        }
        expected_ += VoiceSamples;
        return decoder_.decode(packet); // Empty packet invokes Opus loss concealment.
    }
    size_t queued() const { return packets_.size(); }
    size_t target() const { return target_; }
private:
    VoiceDecoder decoder_;
    std::map<uint32_t, QByteArray> packets_;
    uint32_t expected_ = 0;
    bool initialized_ = false;
    bool primed_ = false;
    int missing_ = 0, excess_ = 0, calm_ = 0;
    size_t stalled_ = 0, target_ = 3;   // packets: ticks spent waiting for a late one; the drain's resting depth
};
}
