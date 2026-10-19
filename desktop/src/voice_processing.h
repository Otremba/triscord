#pragma once
#include <rnnoise.h>
#include "voice_codec.h"
#include "voice_deepfilter.h"
#include <QAudioFormat>
#include <condition_variable>
#include <mutex>
#include <span>
#include <vector>
#include <speex/speex_resampler.h>
#include <speex/speex_preprocess.h>
#include <speex/speex_echo.h>

namespace triscord {
class VoiceResampler final {
public:
    VoiceResampler(int inputRate, int outputRate);
    std::vector<float> process(std::span<const float> input);
private:
    int inputRate_, outputRate_;
    std::unique_ptr<SpeexResamplerState, decltype(&speex_resampler_destroy)> state_{nullptr, speex_resampler_destroy};
};
std::vector<float> decodeMono(const QByteArray& pcm, const QAudioFormat& format);
QByteArray encodeMono(std::span<const float> mono, const QAudioFormat& format);
QByteArray encodeStereo(std::span<const float> left, std::span<const float> right, const QAudioFormat& format);

// Automatic gain control (Discord's "Controle de ganho automático", on by default). It measures the level only on
// speech frames (well above a tracked noise floor), so silence and background noise are never pumped up; the gain
// rises at most 10 dB/s up to +20 dB, falls up to 50 dB/s, is interpolated across each frame and a soft limiter keeps
// peaks below full scale. Speex's own AGC was tried first: gated by its speech estimator, it never engaged (18/10).
class VoiceGainControl final {
public:
    void reset() { gainDb_ = 0; floorDb_ = 0; started_ = false; }
    void process(VoiceFrame& frame);
    float gainDb() const { return gainDb_; }
private:
    float gainDb_ = 0, floorDb_ = 0;
    bool started_ = false;
};

// Noise gate driven by RNNoise's speech probability (on with noise suppression; 18/10: "stop hearing my friend's
// keyboard, the cars and the kids in the background"). Typing, clicks and traffic between sentences are not speech,
// so they fall to -40 dB, while the talker passes at exactly unity gain. A 10 ms block opens the gate when it and the
// next one are both speech (RNNoise's output lags its input by one block, so the next probability is free lookahead)
// and its level is within 20 dB of the talker's: voices from another room or the street are speech too, but much
// quieter than someone at the microphone. The level ignores clicks (the 5th of 8 sub-block energies, 2.5 ms each).
// It opens in 5 ms, holds 150 ms after 30 ms of speech, then closes over 200 ms (10 ms after a lone block).
class VoiceGate final {
public:
    void reset() { gainDb_ = kFloorDb; talkerDb_ = -100; hold_ = 0; run_ = 0; sustained_ = false; }
    // samples: RNNoise's output, i.e. the previous input block; next: the input block RNNoise just analysed.
    void process(std::span<float> samples, std::span<const float> next, float probability, float nextProbability);
    void shiftLevel(float db) { talkerDb_ += db; }   // the input volume changed by db
    float gainDb() const { return gainDb_; }
    float talkerDb() const { return talkerDb_; }
    static constexpr float kFloorDb = -40.f, kThreshold = .5f, kBackgroundDb = 20.f;
private:
    float gainDb_ = kFloorDb, talkerDb_ = -100;
    int hold_ = 0, run_ = 0;
    bool sustained_ = false;
};

class VoiceProcessor final {
public:
    void setOptions(bool noise, bool echo, bool agc = true, bool gate = true);
    // "Supressão de ruído: Alta qualidade": DeepFilterNet 3 cleans the voice instead of RNNoise, which keeps running
    // for the gate's speech probability. It loads on a worker thread (~0.35 s); until then, or when it is missing or
    // too slow for this computer (over 5 ms per 10 ms on average), RNNoise's output is used.
    void setHighQuality(bool on);
    void setSuppressionStrength(float strength); // 0..1, applied before AGC, in both suppressors
    bool waitForDeepFilter(int milliseconds);   // true once DeepFilterNet is in use (tests)
    bool deepFilterActive() const { return bool(deepFilter_); }
    void reset();
    void inputGainChanged(float db) { voiceGate_.shiftLevel(db); }
    VoiceFrame process(const VoiceFrame& microphone, const VoiceFrame& played);
private:
    struct DeepFilterLoad { std::mutex mutex; std::condition_variable done; bool finished = false; std::unique_ptr<DeepFilter> filter; };
    VoiceFrame cancelEcho(const VoiceFrame& microphone, const VoiceFrame& played);
    void adoptDeepFilter();
    bool noise_ = true, echo_ = false, agc_ = true, gate_ = true, highQuality_ = false, deepFilterTooSlow_ = false;
    // Speech probabilities and inputs of the last four 10 ms blocks (newest last): the gate needs those of the block
    // the denoiser outputs now (1 block ago for RNNoise, 3 for DeepFilterNet) and of the block after it.
    std::array<float, 4> probabilities_{};
    std::array<std::array<float, VoiceSamples / 2>, 4> inputs_{};
    std::shared_ptr<DeepFilterLoad> deepFilterLoad_;
    std::unique_ptr<DeepFilter> deepFilter_;
    double deepFilterMicros_ = 0;
    float suppressionStrength_ = 1.f;
    int deepFilterBlocks_ = 0;
    VoiceGate voiceGate_;
    VoiceGainControl gain_;
    // Noise suppression: RNNoise (neural, 10 ms frames); speex only cancels echo now.
    std::unique_ptr<DenoiseState, void (*)(DenoiseState*)> rnnoise_{nullptr, rnnoise_destroy};
    std::unique_ptr<SpeexPreprocessState, decltype(&speex_preprocess_state_destroy)> preprocess_{nullptr, speex_preprocess_state_destroy};
    std::unique_ptr<SpeexEchoState, decltype(&speex_echo_state_destroy)> echoState_{nullptr, speex_echo_state_destroy};
};
}
