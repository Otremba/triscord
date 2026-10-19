#include "screen_audio.h"
#include "voice_mix.h"
#include <QMediaDevices>
#include <algorithm>
namespace triscord {
ScreenAudio::ScreenAudio(QObject* parent) : QObject(parent) {
    timer_.setParent(this); timer_.setInterval(20); timer_.setTimerType(Qt::PreciseTimer);
    connect(&timer_, &QTimer::timeout, this, &ScreenAudio::tick);
    connect(&capture_, &SystemAudio::captured, this, &ScreenAudio::captured);
    connect(&capture_, &SystemAudio::error, this, &ScreenAudio::error);
}
void ScreenAudio::clear() { stopCapture(); peers_.clear(); volumes_.clear(); muted_.clear(); closeOutput(); outputFailed_ = false; outputFailureNotified_ = false; outputRetry_.invalidate(); }
void ScreenAudio::setPeerVolume(const QString& peer, float volume) { if (std::isfinite(volume)) volumes_[peer] = std::clamp(volume, 0.f, 2.f); }
void ScreenAudio::setPeerMuted(const QString& peer, bool muted) { if (muted) muted_.insert(peer); else muted_.remove(peer); }
void ScreenAudio::remove(const QString& peer) { peers_.erase(peer); if (peers_.empty()) { closeOutput(); outputFailed_ = false; } }
void ScreenAudio::closeOutput() {
    timer_.stop(); if (sink_) sink_->stop(); sink_.reset(); writer_ = nullptr; pending_.clear(); resampler_.reset();
}
void ScreenAudio::failOutput(const QString& message) {
    outputFailed_ = true; peers_.clear(); closeOutput(); outputRetry_.start();
    if (!outputFailureNotified_) { outputFailureNotified_ = true; emit error(message); }
}
void ScreenAudio::setOutput(const QByteArray& device) {
    if (output_ == device && !outputFailed_) return;
    output_ = device; outputFailed_ = false; closeOutput();
}
void ScreenAudio::setDeafened(bool deafened) { deafened_ = deafened; peers_.clear(); closeOutput(); outputFailed_ = false; }
bool ScreenAudio::openOutput() {
    if (writer_) return true;
    auto device = QMediaDevices::defaultAudioOutput();
    if (!output_.isEmpty()) { device = {}; for (const auto& candidate : QMediaDevices::audioOutputs()) if (candidate.id() == output_) { device = candidate; break; } }
    if (device.isNull()) return false;
    format_ = device.preferredFormat();
    try { resampler_ = std::make_unique<VoiceResampler>(VoiceRate, format_.sampleRate()); }
    catch (const std::exception&) { return false; }
    sink_ = std::make_unique<QAudioSink>(device, format_); sink_->setBufferSize(format_.bytesForDuration(60000));
    writer_ = sink_->start();
    const bool ready = writer_ && sink_->error() == QtAudio::NoError;
    if (ready) outputFailureNotified_ = false;
    return ready;
}
void ScreenAudio::receive(const QString& peer, const QByteArray& packet, uint32_t timestamp) {
    if (deafened_ || peer.isEmpty() || packet.isEmpty() || packet.size() > 1275) return;
    if (outputFailed_) {
        if (outputRetry_.isValid() && outputRetry_.elapsed() < 2000) return;
        outputFailed_ = false;
    }
    if (!peers_.contains(peer)) {
        if (peers_.size() >= 9) return;
        peers_[peer] = std::make_unique<VoiceJitter>();
    }
    peers_.at(peer)->push(timestamp, packet); if (!timer_.isActive()) timer_.start();
}
void ScreenAudio::tick() {
    // An empty playback buffer can resume on the next write; it is not a
    // disconnected device and must not trigger a two-second recovery pause.
    if (sink_ && sink_->error() != QtAudio::NoError && sink_->error() != QtAudio::UnderrunError) {
        failOutput("a saída de áudio da tela parou. tentando reconectar o dispositivo."); return;
    }
    auto flush = [this] {
        if (pending_.isEmpty()) return true;
        const auto written = writer_->write(pending_);
        if (written < 0) {
            failOutput("a saída de áudio da tela parou. tentando reconectar o dispositivo."); return false;
        }
        pending_.remove(0, written);
        return pending_.isEmpty();
    };
    int frames = 1; // Injected mode decodes without opening hardware.
    if (playback_) {
        if (peers_.empty() && pending_.isEmpty()) return;
        if (!openOutput()) { failOutput("não foi possível reproduzir o áudio da tela. tentando reconectar a saída de áudio."); return; }
        if (!flush()) return;
        const auto frameBytes = format_.bytesForFrames((format_.sampleRate() + 49) / 50);
        frames = playbackFramesNeeded(sink_->bufferSize(), sink_->bytesFree(), frameBytes);
    }
    // Consume RTP only when the output can retain the resulting PCM. Refill
    // after a delayed tick instead of permanently losing device-buffer headroom.
    for (int n = 0; n < frames; ++n) {
    VoiceFrame mixed{}; bool received = false;
    for (auto& [id, jitter] : peers_) {
        try { if (const auto frame = jitter->pop()) {
            received = true; const float factor = ducking_ ? std::max(0.05f, 1.0f - duckAmount_) : 1.0f;
            VoiceFrame adjusted{};
            const auto volume = volumes_.find(id);
            mixVoiceFrame(adjusted, *frame, std::min(2.f, (volume == volumes_.end() ? 1.f : volume->second) * factor * outputGain_), muted_.contains(id));
            for (int i = 0; i < VoiceSamples; ++i) mixed[i] += adjusted[i];
            emit decoded(id, adjusted);
        } } catch (const std::exception&) { /* Malformed packets never stop other streams. */ }
    }
    if (!playback_ || !received) return;
    for (auto& sample : mixed) sample = std::clamp(sample, -1.f, 1.f);
    try { pending_ = encodeMono(resampler_->process(mixed), format_); }
    catch (const std::exception&) { failOutput("não foi possível reproduzir o áudio da tela. tentando novamente."); return; }
    if (!flush()) return;
    }
}
}
