#include "voice_devices.h"
#include "com_apartment.h"
#include "voice_mix.h"
#include <QMediaDevices>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <QJsonObject>

namespace triscord {
namespace {
QAudioDevice selectedDevice(const QList<QAudioDevice>& devices, const QByteArray& id, bool input) {
    if (id.isEmpty()) return input ? QMediaDevices::defaultAudioInput() : QMediaDevices::defaultAudioOutput();
    for (const auto& device : devices) if (device.id() == id) return device;
    return {}; // An unavailable explicit choice must not silently open another microphone.
}
QJsonArray deviceList(const QList<QAudioDevice>& devices) {
    QJsonArray result;
    for (const auto& device : devices)
        result.append(QJsonObject{{"id", QString::fromLatin1(device.id().toHex())}, {"name", device.description()}, {"isDefault", device.isDefault()}});
    return result;
}
QAudioFormat formatFor(const QAudioDevice& device, bool stereo = false) {
    QAudioFormat format;
    format.setSampleRate(VoiceRate);
    format.setChannelCount(stereo ? 2 : 1);
    format.setSampleFormat(QAudioFormat::Float);
    if (device.isFormatSupported(format)) return format;
    format.setSampleFormat(QAudioFormat::Int16);
    if (device.isFormatSupported(format)) return format;
    format = device.preferredFormat();
    if (format.sampleRate() < 8000 || format.sampleRate() > 192000 ||
        format.channelCount() < 1 || format.channelCount() > 8 || !format.isValid()) return {};
    return format;
}
}
VoiceDevices::VoiceDevices(QObject* parent) : QObject(parent), processing_(std::make_unique<Processing>()) {
    processingThread_.setParent(this);
    processingWorker_ = new QObject;
    processingWorker_->moveToThread(&processingThread_);
    connect(&processingThread_, &QThread::finished, processingWorker_, &QObject::deleteLater);
    joinMultithreadedApartment(processingThread_);
    processingThread_.setObjectName("TriscordVoiceProcessing"); processingThread_.start(QThread::HighestPriority);
    playback_.setParent(this);
    refresh_.setParent(this);
    mediaDevices_.setParent(this);
    refresh_.setSingleShot(true);
    refresh_.setInterval(200);
    connect(&mediaDevices_, &QMediaDevices::audioInputsChanged, &refresh_, qOverload<>(&QTimer::start));
    connect(&mediaDevices_, &QMediaDevices::audioOutputsChanged, &refresh_, qOverload<>(&QTimer::start));
    connect(&refresh_, &QTimer::timeout, this, &VoiceDevices::refreshDevices);
    playback_.setTimerType(Qt::PreciseTimer);
    playback_.setInterval(20);
    connect(&playback_, &QTimer::timeout, this, &VoiceDevices::playMixedFrame);
}
VoiceDevices::~VoiceDevices() {
    stop();
    QMetaObject::invokeMethod(processingWorker_, [this] { processing_.reset(); }, Qt::BlockingQueuedConnection);
    processingThread_.quit(); processingThread_.wait();
}
void VoiceDevices::resetProcessing() {
    ++processingGeneration_;
    QMetaObject::invokeMethod(processingWorker_, [this] { processing_->processor.reset(); });
}
void VoiceDevices::processMicrophone(const VoiceFrame& frame, const VoiceFrame& reference) {
    // Bound CPU backlog to 100 ms; never let denoising block network/playback. A dropped frame is a hole the others
    // hear as a robotic stutter, so a short stall (a game taking the CPU) is absorbed rather than dropped (19/10).
    if (processingPending_ >= 5) return;
    ++processingPending_;
    const auto generation = processingGeneration_;
    QMetaObject::invokeMethod(processingWorker_, [this, frame, reference, generation] {
        VoiceFrame processed{}; QByteArray packet;
        try {
            processed = processing_->processor.process(frame, reference);
            packet = processing_->encoder.encode(processed);
        } catch (const std::exception&) { }
        QMetaObject::invokeMethod(this, [this, generation, processed, packet] {
            --processingPending_;
            if (generation != processingGeneration_ || muted_ || deafened_ || !running_) return;
            if (packet.isEmpty()) { deviceError(deviceGeneration_); return; }
            if (activity_.update(&processed)) emit speakingChanged(activity_.active());
            emit captured(packet);
        }, Qt::QueuedConnection);
    });
}
bool VoiceDevices::start() {
    closeHardware();
    desired_ = true;
    const auto mic = selectedDevice(QMediaDevices::audioInputs(), selectedInput_, true);
    const auto speakers = selectedDevice(QMediaDevices::audioOutputs(), selectedOutput_, false);
    inputFormat_ = formatFor(mic);
    outputFormat_ = formatFor(speakers, true);
    if (mic.isNull() || speakers.isNull() || !inputFormat_.isValid() || !outputFormat_.isValid()) {
        emit error("Áudio indisponível. Escolha um microfone e uma saída compatíveis nas opções de áudio."); return false;
    }
    input_ = std::make_unique<QAudioSource>(mic, inputFormat_);
    try {
        inputResampler_ = std::make_unique<VoiceResampler>(inputFormat_.sampleRate(), VoiceRate);
        outputResampler_ = std::make_unique<VoiceResampler>(VoiceRate, outputFormat_.sampleRate());
        if (outputFormat_.channelCount() >= 2) rightResampler_ = std::make_unique<VoiceResampler>(VoiceRate, outputFormat_.sampleRate());
    } catch (const std::exception&) {
        closeHardware(); emit error("Não foi possível preparar o áudio destes dispositivos."); return false;
    }
    output_ = std::make_unique<QAudioSink>(speakers, outputFormat_);
    openedInput_ = mic.id(); openedOutput_ = speakers.id();
    const auto generation = deviceGeneration_;
    connect(input_.get(), &QAudioSource::stateChanged, this, [this, generation](QtAudio::State state) {
        if (!closing_ && generation == deviceGeneration_ && state == QtAudio::StoppedState && input_ && input_->error() != QtAudio::NoError)
            deviceError(generation);
    });
    connect(output_.get(), &QAudioSink::stateChanged, this, [this, generation](QtAudio::State state) {
        if (!closing_ && generation == deviceGeneration_ && state == QtAudio::StoppedState && output_ && output_->error() != QtAudio::NoError)
            deviceError(generation);
    });
    input_->setBufferSize(inputFormat_.bytesForDuration(60000));
    output_->setBufferSize(outputFormat_.bytesForDuration(60000));
    reader_ = input_->start();
    writer_ = output_->start();
    if (!reader_ || !writer_ || input_->error() != QtAudio::NoError || output_->error() != QtAudio::NoError) {
        closeHardware(); emit error("Não foi possível iniciar o áudio. Confira as permissões e os dispositivos."); return false;
    }
    connect(reader_, &QIODevice::readyRead, this, &VoiceDevices::readMicrophone);
    if (deafened_) input_->suspend();
    if (deafened_) output_->suspend();
    else playback_.start();
    running_ = true;
    emit runningChanged(true);
    return true;
}
void VoiceDevices::stop() {
    desired_ = false;
    closeHardware();
}
void VoiceDevices::closeHardware() {
    if (activity_.reset()) emit speakingChanged(false);
    closing_ = true;
    ++deviceGeneration_;
    playback_.stop();
    if (input_) input_->stop();
    if (output_) output_->stop();
    input_.reset(); output_.reset(); reader_ = nullptr; writer_ = nullptr;
    captureBuffer_.clear(); queues_.clear();
    microphoneSamples_.clear(); played_.clear(); pendingPlayback_.clear();
    inputResampler_.reset(); outputResampler_.reset(); rightResampler_.reset(); resetProcessing();
    openedInput_.clear(); openedOutput_.clear();
    closing_ = false;
    if (running_) { running_ = false; emit runningChanged(false); }
}
void VoiceDevices::deviceError(uint64_t generation) {
    QTimer::singleShot(0, this, [this, generation] {
        if (generation != deviceGeneration_) return;
        closeHardware();
        emit error("O dispositivo de áudio parou. Reconecte-o ou escolha outro nas opções de áudio.");
    });
}
void VoiceDevices::publishDevices() {
    emit devicesChanged(deviceList(QMediaDevices::audioInputs()), deviceList(QMediaDevices::audioOutputs()));
}
void VoiceDevices::refreshDevices() {
    publishDevices();
    if (!desired_) return;
    const auto mic = selectedDevice(QMediaDevices::audioInputs(), selectedInput_, true);
    const auto speakers = selectedDevice(QMediaDevices::audioOutputs(), selectedOutput_, false);
    if (!running_ || mic.id() != openedInput_ || speakers.id() != openedOutput_) start();
}
void VoiceDevices::setDevices(const QByteArray& input, const QByteArray& output) {
    const bool changed = selectedInput_ != input || selectedOutput_ != output;
    selectedInput_ = input; selectedOutput_ = output;
    publishDevices();
    if (desired_ && (changed || !running_)) start();
}
void VoiceDevices::setMuted(bool muted) {
    if (muted_ != muted) { resetProcessing(); played_.clear(); }
    muted_ = muted; captureBuffer_.clear(); microphoneSamples_.clear();
    if ((muted_ || deafened_) && activity_.reset()) emit speakingChanged(false);
    if (input_) { if (muted_ || deafened_) input_->suspend(); else input_->resume(); }
}
void VoiceDevices::setDeafened(bool deafened) {
    deafened_ = deafened; queues_.clear(); played_.clear(); pendingPlayback_.clear(); resetProcessing();
    setMuted(muted_);
    if (output_) {
        if (deafened_) { playback_.stop(); output_->suspend(); }
        else { output_->resume(); playback_.start(); }
    }
}
void VoiceDevices::setProcessing(bool noise, bool echo, bool agc, bool highQuality, int strength) {
    QMetaObject::invokeMethod(processingWorker_, [this, noise, echo, agc, highQuality, strength] {
        processing_->processor.setOptions(noise, echo, agc); processing_->processor.setHighQuality(highQuality);
        processing_->processor.setSuppressionStrength(strength / 100.f);
    });
    played_.clear();
}
void VoiceDevices::removePeer(const QString& peer) { queues_.remove(peer); peerVolumes_.remove(peer); peerPan_.remove(peer); peerMuted_.remove(peer); }
void VoiceDevices::setPeerVolume(const QString& peer, float volume) { peerVolumes_[peer] = std::clamp(volume, 0.0f, 2.0f); }
void VoiceDevices::setPeerPan(const QString& peer, float pan) { peerPan_[peer] = std::clamp(pan, -1.0f, 1.0f); }
void VoiceDevices::setPeerMuted(const QString& peer, bool muted) { if (muted) peerMuted_.insert(peer); else peerMuted_.remove(peer); }
void VoiceDevices::enqueue(const QString& peer, const VoiceFrame& frame) {
    if (deafened_) return;
    auto& queue = queues_[peer];
    if (queue.size() >= 5) queue.pop_front(); // Bound to 100 ms; never accumulate seconds of latency.
    queue.push_back(frame);
}
void VoiceDevices::readMicrophone() {
    if (!reader_) return;
    try {
        captureBuffer_ += reader_->readAll();
        const auto frameBytes = inputFormat_.bytesForFrames(inputFormat_.sampleRate() / 50);
        if (captureBuffer_.size() > frameBytes * 5) {
            const auto sampleFrameBytes = inputFormat_.bytesPerFrame();
            const auto discard = ((captureBuffer_.size() - frameBytes) / sampleFrameBytes) * sampleFrameBytes;
            captureBuffer_.remove(0, discard); // Preserve interleaved PCM sample alignment.
            microphoneSamples_.clear(); resetProcessing(); played_.clear();
        }
        while (captureBuffer_.size() >= frameBytes) {
            const auto native = decodeMono(captureBuffer_.first(frameBytes), inputFormat_);
            captureBuffer_.remove(0, frameBytes);
            const auto converted = inputResampler_->process(native);
            microphoneSamples_.insert(microphoneSamples_.end(), converted.begin(), converted.end());
            while (microphoneSamples_.size() > VoiceSamples * 5) microphoneSamples_.pop_front();
            while (microphoneSamples_.size() >= VoiceSamples) {
                VoiceFrame frame{}, reference{};
                for (auto& sample : frame) {
                    sample = std::clamp(microphoneSamples_.front() * inputGain_, -1.f, 1.f);
                    microphoneSamples_.pop_front();
                }
                if (!played_.empty()) { reference = played_.front(); played_.pop_front(); }
                if (!muted_ && !deafened_) {
                    processMicrophone(frame, reference);
                }
            }
        }
    } catch (const std::exception&) { deviceError(deviceGeneration_); }
}
bool VoiceDevices::flushPlayback() {
    const auto written = writer_->write(pendingPlayback_);
    if (written < 0) throw std::runtime_error("Audio output failed");
    pendingPlayback_.remove(0, written);
    if (!pendingPlayback_.isEmpty()) return false;
    if (!muted_) {
        if (played_.size() >= 5) played_.pop_front();
        played_.push_back(pendingReference_);
    }
    return true;
}
// Hardware playback and tests consume the same queued PCM/mixer path.
void VoiceDevices::mixNextFrame(VoiceFrame& left, VoiceFrame* right) {
    left.fill(0.f); if (right) right->fill(0.f);
    if (deafened_) return;
    for (auto it = queues_.begin(); it != queues_.end(); ++it) {
        if (it->empty()) continue;
        const auto& frame = it->front();
        if (right) mixStereoVoiceFrame(left, *right, frame, peerVolumes_.value(it.key(), 1.f), peerPan_.value(it.key(), 0.f), peerMuted_.contains(it.key()));
        else mixVoiceFrame(left, frame, peerVolumes_.value(it.key(), 1.f), peerMuted_.contains(it.key()));
        it->pop_front();
    }
    applyMasterOutputGain(left, right, outputGain_);
}
void VoiceDevices::playMixedFrame() {
    if (!writer_ || !output_ || deafened_) return;
    try {
        if (!pendingPlayback_.isEmpty() && !flushPlayback()) return;
        const auto frameBytes = outputFormat_.bytesForFrames((outputFormat_.sampleRate() + 49) / 50);
        const int frames = playbackFramesNeeded(output_->bufferSize(), output_->bytesFree(), frameBytes);
        for (int n = 0; n < frames; ++n) {
            if (frameSource_) frameSource_();
            VoiceFrame mixed{}, right{};
            mixNextFrame(mixed, rightResampler_ ? &right : nullptr);
            pendingReference_ = mixed;
            if (rightResampler_) {
                for (int i = 0; i < VoiceSamples; ++i) {
                    right[i] = std::clamp(right[i], -1.f, 1.f);
                    pendingReference_[i] = (mixed[i] + right[i]) * .5f;
                }
                pendingPlayback_ = encodeStereo(outputResampler_->process(mixed), rightResampler_->process(right), outputFormat_);
            } else pendingPlayback_ = encodeMono(outputResampler_->process(mixed), outputFormat_);
            if (!pendingPlayback_.isEmpty() && !flushPlayback()) return;
        }
    } catch (const std::exception&) { deviceError(deviceGeneration_); }
}
}
