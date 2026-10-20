#pragma once
#include "video_codec.h"
#include <algorithm>
#include <deque>
#include <stdexcept>
namespace triscord {
// A static WGC source may emit no new frames. A viewer's PLI must still reach the encoder, and a refused
// submission must retain that request. All times use the encoder's single monotonic clock (100 ns).
class ScreenFrameSchedule final {
public:
    void requestKeyframe() { requested_ = true; }
    bool timeDue(qint64 now, int fps) const { return last_ < 0 || now - last_ >= 10000000 / fps; }
    bool shouldSubmit(qint64 now, int fps, bool fresh, bool ready) const {
        return ready && timeDue(now, fps) && (fresh || requested_ || last_ < 0 || now - last_ >= 10000000);
    }
    void submitted(qint64 now) { last_ = now; requested_ = false; }
private:
    qint64 last_ = -1;
    bool requested_ = false;
};
// Screen bitrate under congestion (ScreenCall::adaptBitrate), times in ms. A quarter off at most every 2 s when the
// sender's own buffer overflows, or on the third viewer keyframe request within 5 s: with retransmission a single
// request is a new viewer or one unrepairable loss, not congestion. Before 19/10 every request cut a quarter and the
// stream climbed back 10% per 10 s, so one bad moment left it blurry for minutes. Now it probes back up by a fifth
// every 4 s after 8 calm seconds, and never drops below an eighth of the preset (128 kbps at least).
class ScreenBitrateControl final {
public:
    void reset() { target_ = 0; lastChange_ = lastCongestion_ = -1; requests_.clear(); }
    int target(int preset) const { return target_ ? target_ : preset; }
    static int floor(int preset) { return std::min(preset, std::max(128000, preset / 8)); }
    // Each returns the new target, or 0 when it stays.
    int congested(qint64 now, int preset, int ceiling) {
        lastCongestion_ = now;
        if (lastChange_ >= 0 && now - lastChange_ < 2000) return 0;
        return apply(now, preset, ceiling, target(preset) * 3 / 4);
    }
    int keyframeRequested(qint64 now, int preset, int ceiling) {
        while (!requests_.empty() && now - requests_.front() >= 5000) requests_.pop_front();
        requests_.push_back(now);
        if (requests_.size() < 3) return 0;
        requests_.clear();
        return congested(now, preset, ceiling);
    }
    int calm(qint64 now, int preset, int ceiling) {
        const int current = target(preset);
        const bool quiet = (lastCongestion_ < 0 || now - lastCongestion_ >= 8000) && (lastChange_ < 0 || now - lastChange_ >= 4000);
        return apply(now, preset, ceiling, quiet && current < preset ? current + std::max(64000, current / 5) : current);
    }
private:
    int apply(qint64 now, int preset, int ceiling, int wanted) {
        const int low = floor(preset);
        wanted = std::clamp(wanted, low, std::max(low, std::min(preset, ceiling)));
        if (wanted == target(preset) && target_) return 0;
        if (wanted == preset && !target_) return 0;
        target_ = wanted; lastChange_ = now;
        return wanted;
    }
    int target_ = 0;
    qint64 lastChange_ = -1, lastCongestion_ = -1;
    std::deque<qint64> requests_;
};
// Each viewer gets its own copy of the shared screen (peer to peer, no media server), so the sender uploads the
// bitrate once per viewer. Up to this total the preset is kept; beyond it every copy gets an equal share, never less
// than the floor. Before 0.9.36 the total was the preset alone (four viewers of 1080p60 got 2 Mbps each); 0.9.36
// removed the limit and three viewers asked for 24 Mbps of upload. Congestion feedback still lowers it further.
constexpr int kScreenUploadBudget = 16000000;
inline int screenBitrateCeiling(int preset, int viewers) {
    return std::max(ScreenBitrateControl::floor(preset), std::min(preset, kScreenUploadBudget / std::max(1, viewers)));
}
inline VideoConfig screenPreset(int height, int fps) {
    if ((height != 480 && height != 720 && height != 1080) || (fps != 15 && fps != 30 && fps != 60))
        throw std::invalid_argument("Unsupported screen preset");
    const int width = height == 480 ? 854 : height == 720 ? 1280 : 1920;
    const int bitrate = height == 480 ? (fps == 15 ? 800000 : fps == 30 ? 1200000 : 2000000)
        : height == 720 ? (fps == 15 ? 1500000 : fps == 30 ? 2500000 : 4000000)
        : (fps == 15 ? 3000000 : fps == 30 ? 5000000 : 8000000);
    return {{width, height}, fps, bitrate};
}
// The encoder enforces 10000000/fps ticks between submissions. Rounding the timer down (33 ms at 30 fps,
// 16 ms at 60 fps) makes every other wake-up too early and can halve the actual frame rate.
inline int screenCaptureInterval(const VideoConfig& config) {
    return std::max(1, (1000 + config.fps - 1) / config.fps);
}
inline int screenRenderInterval(const VideoConfig& config, bool focused) {
    return focused ? std::max(1, 1000 / config.fps) : 200;
}
}
