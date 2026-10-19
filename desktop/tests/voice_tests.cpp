#include "voice_codec.h"
#include "voice_peer.h"
#include "voice_jitter.h"
#include "voice_processing.h"
#include "voice_activity.h"
#include "voice_mix.h"
#include "voice_devices.h"
#include <QtTest>
#include <QSignalSpy>
#include <cmath>
#include <cstring>
#include <QThread>
#include <QScopeGuard>
#include <atomic>
#include <random>
#include <chrono>

using namespace triscord;
class VoiceTests : public QObject {
    Q_OBJECT
private:
    static VoiceFrame tone(int frame) {
        VoiceFrame pcm{};
        for (int i = 0; i < VoiceSamples; ++i)
            pcm[i] = 0.2f * std::sin(2.0 * 3.141592653589793 * 440.0 * (frame * VoiceSamples + i) / VoiceRate);
        return pcm;
    }
    // Voice-gate scenes: a talker (glottal pulses through vowel formants, about -37 dBFS) talks 1 s and pauses 1.5 s.
    // The pauses carry keyboard clicks (a decaying click with a resonant "thock" every 80-250 ms) and/or a child-like
    // voice (280 Hz) backgroundDb below the talker. Both processors run RNNoise; only one gates.
    static constexpr int kGateTalk = 50, kGateCycle = 125, kGateFrames = 25 + kGateCycle * 5, kGateHalf = VoiceSamples / 2;
    static bool gateTalking(int frame) { return frame >= 25 && frame % kGateCycle < kGateTalk; }
    struct Resonator {
        float a1, a2, b0, y1 = 0, y2 = 0;
        Resonator(double f, double bandwidth) {
            const double r = std::exp(-3.141592653589793 * bandwidth / VoiceRate);
            a1 = float(2 * r * std::cos(2 * 3.141592653589793 * f / VoiceRate)); a2 = float(-r * r); b0 = float(1 - r);
        }
        float step(float x) { const float y = b0 * x + a1 * y1 + a2 * y2; y2 = y1; y1 = y; return y; }
    };
    static std::vector<float> formantVoice(size_t samples, double pitch, double syllables) {
        std::array<std::array<Resonator, 3>, 4> vowels{{{{{730, 90}, {1090, 110}, {2440, 170}}}, {{{530, 90}, {1840, 110}, {2480, 170}}},
                                                       {{{270, 90}, {2290, 110}, {3010, 170}}}, {{{570, 90}, {840, 110}, {2410, 170}}}}};
        std::vector<float> voice(samples);
        double phase = 0;
        for (size_t n = 0; n < samples; ++n) {
            const double t = double(n) / VoiceRate;
            phase += pitch * (1 + .16 * std::sin(2 * 3.141592653589793 * .7 * t)) / VoiceRate;
            float pulse = 0; if (phase >= 1) { phase -= 1; pulse = 1; }
            auto& formants = vowels[int(t * syllables) % 4];
            voice[n] = (formants[0].step(pulse) + .6f * formants[1].step(pulse) + .3f * formants[2].step(pulse))
                * float(std::pow(std::sin(3.141592653589793 * std::fmod(t * syllables, 1.0)), .6));
        }
        return voice;
    }
    struct GateScene { std::vector<float> input, withGate, withoutGate; size_t delay = kGateHalf; };
    // highQuality: both processors use DeepFilterNet (30 ms delay) instead of RNNoise's output (10 ms).
    static GateScene gateScene(bool clicks, double backgroundDb, bool highQuality = false) {
        const size_t samples = size_t(kGateFrames) * VoiceSamples;
        const auto talker = formantVoice(samples, 125, 4), child = formantVoice(samples, 280, 5);
        const auto background = [](int frame) { return frame >= 25 && frame % kGateCycle >= kGateTalk + 10; };
        double talkerPower = 0, childPower = 0; long talkerSamples = 0, childSamples = 0;   // mean power while each talks
        for (size_t n = 0; n < samples; ++n) {
            const int frame = int(n / VoiceSamples);
            if (gateTalking(frame)) { talkerPower += .25 * talker[n] * talker[n]; ++talkerSamples; }
            if (background(frame)) { childPower += double(child[n]) * child[n]; ++childSamples; }
        }
        talkerPower /= talkerSamples; childPower /= childSamples;
        const float childScale = std::isfinite(backgroundDb) ? float(std::sqrt(talkerPower / childPower * std::pow(10, backgroundDb / 10))) : 0.f;
        GateScene scene{std::vector<float>(samples), std::vector<float>(samples), std::vector<float>(samples)};
        std::mt19937 random(5);
        std::uniform_real_distribution<float> uniform(-1, 1), gap(.08f, .25f);
        for (size_t n = 0; n < samples; ++n) {
            const int frame = int(n / VoiceSamples);
            scene.input[n] = .0005f * uniform(random) + (gateTalking(frame) ? .5f * talker[n] : 0.f) + (background(frame) ? childScale * child[n] : 0.f);
        }
        for (size_t click = size_t(25 + kGateTalk) * VoiceSamples; clicks && click + kGateHalf < samples; click += size_t(gap(random) * VoiceRate)) {
            const int frame = int(click / VoiceSamples);
            if (gateTalking(frame) || gateTalking(frame + 2)) { click = size_t(frame + 1) * VoiceSamples; continue; }
            Resonator thock(2500 + 1500 * (uniform(random) + 1), 400);
            for (int i = 0; i < kGateHalf; ++i) { const float x = uniform(random) * std::exp(-i / (.003f * VoiceRate)); scene.input[click + i] += .1f * (.5f * x + 4 * thock.step(x)); }
        }
        VoiceProcessor gated, plain;
        gated.setOptions(true, false, false, true); plain.setOptions(true, false, false, false);
        if (highQuality) {
            gated.setHighQuality(true); plain.setHighQuality(true);
            if (!gated.waitForDeepFilter(10000) || !plain.waitForDeepFilter(10000)) return scene;
            scene.delay = size_t(DeepFilter::kDelayBlocks) * kGateHalf;
        }
        for (int f = 0; f < kGateFrames; ++f) {
            VoiceFrame mic{}; std::copy_n(scene.input.begin() + f * VoiceSamples, VoiceSamples, mic.begin());
            const auto a = gated.process(mic, {}), b = plain.process(mic, {});
            std::copy(a.begin(), a.end(), scene.withGate.begin() + f * VoiceSamples); std::copy(b.begin(), b.end(), scene.withoutGate.begin() + f * VoiceSamples);
        }
        return scene;
    }
    // Pause energy from 400 ms after the talker stops (past hold + release) of input, gated and RNNoise-only output,
    // and the share of the talker's samples (after each burst's first 20 ms) the gate left bit-exact.
    struct GateResult { double pauseIn = 0, pauseGate = 0, pausePlain = 0, untouched = 0; };
    static GateResult measureGate(const GateScene& scene) {
        GateResult result; long speech = 0, bitExact = 0;
        for (size_t n = scene.delay; n < scene.input.size(); ++n) {   // output n carries input n - delay (RNNoise: 10 ms)
            const int frame = int((n - scene.delay) / VoiceSamples), cycle = frame % kGateCycle;
            if (gateTalking(frame) && cycle >= 1) { ++speech; bitExact += scene.withGate[n] == scene.withoutGate[n]; }
            if (frame >= 25 && cycle >= kGateTalk + 20 && cycle < kGateCycle - 2) {
                result.pauseIn += double(scene.input[n - scene.delay]) * scene.input[n - scene.delay];
                result.pauseGate += double(scene.withGate[n]) * scene.withGate[n]; result.pausePlain += double(scene.withoutGate[n]) * scene.withoutGate[n];
            }
        }
        result.untouched = double(bitExact) / speech;
        return result;
    }
private slots:
    void stereoPanKeepsChannelsIndependent() {
        VoiceFrame signal{}, left{}, right{}; signal.fill(.25f);
        mixStereoVoiceFrame(left, right, signal, 1.f, -1.f, false);
        for (int n = 0; n < VoiceSamples; ++n) { QCOMPARE(left[n], .25f); QCOMPARE(right[n], 0.f); }
        left.fill(0); right.fill(0);
        mixStereoVoiceFrame(left, right, signal, 2.f, 1.f, false);
        for (int n = 0; n < VoiceSamples; ++n) { QCOMPARE(left[n], 0.f); QCOMPARE(right[n], .5f); }
        left.fill(0); right.fill(0);
        mixStereoVoiceFrame(left, right, signal, 1.f, 0.f, false);
        mixStereoVoiceFrame(left, right, signal, 1.f, 1.f, true);
        for (int n = 0; n < VoiceSamples; ++n) { QCOMPARE(left[n], .25f); QCOMPARE(right[n], .25f); }
    }
    void stereoPcmPreservesChannelsAndClips() {
        const std::array<float, 3> left{.25f, 2.f, -.5f}, right{-.25f, -2.f, .5f};
        for (auto type : {QAudioFormat::UInt8, QAudioFormat::Int16, QAudioFormat::Int32, QAudioFormat::Float}) {
            QAudioFormat format; format.setSampleRate(48000); format.setChannelCount(2); format.setSampleFormat(type);
            const auto pcm = encodeStereo(left, right, format);
            QAudioFormat mono = format; mono.setChannelCount(1);
            QByteArray channelLeft, channelRight;
            for (int n = 0; n < 3; ++n) {
                channelLeft += pcm.mid(n * format.bytesPerFrame(), format.bytesPerSample());
                channelRight += pcm.mid(n * format.bytesPerFrame() + format.bytesPerSample(), format.bytesPerSample());
            }
            const auto decodedLeft = decodeMono(channelLeft, mono), decodedRight = decodeMono(channelRight, mono);
            for (int n = 0; n < 3; ++n) {
                QVERIFY(std::abs(decodedLeft[n] - std::clamp(left[n], -1.f, 1.f)) < .009f);
                QVERIFY(std::abs(decodedRight[n] - std::clamp(right[n], -1.f, 1.f)) < .009f);
            }
            const auto downmix = decodeMono(encodeStereo(left, right, mono), mono);
            for (float sample : downmix) QVERIFY(std::abs(sample) < .009f);
            QVERIFY_EXCEPTION_THROWN(encodeStereo(left, std::span(right).first(2), format), std::invalid_argument);
        }
    }
    void localVolumeAndMuteAffectMixedAudio() {
        VoiceFrame a{}, b{}, output{}; a.fill(.1f); b.fill(.2f);
        mixVoiceFrame(output, a, 2.f, false);
        mixVoiceFrame(output, b, 1.f, true);
        for (float sample : output) QCOMPARE(sample, .2f);
        mixVoiceFrame(output, b, .5f, false);
        for (float sample : output) QVERIFY(std::abs(sample - .3f) < .00001f);
        output.fill(0);
        mixVoiceFrame(output, a, 0.f, false);
        mixVoiceFrame(output, b, -1.f, false);
        mixVoiceFrame(output, a, std::numeric_limits<float>::quiet_NaN(), false);
        for (float sample : output) QCOMPARE(sample, 0.f);
    }
    void inputAndOutputGainScaleAudioSamples() {
        VoiceDevices devices;
        devices.setInputGain(0.5f);
        QCOMPARE(devices.inputGain(), 0.5f);
        devices.setInputGain(-0.5f);
        QCOMPARE(devices.inputGain(), 0.0f);
        devices.setInputGain(1.5f);
        QCOMPARE(devices.inputGain(), 1.0f);

        devices.setOutputGain(1.5f);
        QCOMPARE(devices.outputGain(), 1.5f);
        devices.setOutputGain(-0.5f);
        QCOMPARE(devices.outputGain(), 0.0f);
        devices.setOutputGain(2.5f);
        QCOMPARE(devices.outputGain(), 2.0f);

        // Verify DSP gain scaling on audio frames
        VoiceFrame base{}, mixed{};
        base.fill(0.4f);
        mixVoiceFrame(mixed, base, 1.0f, false);
        for (float s : mixed) QCOMPARE(s, 0.4f);

        VoiceFrame attenuated{};
        const float gainHalf = 0.5f;
        for (int i = 0; i < VoiceSamples; ++i) attenuated[i] = std::clamp(mixed[i] * gainHalf, -1.f, 1.f);
        for (float s : attenuated) QCOMPARE(s, 0.2f);

        VoiceFrame zeroed{};
        const float gainZero = 0.0f;
        for (int i = 0; i < VoiceSamples; ++i) zeroed[i] = std::clamp(mixed[i] * gainZero, -1.f, 1.f);
        for (float s : zeroed) QCOMPARE(s, 0.0f);

        VoiceFrame boosted{};
        const float gainDouble = 2.0f;
        for (int i = 0; i < VoiceSamples; ++i) boosted[i] = std::clamp(mixed[i] * gainDouble, -1.f, 1.f);
        for (float s : boosted) QCOMPARE(s, 0.8f);

        // Verify Discord REA perceptual volume curve (module 792251)
        QCOMPARE(sliderToGain(0), 0.0f);
        QVERIFY(std::abs(sliderToGain(25) - 0.0206173f) < 0.0001f);
        QVERIFY(std::abs(sliderToGain(50) - 0.1435873f) < 0.0001f);
        QVERIFY(std::abs(sliderToGain(75) - 0.4468600f) < 0.0001f);
        QCOMPARE(sliderToGain(100), 1.0f);
        QVERIFY(std::abs(sliderToGain(150) - 1.4125375f) < 0.0001f);
        QVERIFY(std::abs(sliderToGain(200) - 1.9952623f) < 0.0001f);

        // Verify stereo master gain scaling (both left and right channels)
        VoiceFrame leftSignal{}, rightSignal{};
        leftSignal.fill(0.3f);
        rightSignal.fill(0.5f);

        // At gain 0 (slider 0%) -> both channels muted
        VoiceFrame leftZero = leftSignal, rightZero = rightSignal;
        applyMasterOutputGain(leftZero, &rightZero, sliderToGain(0));
        for (float s : leftZero) QCOMPARE(s, 0.0f);
        for (float s : rightZero) QCOMPARE(s, 0.0f);

        // At gain 1.0 (slider 100%) -> exact original
        VoiceFrame leftUnity = leftSignal, rightUnity = rightSignal;
        applyMasterOutputGain(leftUnity, &rightUnity, sliderToGain(100));
        for (float s : leftUnity) QCOMPARE(s, 0.3f);
        for (float s : rightUnity) QCOMPARE(s, 0.5f);

        // At gain ~1.995 (slider 200%) -> both scaled by ~2
        VoiceFrame leftDouble = leftSignal, rightDouble = rightSignal;
        applyMasterOutputGain(leftDouble, &rightDouble, sliderToGain(200));
        for (float s : leftDouble) QVERIFY(std::abs(s - (0.3f * 1.9952623f)) < 0.001f);
        for (float s : rightDouble) QVERIFY(std::abs(s - (0.5f * 1.9952623f)) < 0.001f);

        // Test pan effect + master output gain
        VoiceFrame panLeft{}, panRight{}, inputTone{};
        inputTone.fill(0.4f);
        mixStereoVoiceFrame(panLeft, panRight, inputTone, 1.0f, 1.0f, false); // full right pan
        for (float s : panLeft) QCOMPARE(s, 0.0f);
        for (float s : panRight) QCOMPARE(s, 0.4f);
        applyMasterOutputGain(panLeft, &panRight, sliderToGain(50)); // ~0.1436
        for (float s : panLeft) QCOMPARE(s, 0.0f);
        for (float s : panRight) QVERIFY(std::abs(s - (0.4f * 0.1435873f)) < 0.001f);
    }
    void peerControlsApplyToQueuedPcmAndResetOnRemoval() {
        VoiceDevices devices;
        VoiceFrame alice{}, bob{}, left{}, right{}; alice.fill(.2f); bob.fill(.1f);
        auto expect = [&](float l, float r) {
            devices.mixNextFrame(left, &right);
            for (int n = 0; n < VoiceSamples; ++n) {
                QVERIFY(std::abs(left[n]-l) < .0001f); QVERIFY(std::abs(right[n]-r) < .0001f);
            }
        };
        devices.setPeerVolume("alice",1.5f); devices.setPeerPan("alice",-1.f);
        devices.enqueue("alice",alice); devices.enqueue("bob",bob); expect(.4f,.1f);
        devices.setPeerMuted("alice",true);
        devices.enqueue("alice",alice); devices.enqueue("bob",bob); expect(.1f,.1f);
        devices.setPeerVolume("bob",0.f);
        devices.enqueue("alice",alice); devices.enqueue("bob",bob); expect(0.f,0.f);
        devices.setPeerMuted("alice",false); devices.setPeerVolume("alice",2.f); devices.setPeerPan("alice",1.f);
        devices.enqueue("alice",alice); expect(0.f,.4f);
        devices.removePeer("alice"); devices.enqueue("alice",alice); expect(.2f,.2f);
        devices.setOutputGain(.5f); devices.enqueue("alice",alice); expect(.1f,.1f);
        devices.setOutputGain(1.f); devices.setPeerPan("alice",-1.f); devices.enqueue("alice",alice);
        devices.mixNextFrame(left); for (float value : left) QVERIFY(std::abs(value-.2f) < .0001f);
        devices.setDeafened(true); devices.enqueue("alice",alice); expect(0.f,0.f);
    }
    void speakingHoldsBriefPausesAndResets() {
        VoiceActivity activity; VoiceFrame silence{};
        QVERIFY(!activity.update(&silence)); auto signal = tone(0);
        QVERIFY(activity.update(&signal)); QVERIFY(activity.active());
        for (int n = 0; n < 14; ++n) QVERIFY(!activity.update(nullptr));
        QVERIFY(activity.update(nullptr)); QVERIFY(!activity.active());
        QVERIFY(activity.update(&signal)); QVERIFY(activity.reset()); QVERIFY(!activity.active());
        // A quiet voice (about -40 dBFS) lights it up; room noise (about -60 dBFS) does not.
        VoiceActivity quiet; VoiceFrame soft{}, hiss{};
        for (int i = 0; i < VoiceSamples; ++i) { soft[i] = 0.014f * std::sin(2 * 3.141592653589793 * 220 * i / VoiceRate); hiss[i] = (i % 2 ? 1 : -1) * 0.001f; }
        QVERIFY(!quiet.update(&hiss)); QVERIFY(quiet.update(&soft)); QVERIFY(quiet.active());
    }
    void pcmRoundTripsAllFormatsAndChannels() {
        const std::array<float, 5> input{-1.f, -0.4f, 0.f, 0.4f, 1.f};
        for (auto type : {QAudioFormat::UInt8, QAudioFormat::Int16, QAudioFormat::Int32, QAudioFormat::Float}) {
            QAudioFormat format; format.setSampleRate(44100); format.setChannelCount(2); format.setSampleFormat(type);
            const auto output = decodeMono(encodeMono(input, format), format);
            QCOMPARE(output.size(), input.size());
            for (size_t i = 0; i < input.size(); ++i) QVERIFY(std::abs(output[i] - input[i]) < 0.009);
            QVERIFY_EXCEPTION_THROWN(decodeMono(QByteArray(1, 0), format), std::invalid_argument);
        }
    }
    void resamplerPreservesToneAndStreamChunking() {
        std::vector<float> input(44100);
        for (size_t i = 0; i < input.size(); ++i) input[i] = 0.2f * std::sin(2 * 3.141592653589793 * 440 * i / 44100);
        VoiceResampler whole(44100, 48000), chunked(44100, 48000);
        const auto expected = whole.process(input);
        std::vector<float> actual;
        for (size_t offset = 0; offset < input.size(); offset += 111) {
            const auto chunk = chunked.process(std::span(input).subspan(offset, std::min(size_t(111), input.size() - offset)));
            actual.insert(actual.end(), chunk.begin(), chunk.end());
        }
        QCOMPARE(actual.size(), expected.size());
        QVERIFY(actual.size() > 47700 && actual.size() <= 48000);
        double energy = 0;
        int crossings = 0;
        for (size_t i = 1; i < actual.size(); ++i) {
            QVERIFY(std::isfinite(actual[i]));
            QVERIFY(std::abs(actual[i] - expected[i]) < 1e-5);
            energy += actual[i] * actual[i];
            if (actual[i - 1] <= 0 && actual[i] > 0) ++crossings;
        }
        QVERIFY(crossings >= 435 && crossings <= 441);
        QVERIFY(std::sqrt(energy / actual.size()) > 0.12);
    }
    void downsamplerRejectsAliasing() {
        VoiceResampler resampler(48000, 16000);
        std::vector<float> input(48000);
        for (size_t i = 0; i < input.size(); ++i) input[i] = 0.2f * std::sin(2 * 3.141592653589793 * 12000 * i / 48000);
        const auto output = resampler.process(input);
        double energy = 0;
        for (size_t i = 300; i < output.size(); ++i) energy += output[i] * output[i];
        QVERIFY(std::sqrt(energy / (output.size() - 300)) < 0.01);
    }
    void noiseSuppressionReducesStationaryNoise() {
        VoiceProcessor processor;
        processor.setOptions(true, false, false);
        std::mt19937 random(42);
        std::uniform_real_distribution<float> noise(-0.05f, 0.05f);
        double before = 0, after = 0;
        for (int n = 0; n < 300; ++n) {
            VoiceFrame mic{}; for (auto& sample : mic) sample = noise(random);
            const auto output = processor.process(mic, {});
            if (n >= 200) for (int i = 0; i < VoiceSamples; ++i) { before += mic[i] * mic[i]; after += output[i] * output[i]; }
        }
        QVERIFY2(after < before * 0.1, qPrintable(QString("noise %1 dB").arg(10 * std::log10(after / before))));   // RNNoise: >= 10 dB less
        processor.setOptions(false, false, false);
        const auto frame = tone(0);
        QCOMPARE(processor.process(frame, {}), frame);
    }
    // 18/10: "stop hearing my friend's keyboard". From 400 ms after the talker stops (past hold + release) the typing
    // comes out at least 20 dB below RNNoise alone; while they talk the gate leaves RNNoise's output bit-exact.
    void voiceGateRemovesTypingBetweenSentences() {
        const auto result = measureGate(gateScene(true, -INFINITY));
        QVERIFY(result.pauseIn > 0);
        QVERIFY2(result.pauseGate < result.pausePlain * .01, qPrintable(QString("gate %1 dB below RNNoise").arg(10 * std::log10(result.pausePlain / result.pauseGate))));
        QVERIFY2(result.pauseGate < result.pauseIn * .01, qPrintable(QString("clicks %1 dB").arg(10 * std::log10(result.pauseGate / result.pauseIn))));
        QVERIFY2(result.untouched >= .99, qPrintable(QString("speech untouched %1%").arg(100 * result.untouched)));
    }
    // "... and the kids in the background": a voice 30 dB below the talker (another room) is speech to RNNoise, which
    // keeps it; the gate drops it by 20 dB more. A second person near the microphone (6 dB below) still comes through.
    // Known limit: keystrokes over a distant voice can open single 10 ms blocks (both rules pass), so typing then leaks.
    void voiceGateRemovesBackgroundVoices() {
        const auto far = measureGate(gateScene(false, -30));
        QVERIFY2(far.pausePlain > far.pauseIn * .3, qPrintable(QString("RNNoise alone keeps a background voice: %1 dB").arg(10 * std::log10(far.pausePlain / far.pauseIn))));
        QVERIFY2(far.pauseGate < far.pausePlain * .01, qPrintable(QString("background voice %1 dB below RNNoise").arg(10 * std::log10(far.pausePlain / far.pauseGate))));
        QVERIFY2(far.untouched >= .99, qPrintable(QString("speech untouched %1%").arg(100 * far.untouched)));
        const auto near = measureGate(gateScene(false, -6));
        QVERIFY2(near.pauseGate > near.pausePlain * .5, qPrintable(QString("nearby voice %1 dB").arg(10 * std::log10(near.pauseGate / near.pausePlain))));
    }
    // "Alta qualidade" (DeepFilterNet 3, staged by scripts/build-deepfilter.ps1): the gate follows its 30 ms delay, so
    // typing between sentences still drops >= 20 dB below DeepFilterNet alone and the talker stays bit-exact.
    void suppressionStrengthBlendsAlignedAudio_data() {
        QTest::addColumn<bool>("high");
        QTest::newRow("RNNoise") << false;
        QTest::newRow("DeepFilterNet") << true;
    }
    void suppressionStrengthBlendsAlignedAudio() {
        QFETCH(bool, high);
        if (high && !DeepFilter::available()) QSKIP("DeepFilterNet is not staged");
        VoiceProcessor full, half, dry;
        for (auto* processor : {&full, &half, &dry}) {
            processor->setOptions(true, false, false);
            if (high) { processor->setHighQuality(true); QVERIFY(processor->waitForDeepFilter(10000)); }
        }
        full.setSuppressionStrength(2.f); // clamped to full suppression
        half.setSuppressionStrength(.5f);
        dry.setSuppressionStrength(-1.f); // clamped to original signal
        std::vector<float> input;
        const int delay = (high ? DeepFilter::kDelayBlocks : 1) * DeepFilter::kBlock;
        for (int frame = 0; frame < 30; ++frame) {
            const auto mic = tone(frame);
            input.insert(input.end(), mic.begin(), mic.end());
            const auto a = full.process(mic, {}), b = half.process(mic, {}), c = dry.process(mic, {});
            for (int i = 0; i < VoiceSamples; ++i) {
                const int n = frame * VoiceSamples + i - delay;
                const float original = n < 0 ? 0.f : input[size_t(n)];
                QVERIFY(std::abs(c[i] - original) < 1e-6f);
                QVERIFY(std::abs(b[i] - .5f * (a[i] + original)) < 1e-6f);
            }
            if (frame == 15) { // live changes must not flush the filter or change its delay
                half.setSuppressionStrength(0.f);
                half.setSuppressionStrength(.5f);
            }
        }
    }
    void deepFilterRejectsDamagedModel() {
        if (qEnvironmentVariableIsSet("TRISCORD_TEST_DAMAGED_MODEL")) {
            QVERIFY(!DeepFilter::create());
            VoiceProcessor processor;
            processor.setHighQuality(true);
            QVERIFY(!processor.waitForDeepFilter(10000));
            for (int frame = 0; frame < 20; ++frame)
                for (float sample : processor.process(tone(frame), {})) QVERIFY(std::isfinite(sample));
            return;
        }
        QTemporaryDir temporary;
        QVERIFY(temporary.isValid());
        const QString child = temporary.filePath("voice-tests.exe");
        QVERIFY(QFile::copy(QCoreApplication::applicationFilePath(), child));
        const QString original = QCoreApplication::applicationDirPath();
        QVERIFY(QDir(temporary.path()).mkdir("deepfilter"));
        const QString dll = original + "/deepfilter/df.dll";
        if (QFile::exists(dll)) QVERIFY(QFile::copy(dll, temporary.filePath("deepfilter/df.dll")));
        auto environment = QProcessEnvironment::systemEnvironment();
        environment.insert("TRISCORD_TEST_DAMAGED_MODEL", "1");
        environment.insert("PATH", original + ";" + environment.value("PATH"));
        for (bool damaged : {false, true}) {
            if (damaged) {
                QFile model(temporary.filePath("deepfilter/DeepFilterNet3_onnx.tar.gz"));
                QVERIFY(model.open(QIODevice::WriteOnly));
                QCOMPARE(model.write("damaged model"), qint64(13));
            }
            QProcess process;
            process.setProcessEnvironment(environment);
            process.start(child, {"deepFilterRejectsDamagedModel"});
            QVERIFY(process.waitForFinished(15000));
            const QByteArray output = process.readAllStandardOutput() + process.readAllStandardError();
            QVERIFY2(process.exitStatus() == QProcess::NormalExit && process.exitCode() == 0, output.constData());
        }
    }
    void deepFilterKeepsTheGateAligned() {
        if (!DeepFilter::available()) QSKIP("DeepFilterNet is not staged next to the tests");
        const auto scene = gateScene(true, -INFINITY, true);
        QCOMPARE(scene.delay, size_t(DeepFilter::kDelayBlocks) * kGateHalf);
        const auto result = measureGate(scene);
        QVERIFY2(result.pauseGate < result.pausePlain * .01 || result.pauseGate < result.pauseIn * 1e-4,
            qPrintable(QString("gate %1 dB below DeepFilterNet").arg(10 * std::log10(result.pausePlain / result.pauseGate))));
        QVERIFY2(result.untouched >= .99, qPrintable(QString("speech untouched %1%").arg(100 * result.untouched)));
    }
    // What "Alta qualidade" is for: keystrokes *while* someone talks. Real speech (DeepFilterNet's sample; a synthetic
    // voice is noise to a model trained on people) with typing all along, 5 dB below it. Against the clean speech, each
    // output aligned to its delay, DeepFilterNet improves SI-SDR at least 5 dB more than RNNoise (measured: +13.7 vs
    // +4.3) and runs well under real time (< 5 ms per 10 ms, the fallback threshold).
    void deepFilterRemovesTypingWhileTalking() {
        if (!DeepFilter::available()) QSKIP("DeepFilterNet is not staged next to the tests");
        QFile wav(QStringLiteral(TRISCORD_SPEECH_SAMPLE));
        if (!wav.open(QIODevice::ReadOnly)) QSKIP("DeepFilterNet's speech sample is not in .toolchain");
        const QByteArray bytes = wav.readAll();
        const int data = bytes.indexOf("data");
        QVERIFY(data > 0 && bytes.indexOf("fmt ") > 0);
        std::vector<float> clean;
        for (qsizetype i = data + 8; i + 1 < bytes.size(); i += 2) { qint16 v; std::memcpy(&v, bytes.constData() + i, 2); clean.push_back(.5f * v / 32768.f); }
        clean.resize(clean.size() / VoiceSamples * VoiceSamples);
        const size_t samples = clean.size();
        std::vector<float> typing(samples);
        std::mt19937 random(11);
        std::uniform_real_distribution<float> uniform(-1, 1), gap(.08f, .25f);
        for (size_t click = VoiceRate / 10; click + kGateHalf < samples; click += size_t(gap(random) * VoiceRate)) {
            Resonator thock(2500 + 1500 * (uniform(random) + 1), 400);
            for (int i = 0; i < kGateHalf; ++i) { const float x = uniform(random) * std::exp(-i / (.003f * VoiceRate)); typing[click + i] += .5f * x + 4 * thock.step(x); }
        }
        double speechPower = 0, typingPower = 0;
        for (size_t n = 0; n < samples; ++n) { speechPower += double(clean[n]) * clean[n]; typingPower += double(typing[n]) * typing[n]; }
        const float scale = float(std::sqrt(speechPower / typingPower / std::pow(10, .5)));
        std::vector<float> noisy(samples);
        for (size_t n = 0; n < samples; ++n) noisy[n] = clean[n] + scale * typing[n];
        const auto siSdr = [&](const std::vector<float>& out, size_t delay) {
            double sy = 0, ss = 0;
            for (size_t n = VoiceRate; n + delay < out.size(); ++n) { sy += double(out[n + delay]) * clean[n]; ss += double(clean[n]) * clean[n]; }
            const double a = sy / ss; double target = 0, error = 0;
            for (size_t n = VoiceRate; n + delay < out.size(); ++n) { const double t = a * clean[n], e = out[n + delay] - t; target += t * t; error += e * e; }
            return 10 * std::log10(target / error);
        };
        const auto run = [&](bool highQuality, double* microsPerBlock) {
            VoiceProcessor processor; processor.setOptions(true, false, false, false);
            if (highQuality) { processor.setHighQuality(true); if (!processor.waitForDeepFilter(10000)) return std::vector<float>{}; }
            std::vector<float> out(samples);
            const auto start = std::chrono::steady_clock::now();
            for (size_t f = 0; f < samples / VoiceSamples; ++f) {
                VoiceFrame mic{}; std::copy_n(noisy.begin() + f * VoiceSamples, VoiceSamples, mic.begin());
                const auto o = processor.process(mic, {}); std::copy(o.begin(), o.end(), out.begin() + f * VoiceSamples);
            }
            if (microsPerBlock) *microsPerBlock = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - start).count() / (samples / kGateHalf);
            if (highQuality && !processor.deepFilterActive()) return std::vector<float>{};
            return out;
        };
        double micros = 0;
        const auto deep = run(true, &micros), standard = run(false, nullptr);
        QVERIFY2(!deep.empty(), "DeepFilterNet did not load or fell back");
        const double input = siSdr(noisy, 0), withRnnoise = siSdr(standard, kGateHalf), withDeepFilter = siSdr(deep, size_t(DeepFilter::kDelayBlocks) * kGateHalf);
        const auto report = QString("input %1 dB, RNNoise %2 dB, DeepFilterNet %3 dB, %4 us per 10 ms").arg(input, 0, 'f', 1)
            .arg(withRnnoise, 0, 'f', 1).arg(withDeepFilter, 0, 'f', 1).arg(micros, 0, 'f', 0);
        qInfo("%s", qPrintable(report));
        QVERIFY2(withDeepFilter - input >= withRnnoise - input + 5, qPrintable(report));
        QVERIFY2(micros < 5000, qPrintable(report));
    }
    // The E2E's synthetic quiet voice (VoiceCall::syntheticTick, -40 dBFS sines with a 4 Hz envelope) still goes
    // through the default chain (RNNoise, gate, AGC) as loud as without the gate, and lights the green ring.
    void syntheticCallVoicePassesTheGate() {
        const auto frame = [](int n) {
            VoiceFrame pcm{};
            const bool talking = (n / 25) % 3 != 2;
            for (int i = 0; i < VoiceSamples; ++i) {
                const double t = double(n * VoiceSamples + i) / VoiceRate;
                const double noise = 0.0005 * std::sin(2 * 3.141592653589793 * 3733 * t + 0.7 * std::sin(91 * t));
                const double envelope = 0.5 + 0.5 * std::sin(2 * 3.141592653589793 * 4 * t);
                const double voice = std::sin(2 * 3.141592653589793 * 180 * t) + 0.6 * std::sin(2 * 3.141592653589793 * 360 * t) + 0.4 * std::sin(2 * 3.141592653589793 * 720 * t);
                pcm[i] = float(noise + (talking ? 0.012 * envelope * voice : 0.0));
            }
            return pcm;
        };
        VoiceProcessor gated, plain; plain.setOptions(true, false, true, false);
        VoiceActivity activity;
        double withGate = 0, withoutGate = 0; int speaking = 0;
        for (int n = 0; n < 300; ++n) {
            const auto a = gated.process(frame(n), {}), b = plain.process(frame(n), {});
            activity.update(&a);
            if (n >= 150 && (n / 25) % 3 != 2) { for (int i = 0; i < VoiceSamples; ++i) { withGate += a[i] * a[i]; withoutGate += b[i] * b[i]; } speaking += activity.active(); }
        }
        QVERIFY2(withGate > withoutGate * .9, qPrintable(QString("gate changes the synthetic voice by %1 dB").arg(10 * std::log10(withGate / withoutGate))));
        QCOMPARE(speaking, 100);
    }
    // Attack 5 ms, hold 150 ms after sustained speech, release to -40 dB over 200 ms; a lone speech-like block neither
    // holds nor releases slowly.
    void voiceGateTiming() {
        VoiceGate gate; gate.reset();
        std::array<float, 480> block{};
        const std::array<float, 480> next = [] { std::array<float, 480> ones; ones.fill(1); return ones; }();
        const auto run = [&](int blocks, float probability) { for (int i = 0; i < blocks; ++i) { block.fill(1); gate.process(block, next, probability, probability); } };
        QCOMPARE(gate.gainDb(), VoiceGate::kFloorDb);
        block.fill(1); gate.process(block, next, 1, 1);
        QCOMPARE(gate.gainDb(), 0.f);                    // fully open within the first 10 ms block
        QVERIFY(block[240] == 1.f && block[200] < 1.f);  // ... after 5 ms
        run(5, 1); run(14, 0);
        QCOMPARE(gate.gainDb(), 0.f);                    // 140 ms into the 150 ms hold
        run(6, 0);
        QVERIFY(gate.gainDb() < -5.f && gate.gainDb() > -15.f);
        run(15, 0);
        QCOMPARE(gate.gainDb(), VoiceGate::kFloorDb);
        QCOMPARE(block[479], std::pow(10.f, VoiceGate::kFloorDb / 20.f));
        run(1, 1); run(1, 0);                            // one click RNNoise mistook for speech: no hold, closed in 10 ms
        QCOMPARE(gate.gainDb(), VoiceGate::kFloorDb);
    }
    // 18/10: voices were too quiet for everyone. Speech-like bursts (with pauses) at about -40 dBFS come out at least
    // 12 dB louder after a few seconds, never clip; background noise alone is not amplified; with AGC off the signal
    // is untouched.
    void automaticGainControlRaisesQuietVoice() {
        std::mt19937 random(7);
        std::uniform_real_distribution<float> hiss(-0.0005f, 0.0005f);   // about -72 dBFS room noise
        auto speech = [&](int n, float amplitude) {
            VoiceFrame frame{};
            const bool talking = (n / 25) % 3 != 2;                          // 1 s talking, 0.5 s pause
            for (int i = 0; i < VoiceSamples; ++i) {
                const double t = double(n * VoiceSamples + i) / VoiceRate;
                const double envelope = 0.5 + 0.5 * std::sin(2 * 3.141592653589793 * 4 * t);
                const double voice = std::sin(2 * 3.141592653589793 * 180 * t) + 0.6 * std::sin(2 * 3.141592653589793 * 360 * t)
                    + 0.4 * std::sin(2 * 3.141592653589793 * 720 * t);
                frame[i] = hiss(random) + (talking ? float(amplitude * envelope * voice) : 0.f);
            }
            return frame;
        };
        VoiceProcessor processor; processor.setOptions(false, false, true);
        double before = 0, after = 0; float peak = 0;
        for (int n = 0; n < 300; ++n) {   // 6 s
            const auto mic = speech(n, 0.012f);
            const auto output = processor.process(mic, {});
            if (n >= 250) for (int i = 0; i < VoiceSamples; ++i) { before += mic[i] * mic[i]; after += output[i] * output[i]; peak = std::max(peak, std::abs(output[i])); }
        }
        QVERIFY2(after > before * 15.8, qPrintable(QString("gain %1 dB").arg(10 * std::log10(after / before))));   // >= +12 dB
        QVERIFY(peak < 1.f);
        // Loud speech is brought down, not clipped.
        VoiceProcessor loud; loud.setOptions(false, false, true);
        peak = 0;
        for (int n = 0; n < 200; ++n) { const auto out = loud.process(speech(n, 0.5f), {}); for (float v : out) peak = std::max(peak, std::abs(v)); }
        QVERIFY(peak < 1.f);
        // Noise alone stays where it is.
        VoiceProcessor quiet; quiet.setOptions(false, false, true);
        double noiseIn = 0, noiseOut = 0;
        for (int n = 0; n < 200; ++n) {
            VoiceFrame mic{}; for (auto& v : mic) v = hiss(random);
            const auto out = quiet.process(mic, {});
            if (n >= 150) for (int i = 0; i < VoiceSamples; ++i) { noiseIn += mic[i] * mic[i]; noiseOut += out[i] * out[i]; }
        }
        QVERIFY(noiseOut < noiseIn * 1.3);
        processor.setOptions(false, false, false);
        const auto frame = speech(0, 0.012f);
        QCOMPARE(processor.process(frame, {}), frame);
    }
    void echoReductionLearnsSyntheticDelayedEcho() {
        VoiceProcessor processor; processor.setOptions(false, true, false);
        std::mt19937 random(81);
        std::uniform_real_distribution<float> noise(-0.2f, 0.2f);
        VoiceFrame previous{};
        double before = 0, after = 0;
        for (int n = 0; n < 500; ++n) {
            VoiceFrame reference{}, mic{};
            for (int i = 0; i < VoiceSamples; ++i) { reference[i] = noise(random); mic[i] = previous[i] * 0.4f; }
            const auto output = processor.process(mic, reference);
            if (n >= 400) for (int i = 0; i < VoiceSamples; ++i) { before += mic[i] * mic[i]; after += output[i] * output[i]; }
            previous = reference;
        }
        QVERIFY(before > 1);
        QVERIFY(after < before * 0.1);
    }
    void mediaTransportContinuesWhileUiThreadIsBlocked() {
        std::atomic<int> frames{0};
        QThread media;
        auto* context = new QObject;
        context->moveToThread(&media);
        connect(&media, &QThread::finished, context, &QObject::deleteLater);
        media.start();
        auto cleanup = qScopeGuard([&] { media.quit(); media.wait(); });
        QMetaObject::invokeMethod(context, [&] {
            rtc::Configuration config;
            auto* a = new VoicePeer(config, context);
            auto* b = new VoicePeer(config, context);
            connect(a, &VoicePeer::localDescription, b, &VoicePeer::applyDescription);
            connect(b, &VoicePeer::localDescription, a, &VoicePeer::applyDescription);
            connect(a, &VoicePeer::localCandidate, b, &VoicePeer::addCandidate);
            connect(b, &VoicePeer::localCandidate, a, &VoicePeer::addCandidate);
            connect(b, &VoicePeer::audioReceived, context, [&](const QByteArray&, uint32_t) { ++frames; });
            auto* generator = new QTimer(context);
            generator->setTimerType(Qt::PreciseTimer);
            generator->setInterval(20);
            auto encoder = std::make_shared<VoiceEncoder>();
            connect(generator, &QTimer::timeout, context, [a, b, encoder] {
                if (a->connected() && b->connected()) a->sendOpus(encoder->encode(tone(0)));
            });
            generator->start();
            a->offer();
        }, Qt::BlockingQueuedConnection);
        QTRY_VERIFY_WITH_TIMEOUT(frames.load() >= 5, 15000);
        const int before = frames.load();
        QThread::msleep(200); // Deliberately do not process GUI-thread events.
        QVERIFY(frames.load() >= before + 4);
    }
    void opusRoundTripContainsAudio() {
        VoiceEncoder encoder;
        VoiceDecoder decoder;
        double energy = 0;
        for (int frame = 0; frame < 20; ++frame) {
            const auto packet = encoder.encode(tone(frame));
            QVERIFY(packet.size() > 0 && packet.size() <= 1275);
            const auto pcm = decoder.decode(packet);
            for (float sample : pcm) { QVERIFY(std::isfinite(sample)); energy += sample * sample; }
        }
        QVERIFY(std::sqrt(energy / (20 * VoiceSamples)) > 0.05);
    }
    void invalidOpusDoesNotCrash() {
        VoiceDecoder decoder;
        QVERIFY_EXCEPTION_THROWN(decoder.decode(QByteArray(1275, static_cast<char>(0xff))), std::runtime_error);
        const auto concealment = decoder.decode({});
        for (float sample : concealment) QVERIFY(std::isfinite(sample));
    }
    void jitterReordersBoundsAndReprimes() {
        VoiceEncoder encoder;
        const auto packet = encoder.encode(tone(0));
        VoiceJitter jitter;
        jitter.push(960, packet);
        QVERIFY(!jitter.pop());
        jitter.push(2880, packet); // 1920 is missing.
        jitter.push(1920, packet); // Arrives reordered before playout.
        QVERIFY(jitter.pop()); QCOMPARE(jitter.queued(), size_t(2));
        QVERIFY(jitter.pop()); QCOMPARE(jitter.queued(), size_t(1));
        QVERIFY(jitter.pop()); QCOMPARE(jitter.queued(), size_t(0));
        jitter.push(960, packet); // Too late; must not replay it.
        QCOMPARE(jitter.queued(), size_t(0));
        for (int i = 0; i < 6; ++i) jitter.pop();
        QVERIFY(!jitter.pop());
        jitter.push(100000, packet); jitter.push(100960, packet);
        QVERIFY(!jitter.pop());   // three packets (60 ms) of headroom before playing
        jitter.push(101920, packet);
        QVERIFY(jitter.pop());
        for (int i = 0; i < 20; ++i) jitter.push(100960 + i * 960, packet);
        QVERIFY(jitter.queued() <= 10);   // bounded at 200 ms, keeping the newest
    }
    // 19/10, "voices sound robotic": a lost packet is rebuilt from the next one's Opus FEC (not concealed), and a queue
    // left long by a burst drains back below 100 ms instead of keeping the delay.
    void jitterRecoversLossWithFecAndDrains() {
        VoiceEncoder encoder;
        std::vector<QByteArray> packets;
        for (int i = 0; i < 6; ++i) packets.push_back(encoder.encode(tone(i)));
        VoiceJitter jitter;
        for (int i : {0, 1, 2, 4, 5}) jitter.push(uint32_t(i) * VoiceSamples, packets[size_t(i)]);   // 3 is lost
        for (int i = 0; i < 3; ++i) QVERIFY(jitter.pop());
        QCOMPARE(jitter.queued(), size_t(2));
        QVERIFY(jitter.pop());   // frame 3 from packet 4's FEC; packet 4 stays for its own turn
        QCOMPARE(jitter.queued(), size_t(2));
        QVERIFY(jitter.pop()); QVERIFY(jitter.pop());
        QCOMPARE(jitter.queued(), size_t(0));
        VoiceJitter late;
        uint32_t next = 0;
        for (int i = 0; i < 9; ++i) late.push(next++ * VoiceSamples, packets[0]);   // a 180 ms burst
        for (int tick = 0; tick < 300; ++tick) { late.push(next++ * VoiceSamples, packets[0]); QVERIFY(late.pop()); }
        QVERIFY2(late.queued() <= 5, qPrintable(QString("still %1 packets queued after 6 s").arg(late.queued())));
    }
    void duplicateDoesNotFlushFullJitterBuffer() {
        VoiceEncoder encoder;
        const auto packet = encoder.encode(tone(0));
        VoiceJitter jitter;
        for (uint32_t i = 0; i < 10; ++i) jitter.push(i * VoiceSamples, packet);
        jitter.push(2 * VoiceSamples, packet);
        QCOMPARE(jitter.queued(), size_t(10));
        QVERIFY(jitter.pop());
        QCOMPARE(jitter.queued(), size_t(9));
    }
    void jitterHandlesTimestampWrap() {
        VoiceEncoder encoder;
        const auto packet = encoder.encode(tone(0));
        VoiceJitter jitter;
        const uint32_t first = 0xffffffffU - 400U;
        jitter.push(first, packet); jitter.push(first + 960U, packet); jitter.push(first + 1920U, packet);
        QVERIFY(jitter.pop()); QVERIFY(jitter.pop()); QVERIFY(jitter.pop());
        QCOMPARE(jitter.queued(), size_t(0));
    }
    // 19/10, voices still robotic over a TURN relay: a packet 20-80 ms late found its slot already concealed and was
    // dropped as stale. With nothing queued it is waited for (concealment holds the timeline), then played, and the
    // drain's resting depth grows to cover the spike; calm traffic brings it back down.
    void jitterWaitsForLatePacketsAndAdapts() {
        VoiceEncoder encoder;
        std::vector<QByteArray> packets;
        for (int i = 0; i < 8; ++i) packets.push_back(encoder.encode(tone(i)));
        VoiceJitter jitter;
        for (int i = 0; i < 3; ++i) jitter.push(uint32_t(i) * VoiceSamples, packets[size_t(i)]);
        for (int i = 0; i < 3; ++i) QVERIFY(jitter.pop());
        QVERIFY(jitter.pop()); QVERIFY(jitter.pop());   // 40 ms spike: concealed while waiting
        jitter.push(3 * VoiceSamples, packets[3]); jitter.push(4 * VoiceSamples, packets[4]);
        QCOMPARE(jitter.queued(), size_t(2));            // not dropped as stale
        QVERIFY(jitter.pop());
        QCOMPARE(jitter.queued(), size_t(1));            // packet 3 played in its turn
        QCOMPARE(jitter.target(), size_t(5));            // 3 + the two ticks it was late
        // Steady traffic: the depth goes back to 3 packets after calm seconds, and the queue never runs away.
        uint32_t next = 5;
        for (int tick = 0; tick < 2500; ++tick) { jitter.push(next++ * VoiceSamples, packets[0]); QVERIFY(jitter.pop()); }
        QCOMPARE(jitter.target(), size_t(3));
        QVERIFY(jitter.queued() <= 5);
        // A talker who stops still resets after 100 ms instead of concealing forever.
        for (int i = 0; i < 6; ++i) jitter.pop();
        QVERIFY(!jitter.pop());
    }
    void playbackTopsUpALateDevice() {
        const qint64 frame = 3840, buffer = frame * 3;   // 20 ms of 48 kHz stereo float; 60 ms device buffer
        QCOMPARE(playbackFramesNeeded(buffer, buffer, frame), 2);          // empty (a late tick): back to 40 ms
        QCOMPARE(playbackFramesNeeded(buffer, frame * 2, frame), 1);       // 20 ms left: one frame brings it to 40 ms
        QCOMPARE(playbackFramesNeeded(buffer, frame, frame), 1);           // 40 ms queued: the usual one frame
        QCOMPARE(playbackFramesNeeded(frame * 5, frame * 5, frame), 2);    // drained 100 ms buffer: two frames at once
        QCOMPARE(playbackFramesNeeded(buffer, frame - 1, frame), 0);       // full: wait for the device
        QCOMPARE(playbackFramesNeeded(frame * 20, frame * 20, frame), 2);  // a large buffer is not flooded
        QCOMPARE(playbackFramesNeeded(buffer, buffer, 0), 0);
    }
    void encryptedPeerAudioInBothDirections() {
        rtc::Configuration config; // Local test, no STUN/TURN provider.
        VoicePeer a(config), b(config);
        connect(&a, &VoicePeer::localDescription, &b, &VoicePeer::applyDescription);
        connect(&b, &VoicePeer::localDescription, &a, &VoicePeer::applyDescription);
        connect(&a, &VoicePeer::localCandidate, &b, &VoicePeer::addCandidate);
        connect(&b, &VoicePeer::localCandidate, &a, &VoicePeer::addCandidate);
        QSignalSpy receivedA(&a, &VoicePeer::audioReceived);
        QSignalSpy receivedB(&b, &VoicePeer::audioReceived);
        a.offer();
        QTRY_VERIFY_WITH_TIMEOUT(a.connected() && b.connected(), 15000);
        VoiceEncoder encoderA, encoderB;
        VoiceDecoder decoderA, decoderB;
        for (int frame = 0; frame < 12; ++frame) {
            QVERIFY(a.sendOpus(encoderA.encode(tone(frame))));
            QVERIFY(b.sendOpus(encoderB.encode(tone(frame))));
            QTest::qWait(20);
        }
        QTRY_VERIFY_WITH_TIMEOUT(receivedA.size() >= 5 && receivedB.size() >= 5, 3000);
        double energyA = 0, energyB = 0;
        for (const auto& args : receivedA) for (float sample : decoderA.decode(args.first().toByteArray())) energyA += sample * sample;
        for (const auto& args : receivedB) for (float sample : decoderB.decode(args.first().toByteArray())) energyB += sample * sample;
        QVERIFY(energyA > 1 && energyB > 1); // Decodable audio, not just a connected socket.
    }
};
QTEST_GUILESS_MAIN(VoiceTests)
#include "voice_tests.moc"
