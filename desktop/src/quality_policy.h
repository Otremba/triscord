#pragma once
#include <algorithm>
#include <cstdint>

namespace triscord {
struct VideoBudget {
    std::int64_t totalVideoBps = 0;
    std::int64_t focusedBps = 0;
    std::int64_t secondaryBps = 0;
    int focusedReceivers = 0;
    int secondaryReceivers = 0;
};

// One sender's budget, across every P2P receiver. Never multiply a per-peer
// target by the room size without reserving microphone and control traffic.
inline VideoBudget allocateVideo(std::int64_t uploadBps, int focused, int secondary,
                                 int voicePeers, bool textMode = false) {
    focused = std::clamp(focused, 0, 9);
    secondary = std::clamp(secondary, 0, 9 - focused);
    voicePeers = std::clamp(voicePeers, 0, 9);
    const auto safeUpload = std::max<std::int64_t>(0, uploadBps) / 10 * 7;
    const auto reserve = 128000 + voicePeers * 64000;
    const auto available = std::max<std::int64_t>(0, safeUpload - reserve);
    VideoBudget result{available, 0, 0, focused, secondary};
    if (!focused && !secondary) { result.totalVideoBps = 0; return result; }
    const std::int64_t secondaryShare = focused ? available / 5 : available;
    result.secondaryBps = secondary ? std::min<std::int64_t>(500000, secondaryShare / secondary) : 0;
    const auto remaining = available - result.secondaryBps * secondary;
    result.focusedBps = focused ? std::min<std::int64_t>(textMode ? 3000000 : 4000000, remaining / focused) : 0;
    result.totalVideoBps = result.focusedBps * focused + result.secondaryBps * secondary;
    return result;
}
}
