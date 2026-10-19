#pragma once
#include "voice_codec.h"
#include <algorithm>
#include <cmath>
namespace triscord {
inline void mixVoiceFrame(VoiceFrame& output, const VoiceFrame& input, float volume, bool muted) {
    if (muted || !std::isfinite(volume)) return;
    const float gain = std::clamp(volume, 0.f, 2.f);
    for (int n = 0; n < VoiceSamples; ++n) output[n] += input[n] * gain;
}
inline void mixStereoVoiceFrame(VoiceFrame& left, VoiceFrame& right, const VoiceFrame& input,
                                float volume, float pan, bool muted) {
    if (!std::isfinite(volume)) return;
    volume = std::clamp(volume, 0.f, 2.f);
    if (!std::isfinite(pan)) pan = 0.f;
    pan = std::clamp(pan, -1.f, 1.f);
    mixVoiceFrame(left, input, volume * (pan > 0.f ? 1.f - pan : 1.f), muted);
    mixVoiceFrame(right, input, volume * (pan < 0.f ? 1.f + pan : 1.f), muted);
}
// Frames to write to the speaker on one playback tick. One per tick only works if ticks are never late: a late one
// (busy CPU, coarse Windows timer) left the device buffer lower for good and it ran dry, cutting voices into robotic
// fragments (19/10). Now a tick also tops the buffer back up to two frames (40 ms), at most four frames per tick.
inline int playbackFramesNeeded(qint64 bufferBytes, qint64 freeBytes, qint64 frameBytes) {
    if (frameBytes <= 0) return 0;
    qint64 buffered = std::max<qint64>(0, bufferBytes - freeBytes);
    int frames = 0;
    while (frames < 4 && freeBytes >= frameBytes && (frames == 0 || buffered < 2 * frameBytes)) {
        ++frames; freeBytes -= frameBytes; buffered += frameBytes;
    }
    return frames;
}
inline float sliderToGain(int sliderVal) {
    if (sliderVal <= 0) return 0.f;
    const float x = sliderVal / 100.f;
    if (x < 1.f) return std::pow(x, 2.8f);
    return std::pow(10.f, (x - 1.f) * 6.f / 20.f);
}
inline void applyMasterOutputGain(VoiceFrame& left, VoiceFrame* right, float gain) {
    for (float& s : left) s = std::clamp(s * gain, -1.f, 1.f);
    if (right) {
        for (float& s : *right) s = std::clamp(s * gain, -1.f, 1.f);
    }
}
}
