#include "voice_processing.h"
#include <cmath>
#include <cstring>
#include <algorithm>
#include <stdexcept>
#include <chrono>
#include <thread>
#include <QDebug>

namespace triscord {
namespace {
float bounded(float value) { return std::isfinite(value) ? std::clamp(value, -1.f, 1.f) : 0.f; }
void validate(const QAudioFormat& format) {
    if (!format.isValid() || format.sampleRate() < 8000 || format.sampleRate() > 192000 ||
        format.channelCount() < 1 || format.channelCount() > 8)
        throw std::invalid_argument("Unsupported PCM format");
}
void writeSample(char* sample, float source, QAudioFormat::SampleFormat format) {
    const float value = bounded(source);
    switch (format) {
    case QAudioFormat::Float: std::memcpy(sample, &value, 4); break;
    case QAudioFormat::Int32: { const qint32 v = static_cast<qint32>(value * 2147483647.0); std::memcpy(sample, &v, 4); break; }
    case QAudioFormat::Int16: { const qint16 v = static_cast<qint16>(value * 32767.f); std::memcpy(sample, &v, 2); break; }
    case QAudioFormat::UInt8: *sample = static_cast<char>(static_cast<unsigned char>(std::clamp(int(value * 128 + 128), 0, 255))); break;
    default: throw std::invalid_argument("Unsupported PCM sample");
    }
}
}
VoiceResampler::VoiceResampler(int inputRate, int outputRate) : inputRate_(inputRate), outputRate_(outputRate) {
    if (inputRate < 8000 || inputRate > 192000 || outputRate < 8000 || outputRate > 192000)
        throw std::invalid_argument("Unsupported sample rate");
    if (inputRate == outputRate) return;
    int error = 0;
    state_.reset(speex_resampler_init(1, inputRate, outputRate, 4, &error));
    if (!state_ || error) throw std::runtime_error("Resampler unavailable");
    speex_resampler_skip_zeros(state_.get());
}
std::vector<float> VoiceResampler::process(std::span<const float> input) {
    if (input.empty()) return {};
    if (input.size() > 192000) throw std::invalid_argument("PCM chunk too large");
    if (!state_) return {input.begin(), input.end()};
    std::vector<float> result((input.size() * outputRate_ + inputRate_ - 1) / inputRate_ + 64);
    spx_uint32_t consumed = static_cast<spx_uint32_t>(input.size());
    spx_uint32_t produced = static_cast<spx_uint32_t>(result.size());
    const int error = speex_resampler_process_float(state_.get(), 0, input.data(), &consumed, result.data(), &produced);
    if (error || consumed != input.size()) throw std::runtime_error("Resampling failed");
    result.resize(produced);
    return result;
}
std::vector<float> decodeMono(const QByteArray& pcm, const QAudioFormat& format) {
    validate(format);
    if (pcm.size() % format.bytesPerFrame()) throw std::invalid_argument("Incomplete PCM sample frame");
    std::vector<float> result(pcm.size() / format.bytesPerFrame());
    const int channels = format.channelCount(), size = format.bytesPerSample();
    for (size_t i = 0; i < result.size(); ++i) for (int c = 0; c < channels; ++c) {
        const char* sample = pcm.constData() + (i * channels + c) * size;
        float value = 0;
        switch (format.sampleFormat()) {
        case QAudioFormat::Float: std::memcpy(&value, sample, 4); break;
        case QAudioFormat::Int32: { qint32 v; std::memcpy(&v, sample, 4); value = static_cast<float>(v / 2147483648.0); break; }
        case QAudioFormat::Int16: { qint16 v; std::memcpy(&v, sample, 2); value = v / 32768.f; break; }
        case QAudioFormat::UInt8: value = (static_cast<unsigned char>(*sample) - 128) / 128.f; break;
        default: throw std::invalid_argument("Unsupported PCM sample");
        }
        result[i] += bounded(value) / channels;
    }
    return result;
}
QByteArray encodeMono(std::span<const float> mono, const QAudioFormat& format) {
    validate(format);
    QByteArray bytes(mono.size() * format.bytesPerFrame(), Qt::Uninitialized);
    const int channels = format.channelCount(), size = format.bytesPerSample();
    for (size_t i = 0; i < mono.size(); ++i) for (int c = 0; c < channels; ++c) {
        char* sample = bytes.data() + (i * channels + c) * size;
        writeSample(sample, mono[i], format.sampleFormat());
    }
    return bytes;
}
QByteArray encodeStereo(std::span<const float> left, std::span<const float> right, const QAudioFormat& format) {
    validate(format);
    if (left.size() != right.size()) throw std::invalid_argument("Unbalanced stereo PCM");
    QByteArray bytes(left.size() * format.bytesPerFrame(), Qt::Uninitialized);
    const int channels = format.channelCount(), size = format.bytesPerSample();
    for (size_t i = 0; i < left.size(); ++i) for (int c = 0; c < channels; ++c) {
        const float value = channels == 1 || c >= 2 ? (bounded(left[i]) + bounded(right[i])) * .5f : c == 0 ? left[i] : right[i];
        writeSample(bytes.data() + (i * channels + c) * size, value, format.sampleFormat());
    }
    return bytes;
}
void VoiceProcessor::reset() {
    preprocess_.reset(); echoState_.reset(); gain_.reset(); rnnoise_.reset(); voiceGate_.reset();
    probabilities_ = {}; inputs_ = {};
    // DeepFilterNet stays loaded (0.35 s to load again); silence flushes the 30 ms it still holds.
    if (deepFilter_) {
        std::array<float, DeepFilter::kBlock> silence{}, out{};
        for (int i = 0; i < DeepFilter::kDelayBlocks; ++i) deepFilter_->process(silence, out.data());
    }
}
void VoiceProcessor::setHighQuality(bool on) {
    if (highQuality_ == on) return;
    highQuality_ = on;
    deepFilter_.reset(); deepFilterLoad_.reset(); deepFilterMicros_ = 0; deepFilterBlocks_ = 0;
    reset();
    if (!on || deepFilterTooSlow_) return;
    auto load = std::make_shared<DeepFilterLoad>();
    deepFilterLoad_ = load;
    std::thread([load] {
        auto filter = DeepFilter::create();
        if (!filter) qWarning("voice: DeepFilterNet unavailable, keeping RNNoise");
        { std::lock_guard lock(load->mutex); load->filter = std::move(filter); load->finished = true; }
        load->done.notify_all();
    }).detach();
}
void VoiceProcessor::adoptDeepFilter() {
    std::unique_lock lock(deepFilterLoad_->mutex, std::try_to_lock);
    if (!lock.owns_lock() || !deepFilterLoad_->finished) return;
    deepFilter_ = std::move(deepFilterLoad_->filter);
    lock.unlock();
    deepFilterLoad_.reset();
}
bool VoiceProcessor::waitForDeepFilter(int milliseconds) {
    if (deepFilterLoad_) {
        std::unique_lock lock(deepFilterLoad_->mutex);
        deepFilterLoad_->done.wait_for(lock, std::chrono::milliseconds(milliseconds), [&] { return deepFilterLoad_->finished; });
    }
    if (deepFilterLoad_) adoptDeepFilter();
    return bool(deepFilter_);
}

void VoiceGate::process(std::span<float> samples, std::span<const float> next, float probability, float nextProbability) {
    constexpr float kAttackPerSample = -kFloorDb / (.005f * VoiceRate), kReleasePerSample = -kFloorDb / (.2f * VoiceRate);
    constexpr int kHoldSamples = VoiceRate * 15 / 100, kSustainBlocks = 3;
    if (next.size() != samples.size() || samples.empty() || samples.size() % 4) throw std::invalid_argument("Gate blocks must match");
    // Level of this block and the next in 8 slices: a click fills two or three, so the 5th quietest is the voice.
    const size_t slice = samples.size() / 4;
    std::array<float, 8> slices{};
    for (size_t b = 0; b < slices.size(); ++b) {
        const auto part = b < 4 ? std::span<const float>(samples).subspan(b * slice, slice) : next.subspan((b - 4) * slice, slice);
        double energy = 0;
        for (float v : part) energy += double(v) * v;
        slices[b] = 10.f * std::log10(float(energy / slice) + 1e-12f);
    }
    std::nth_element(slices.begin(), slices.begin() + 4, slices.end());
    const float levelDb = slices[4];
    const bool voiced = std::min(probability, nextProbability) >= kThreshold;
    const bool speech = voiced && levelDb >= talkerDb_ - kBackgroundDb;
    // The talker's level rises quickly with their speech and drifts down 0.5 dB/s while anyone talks.
    if (voiced) talkerDb_ = speech && levelDb > talkerDb_ ? talkerDb_ + .3f * (levelDb - talkerDb_) : talkerDb_ - .005f;
    run_ = speech ? run_ + 1 : 0;
    // A lone block mistaken for speech (a click, or a click over a distant voice) opens the gate only for itself and
    // closes in 10 ms: hold and the slow release are earned by 30 ms of speech.
    if (run_ >= kSustainBlocks) { hold_ = kHoldSamples; sustained_ = true; }
    for (float& sample : samples) {
        const bool open = speech || hold_ > 0;
        if (!speech && hold_ > 0) --hold_;
        gainDb_ = open ? std::min(0.f, gainDb_ + kAttackPerSample)
                       : std::max(kFloorDb, gainDb_ - (sustained_ ? kReleasePerSample : kAttackPerSample / 2));
        if (gainDb_ <= kFloorDb) sustained_ = false;
        if (gainDb_ < 0) sample *= std::pow(10.f, gainDb_ / 20.f);
    }
}

void VoiceGainControl::process(VoiceFrame& frame) {
    constexpr float kTargetDb = -20.f, kMaxGainDb = 20.f, kMinGainDb = -10.f, kUpPerFrame = .2f, kDownPerFrame = 1.f;
    double energy = 0;
    for (float s : frame) energy += double(s) * s;
    const float levelDb = 10.f * std::log10(float(energy / VoiceSamples) + 1e-12f);
    if (!started_) { floorDb_ = levelDb; started_ = true; }
    // Noise floor: follows quiet frames down at once, creeps up slowly (≈2.5 dB/s) so speech never becomes "floor".
    floorDb_ = levelDb < floorDb_ ? levelDb : floorDb_ + .05f;
    const bool speech = levelDb > -60.f && levelDb > floorDb_ + 9.f;
    const float previous = gainDb_;
    if (speech) {
        const float wanted = std::clamp(kTargetDb - levelDb, kMinGainDb, kMaxGainDb);
        gainDb_ += std::clamp(wanted - gainDb_, -kDownPerFrame, kUpPerFrame);
    }
    const float from = std::pow(10.f, previous / 20.f), to = std::pow(10.f, gainDb_ / 20.f);
    for (int i = 0; i < VoiceSamples; ++i) {
        const float g = from + (to - from) * (float(i) / VoiceSamples);
        float y = frame[i] * g;
        // Soft limiter above 0.7: smooth knee towards ±1, never reaching it.
        const float a = std::abs(y);
        if (a > .7f) y = std::copysign(.7f + .3f * std::tanh((a - .7f) / .3f), y);
        frame[i] = y;
    }
}
void VoiceProcessor::setOptions(bool noise, bool echo, bool agc, bool gate) {
    if (noise_ == noise && echo_ == echo && agc_ == agc && gate_ == gate) return;
    noise_ = noise; echo_ = echo; agc_ = agc; gate_ = gate; reset();
}
void VoiceProcessor::setSuppressionStrength(float strength) {
    suppressionStrength_ = std::isfinite(strength) ? std::clamp(strength, 0.f, 1.f) : 1.f;
}
VoiceFrame VoiceProcessor::process(const VoiceFrame& microphone, const VoiceFrame& played) {
    if (!noise_ && !echo_ && !agc_) return microphone;
    VoiceFrame result = echo_ ? cancelEcho(microphone, played) : microphone;
    if (noise_) {
        // RNNoise works on 480 samples at 48 kHz in 16-bit scale: two halves of each 20 ms frame (18/10: a good
        // noise suppression was asked for; this is the neural model OBS and Jitsi ship, free, in place of speex).
        if (!rnnoise_) { rnnoise_.reset(rnnoise_create(nullptr)); if (!rnnoise_) throw std::runtime_error("Noise suppression unavailable"); }
        constexpr int half = VoiceSamples / 2;
        static_assert(half == 480, "RNNoise needs 10 ms frames at 48 kHz");
        if (deepFilterLoad_) adoptDeepFilter();
        std::array<float, half> buffer{}, input{};
        for (int part = 0; part < 2; ++part) {
            for (int i = 0; i < half; ++i) { input[i] = bounded(result[part * half + i]); buffer[i] = input[i] * 32768.f; }
            const float probability = rnnoise_process_frame(rnnoise_.get(), buffer.data(), buffer.data());
            std::rotate(probabilities_.begin(), probabilities_.begin() + 1, probabilities_.end()); probabilities_.back() = probability;
            std::rotate(inputs_.begin(), inputs_.begin() + 1, inputs_.end()); inputs_.back() = input;
            const auto output = std::span(result).subspan(part * half, half);
            if (deepFilter_) {
                const auto start = std::chrono::steady_clock::now();
                deepFilter_->process(input, output.data());
                const double micros = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count();
                deepFilterMicros_ = deepFilterBlocks_++ ? .98 * deepFilterMicros_ + .02 * micros : micros;
                if (deepFilterBlocks_ > 200 && deepFilterMicros_ > 5000) {
                    qWarning("voice: DeepFilterNet takes %.1f ms per 10 ms here, back to RNNoise", deepFilterMicros_ / 1000);
                    deepFilterTooSlow_ = true; deepFilter_.reset();
                    for (int i = 0; i < half; ++i) output[i] = buffer[i] / 32768.f;
                }
            } else for (int i = 0; i < half; ++i) output[i] = buffer[i] / 32768.f;
            for (float& v : output) v = bounded(v);
            // The output is an earlier input block (RNNoise: 10 ms, DeepFilterNet: 30 ms): gate it with its own speech
            // probability, and the next block's as lookahead.
            const int delay = deepFilter_ ? DeepFilter::kDelayBlocks : 1;
            if (gate_) voiceGate_.process(output, inputs_[4 - delay], probabilities_[3 - delay], probabilities_[4 - delay]);
            // Mix against the same input block the denoiser is returning, never against the current microphone:
            // otherwise intermediate strengths would comb-filter speech (10/30 ms phase mismatch).
            if (suppressionStrength_ < 1.f) {
                const auto& dry = inputs_[3 - delay];
                for (int i = 0; i < half; ++i)
                    output[i] = dry[i] + suppressionStrength_ * (output[i] - dry[i]);
            }
        }
    }
    if (agc_) gain_.process(result);
    return result;
}
VoiceFrame VoiceProcessor::cancelEcho(const VoiceFrame& microphone, const VoiceFrame& played) {
    if (!preprocess_) {
        preprocess_.reset(speex_preprocess_state_init(VoiceSamples, VoiceRate));
        if (!preprocess_) throw std::runtime_error("Audio processor unavailable");
        int disabled = 0;
        speex_preprocess_ctl(preprocess_.get(), SPEEX_PREPROCESS_SET_DENOISE, &disabled);
        {
            echoState_.reset(speex_echo_state_init(VoiceSamples, VoiceRate / 10));
            if (!echoState_) { reset(); throw std::runtime_error("Echo processor unavailable"); }
            int rate = VoiceRate;
            speex_echo_ctl(echoState_.get(), SPEEX_ECHO_SET_SAMPLING_RATE, &rate);
            speex_preprocess_ctl(preprocess_.get(), SPEEX_PREPROCESS_SET_ECHO_STATE, echoState_.get());
        }
    }
    std::array<spx_int16_t, VoiceSamples> mic{}, reference{}, clean{};
    for (int i = 0; i < VoiceSamples; ++i) {
        mic[i] = static_cast<spx_int16_t>(bounded(microphone[i]) * 32767.f);
        reference[i] = static_cast<spx_int16_t>(bounded(played[i]) * 32767.f);
    }
    speex_echo_cancellation(echoState_.get(), mic.data(), reference.data(), clean.data());
    speex_preprocess_run(preprocess_.get(), clean.data());
    VoiceFrame result{};
    for (int i = 0; i < VoiceSamples; ++i) result[i] = clean[i] / 32768.f;
    return result;
}
}
