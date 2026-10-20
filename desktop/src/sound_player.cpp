#include "sound_player.h"
#include <QAudioSink>
#include <QAudioBufferOutput>
#include <QAudioBuffer>
#include <QAudioDevice>
#include <QMediaDevices>
#include <QMediaPlayer>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QSaveFile>
#include <QStandardPaths>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSettings>
#include <QUrl>
#include <algorithm>
#include <cmath>
#include <functional>
#include <QElapsedTimer>
#include <QDebug>
static void initializeWebSounds() { static const bool once = [] { Q_INIT_RESOURCE(soundboard); return true; }(); Q_UNUSED(once); }
namespace triscord {
// An explicit PCM layout avoids Qt/FFmpeg interpreting a headset's unspecified Windows
// channel mask as an empty output layout. Decode and hardware output remain separate.
class SoundOutput final : public QObject {
public:
    static QAudioFormat format() {
        QAudioFormat f; f.setSampleRate(48000); f.setChannelConfig(QAudioFormat::ChannelConfigStereo);
        f.setSampleFormat(QAudioFormat::Float); return f;
    }
    SoundOutput(QObject* parent, std::function<void()> failure) : QObject(parent), failure_(std::move(failure)) {
        timer_.setInterval(10); connect(&timer_, &QTimer::timeout, this, [this] { flush(); });
    }
    ~SoundOutput() override { reset(); }
    void reset() {
        timer_.stop(); pending_.clear(); finished_ = {}; writer_ = nullptr; submitted_ = 0;
        if (sink_) sink_->reset();
    }
    void setDevice(const QAudioDevice& device) {
        if (device_.id() == device.id()) return;
        reset(); delete sink_; sink_ = nullptr; device_ = device;
    }
    void setVolume(float volume) { volume_ = volume; if (sink_) sink_->setVolume(volume); }
    void append(const QAudioBuffer& buffer) {
        if (!buffer.isValid() || !buffer.byteCount()) return;
        if (!sink_) {
            if (device_.isNull()) { fail("no output device"); return; }
            if (!device_.isFormatSupported(format())) { fail("unsupported PCM format"); return; }
            sink_ = new QAudioSink(device_, format(), this); sink_->setBufferSize(format().bytesForDuration(80000));
            sink_->setVolume(volume_);
        }
        if (!writer_) writer_ = sink_->start();
        if (!writer_) { fail("output did not start"); return; }
        if (sink_->error() != QtAudio::NoError && sink_->error() != QtAudio::UnderrunError) { fail("audio sink error"); return; }
        if (pending_.size() + buffer.byteCount() > 4194304) { fail("PCM queue overflow"); return; }
        pending_.append(buffer.constData<char>(), buffer.byteCount()); timer_.start(); flush();
    }
    void finish(std::function<void()> callback) { finished_ = std::move(callback); drain_.start(); timer_.start(); }
private:
    void fail(const char* reason) {
        qWarning().noquote() << "sound: output failed:" << reason
            << "error" << (sink_ ? int(sink_->error()) : -1)
            << "state" << (sink_ ? int(sink_->state()) : -1);
        reset(); failure_();
    }
    void flush() {
        if (sink_ && sink_->error() != QtAudio::NoError && sink_->error() != QtAudio::UnderrunError) { fail("audio sink error"); return; }
        if (writer_ && !pending_.isEmpty()) {
            const auto n = writer_->write(pending_.constData(), std::min<qint64>(pending_.size(), sink_->bytesFree()));
            if (n < 0) { fail("PCM write failed"); return; } pending_.remove(0, n); submitted_ += n;
        }
        const bool drained = !sink_ || (sink_->state() == QtAudio::IdleState &&
            sink_->processedUSecs() + 2500 >= format().durationForBytes(submitted_));
        if (finished_ && pending_.isEmpty() && (drained || drain_.elapsed() > 2000)) {
            auto callback = std::move(finished_); finished_ = {}; timer_.stop(); callback();
        }
    }
    QAudioDevice device_;
    QAudioSink* sink_ = nullptr;
    QIODevice* writer_ = nullptr;
    QTimer timer_;
    QByteArray pending_;
    float volume_ = .7f;
    qint64 submitted_ = 0;
    QElapsedTimer drain_;
    std::function<void()> failure_, finished_;
};
SoundPlayer::SoundPlayer(QObject* parent) : QObject(parent) {
    initializeWebSounds(); deadline_.setSingleShot(true);
    connect(&deadline_, &QTimer::timeout, this, &SoundPlayer::stop);
}
SoundPlayer::~SoundPlayer() {
    // Qt's buffer output keeps a player back-reference: detach before QObject child destruction.
    if (player_) player_->setAudioBufferOutput(nullptr);
    for (const auto& [id, cue] : cues_) {
        cue->active = false;
        if (cue->player) {
            disconnect(cue->player, nullptr, this, nullptr);
            cue->player->setAudioBufferOutput(nullptr);
            cue->player->stop();
            delete cue->player;
            cue->player = nullptr;
        }
        delete cue->output;
        cue->output = nullptr;
    }
}
QMediaPlayer* SoundPlayer::createPlayer(SoundOutput*& output, CuePlayback* cue) {
    auto* player = new QMediaPlayer(this);
    if (qEnvironmentVariable("TRISCORD_AUDIO_MODE") != "injected") {
        output = new SoundOutput(this, [this, player, cue] {
            player->stop();
            if (cue) cue->active = false; else stop();
            emit failed("Não foi possível enviar o som ao alto-falante. Confira a saída nas configurações.");
        });
    }
    if (output || qEnvironmentVariableIsSet("TRISCORD_TEST_DECODE_AUDIO")) {
        auto* buffers = new QAudioBufferOutput(SoundOutput::format(), player);
        player->setAudioBufferOutput(buffers);
        if (output) connect(buffers, &QAudioBufferOutput::audioBufferReceived, output, [output](const QAudioBuffer& buffer) { output->append(buffer); });
        connect(buffers, &QAudioBufferOutput::audioBufferReceived, this, [this, cue](const QAudioBuffer& buffer) {
            auto& reported = cue ? cue->decoded : boardDecoded_;
            const auto id = cue ? (cue->active ? cue->id : QString{}) : playing_;
            if (!qEnvironmentVariableIsSet("TRISCORD_TEST_DECODE_AUDIO") || reported || id.isEmpty() || !buffer.isValid()) return;
            double peak = 0;
            for (int i = 0; i < buffer.sampleCount(); ++i) {
                double value = 0;
                switch (buffer.format().sampleFormat()) {
                case QAudioFormat::Float: value = buffer.constData<float>()[i]; break;
                case QAudioFormat::Int16: value = buffer.constData<qint16>()[i] / 32768.; break;
                case QAudioFormat::Int32: value = buffer.constData<qint32>()[i] / 2147483648.; break;
                case QAudioFormat::UInt8: value = (buffer.constData<quint8>()[i] - 128) / 128.; break;
                default: break;
                }
                peak = std::max(peak, std::abs(value));
            }
            if (peak > 0) { reported = true; emit decoded(cue ? "cue" : "soundboard", id, buffer.sampleCount(), peak); }
        });
    }
    connect(player, &QMediaPlayer::errorOccurred, this, [this, cue] {
        if (cue) { cue->active = false; cue->player->stop(); if (cue->output) cue->output->reset(); }
        else { stop(); emit failed("Não foi possível reproduzir esse som. Confira a saída de áudio nas configurações."); }
    });
    connect(player, &QMediaPlayer::mediaStatusChanged, this, [this, player, cue](QMediaPlayer::MediaStatus status) {
        if (status == QMediaPlayer::LoadedMedia) player->setActiveVideoTrack(-1);
        if (status == QMediaPlayer::EndOfMedia) {
            auto* output = cue ? cue->output : output_;
            const auto generation = cue ? cue->generation : 0;
            auto done = [this, cue, generation] {
                if (cue) {
                    if (cue->generation != generation) return;
                    cue->active = false;
                    if (cue->output) cue->output->reset();
                } else stop();
            };
            if (output) output->finish(done); else done();
        }
    });
    return player;
}
void SoundPlayer::playCue(const QString& id) {
    const bool feedback = id == "mute" || id == "unmute" || id == "deafen" || id == "undeafen";
    if (!QSettings().value("callSounds", true).toBool()) return;
    if (id != "join" && id != "leave" && id != "disconnect" && !feedback && id != "camera_on" && id != "camera_off" && id != "stream_started" && id != "stream_ended") return;
    if (qEnvironmentVariable("TRISCORD_AUDIO_MODE") == "injected" && !qEnvironmentVariableIsSet("TRISCORD_TEST_DECODE_AUDIO")) return;
    auto& entry = cues_[id];
    if (!entry) {
        entry = std::make_unique<CuePlayback>();
        entry->id = id;
        entry->player = createPlayer(entry->output, entry.get());
    }
    auto& cue = *entry;
    ++cue.generation;
    cue.active = false;
    cue.player->stop(); if (cue.output) cue.output->reset(); cue.decoded = false;
    setOutput(device_); refreshSettings();
    if (cue.player->source().isEmpty()) cue.player->setSource(QUrl("qrc:/call-sounds/" + id + ".mp3"));
    cue.active = true;
    cue.player->play();
}
void SoundPlayer::refreshSettings() {
    const auto volume = qBound(0, QSettings().value("soundboardVolume", 70).toInt(), 100) / 100.f;
    if (output_) output_->setVolume(volume);
    // Discord useSound -> Ak(sound, .4), independent of soundboard volume.
    const auto cueVolume = qBound(0.f, QSettings().value("audioOutputVolume", 100).toFloat() / 100.f * .4f, 1.f);
    const bool enabled = QSettings().value("callSounds", true).toBool();
    for (const auto& [id, cue] : cues_) {
        if (cue->output) cue->output->setVolume(cueVolume);
        if (!enabled) {
            ++cue->generation; cue->active = false;
            cue->player->stop();
            if (cue->output) cue->output->reset();
        }
    }
}
QJsonArray SoundPlayer::catalog() {
    initializeWebSounds();
    static const QJsonArray entries = [] { QFile f(":/soundboard/catalog.json");
        return f.open(QIODevice::ReadOnly) ? QJsonDocument::fromJson(f.readAll()).array() : QJsonArray{}; }();
    return entries;
}
bool SoundPlayer::contains(const QString& id) {
    const auto list = catalog();
    return std::any_of(list.begin(), list.end(), [&](const QJsonValue& v) { return v.toObject().value("id").toString() == id; });
}
void SoundPlayer::play(const QString& id, bool preview) {
    if (deafened_ || !contains(id)) return;
    stop();
    QFile source(":/soundboard/" + id + ".mp3");
    if (!source.open(QIODevice::ReadOnly)) { emit failed("Esse som não está disponível nesta instalação."); return; }
    QByteArray bytes = source.readAll();
    if (bytes.isEmpty() || bytes.size() > 1048576 || QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex() != id.toLatin1()) {
        emit failed("Esse som está danificado. Atualize o Triscord."); return;
    }
    // Same ID3 removal as the Widget soundboard: avoid decoding attached cover art.
    if (bytes.size() >= 10 && bytes.startsWith("ID3")) {
        qsizetype size = 0; bool valid = true;
        for (int i = 6; i < 10; ++i) { const auto b = static_cast<unsigned char>(bytes[i]); if (b & 128) valid = false; size = (size << 7) | (b & 127); }
        size += 10; if (bytes[3] == 4 && (static_cast<unsigned char>(bytes[5]) & 16)) size += 10;
        if (valid && size < bytes.size()) bytes = bytes.mid(size);
    }
    // Injected audio mode exercises routing/state in E2E without speakers.
    if (qEnvironmentVariable("TRISCORD_AUDIO_MODE") != "injected" || qEnvironmentVariableIsSet("TRISCORD_TEST_DECODE_AUDIO")) {
        const auto testCache = qEnvironmentVariable("TRISCORD_TEST_SOUND_CACHE");
        const auto folder = qEnvironmentVariable("TRISCORD_AUDIO_MODE") == "injected" && !testCache.isEmpty()
            ? testCache : QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/soundboard";
        if (!QDir().mkpath(folder)) { emit failed("Não foi possível abrir esse som."); return; }
        const auto path = folder + "/" + id + ".mp3";
        QFile cached(path); const bool same = cached.open(QIODevice::ReadOnly) && cached.readAll() == bytes; cached.close();
        if (!same) {
            QSaveFile file(path);
            const bool saved = file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit();
            // Another running client can populate this shared cache first and hold it open for playback
            // (Windows then refuses replacement). Its identical, fully committed file is safe to reuse.
            QFile concurrent(path);
            if (!saved && !(concurrent.open(QIODevice::ReadOnly) && concurrent.readAll() == bytes)) {
                emit failed("Não foi possível abrir esse som."); return;
            }
        }
        if (!player_) player_ = createPlayer(output_);
        setOutput(device_);
        refreshSettings();
        playing_ = id; boardDecoded_ = false;
        player_->setSource(QUrl::fromLocalFile(path)); player_->play();
    }
    playing_ = id; preview_ = preview; emit changed(id); deadline_.start(10500);
}
void SoundPlayer::stop() {
    deadline_.stop(); preview_ = false;
    if (player_) { player_->stop(); player_->setSource({}); }
    if (output_) output_->reset();
    if (!playing_.isEmpty()) { playing_.clear(); emit changed({}); }
}
void SoundPlayer::stopPreview() { if (preview_) stop(); }
void SoundPlayer::setDeafened(bool muted) { deafened_ = muted; if (muted) stop(); }
void SoundPlayer::setOutput(const QByteArray& id) {
    device_ = id;
    auto device = QMediaDevices::defaultAudioOutput();
    for (const auto& d : QMediaDevices::audioOutputs()) if (d.id() == id) { device = d; break; }
    if (output_) output_->setDevice(device);
    const auto notificationDevice = QMediaDevices::defaultAudioOutput();
    for (const auto& [cueId, cue] : cues_) if (cue->output) cue->output->setDevice(notificationDevice);
}
}
