#pragma once
#include <array>
#include <memory>

namespace triscord {
// DeepFilterNet 3 ("Supressão de ruído: Alta qualidade", 18/10): a free (MIT/Apache) neural suppressor that, unlike
// RNNoise, also removes typing and traffic *while* someone talks (measured on real speech: +13.7 dB SI-SDR with
// typing over speech vs +4.3 for RNNoise, 0.6 ms per 10 ms on a Ryzen 5 5600X, 30 ms latency vs 10). libDF is Rust;
// scripts/build-deepfilter.ps1 builds its C API with the project's MinGW and stages deepfilter\df.dll plus the model
// next to the executable. It is loaded at run time, so without it the client simply keeps RNNoise.
class DeepFilter final {
public:
    static constexpr int kBlock = 480, kDelayBlocks = 3;   // 10 ms in; out is the input of 3 blocks before
    // Loads df.dll and the model (about 0.35 s: call it off the audio thread). nullptr when they are missing.
    static std::unique_ptr<DeepFilter> create();
    static bool available();   // both files are next to the executable (no loading)
    ~DeepFilter();
    DeepFilter(const DeepFilter&) = delete;
    DeepFilter& operator=(const DeepFilter&) = delete;
    void process(const std::array<float, kBlock>& input, float* output);
private:
    DeepFilter() = default;
    void* state_ = nullptr;
};
}
