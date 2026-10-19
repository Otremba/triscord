#pragma once
#include "voice_codec.h"

namespace triscord {
// Audio already exists in the media pipeline. Only state transitions reach UI.
class VoiceActivity final {
public:
    bool update(const VoiceFrame* frame) {
        double energy = 0;
        if (frame) for (int i = 0; i < VoiceSamples; i += 4) energy += double((*frame)[i]) * (*frame)[i];
        energy /= VoiceSamples / 4;
        // Starts at about -42 dBFS and holds down to -46 dBFS (was -36/-42: quiet voices often did not light up the
        // green ring, 18/10). Senders' noise suppression keeps silence far below this.
        const double threshold = active_ ? 0.005 * 0.005 : 0.008 * 0.008;
        if (energy >= threshold) hold_ = 15;
        else if (hold_) --hold_;
        const bool next = hold_ > 0; const bool changed = next != active_; active_ = next;
        return changed;
    }
    bool reset() { const bool changed = active_; active_ = false; hold_ = 0; return changed; }
    bool active() const { return active_; }
private:
    int hold_ = 0;
    bool active_ = false;
};
}
