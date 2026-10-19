// Temporal mask behavior follows MediaPipe's SegmentationSmoothingCalculator.
// Algorithm reference: google-ai-edge/mediapipe, Apache-2.0.
#include "camera_mask.h"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace triscord {
std::span<const float> CameraMaskSmoother::update(std::span<const float> mask, int width, int height, float previousRatio) {
    if (width < 1 || width > 256 || height < 1 || height > 256 ||
        mask.size() != static_cast<size_t>(width) * height ||
        !std::isfinite(previousRatio) || previousRatio < 0 || previousRatio > 1)
        throw std::invalid_argument("Invalid camera mask extent or smoothing ratio");
    for (const float value : mask) if (!std::isfinite(value) || value < 0 || value > 1)
        throw std::invalid_argument("Invalid camera mask probability");
    if (width_ != width || height_ != height || previous_.empty()) {
        previous_.assign(mask.begin(), mask.end()); width_ = width; height_ = height;
    } else {
        for (size_t i = 0; i < mask.size(); ++i) {
            const float current = mask[i];
            const float delta = current - 0.5f;
            const float square = delta * delta;
            const float certainty = square * (5.68842f + square * (-0.748699f + square *
                (-57.8051f + square * (291.309f - square * 624.717f))));
            const float blend = (1.0f - std::clamp(certainty, 0.0f, 1.0f)) * previousRatio;
            previous_[i] = current + (previous_[i] - current) * blend;
        }
    }
    return previous_;
}
void CameraMaskSmoother::reset() {
    std::vector<float>().swap(previous_); width_ = height_ = 0;
}
}
