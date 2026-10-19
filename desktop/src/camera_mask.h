#pragma once
#include <span>
#include <vector>
namespace triscord {
// One prior mask, used only by an active background-effect pipeline.
class CameraMaskSmoother final {
public:
    std::span<const float> update(std::span<const float> mask, int width, int height, float previousRatio = 0.95f);
    void reset();
private:
    std::vector<float> previous_;
    int width_ = 0, height_ = 0;
};
}
