#include "sfu_transport.h"
#include <QCoreApplication>
#include <QFileInfo>
#include <QJsonDocument>
#include <cstdio>

namespace triscord {
namespace { QString executable() { return QCoreApplication::applicationDirPath() + "/triscord-media.exe"; } }
bool SfuTransport::available() { return QFileInfo::exists(executable()); }
SfuTransport::SfuTransport(QString kind, QObject* parent) : QObject(parent), kind_(std::move(kind)) {
    process_.setParent(this); retry_.setParent(this); retry_.setSingleShot(true); retry_.setInterval(5000);
    connect(&retry_, &QTimer::timeout, this, [this] {
        if (selected_) { emit credentialsNeeded(); retry_.start(10000); }
    });
    connect(&process_, &QProcess::readyReadStandardOutput, this, &SfuTransport::read);
    // SDK diagnostics can contain URLs/tokens. Drain but never forward or persist them.
    connect(&process_, &QProcess::readyReadStandardError, this, [this] { process_.readAllStandardError(); });
    connect(&process_, &QProcess::errorOccurred, this, [this] { failed(); });
    connect(&process_, &QProcess::finished, this, [this] { failed(); });
}
SfuTransport::~SfuTransport() { close(); }
void SfuTransport::close() {
    disconnect(startup_);
    selected_ = false; connected_ = false; retry_.stop(); input_.clear(); publication_ = {}; disabled_.clear(); audioTracks_.clear();
    if (process_.state() != QProcess::NotRunning) { process_.kill(); process_.waitForFinished(1000); }
}
void SfuTransport::open(const QJsonObject& credentials) {
    const auto publication = publication_; const auto disabled = disabled_;
    close(); publication_ = publication; disabled_ = disabled; selected_ = true;
    const QJsonObject hello{{"command", "connect"}, {"kind", kind_}, {"url", credentials.value("url")}, {"token", credentials.value("token")}};
    startup_ = connect(&process_, &QProcess::started, this, [this, hello] { disconnect(startup_); command(hello); });
    process_.setProgram(executable()); process_.setArguments({}); process_.start();
}
void SfuTransport::publish(int width, int height, int fps, int bitrate) {
    publication_ = {{"command", "publish"}, {"width", width}, {"height", height}, {"fps", fps}, {"bitrate", bitrate}};
    if (connected_) command(publication_);
}
void SfuTransport::unpublish() { publication_ = {}; if (connected_) command({{"command", "unpublish"}}); }
bool SfuTransport::command(const QJsonObject& value, bool media) {
    if (process_.state() != QProcess::Running || process_.bytesToWrite() > (media ? 512 * 1024 : 2 * 1024 * 1024)) return false;
    const auto line = QJsonDocument(value).toJson(QJsonDocument::Compact) + '\n';
    return process_.write(line) == line.size();
}
void SfuTransport::send(const QString& kind, const QByteArray& data, qint64 durationUs, quint32 timestamp) {
    if (!connected_ || publication_.isEmpty() || data.isEmpty() || data.size() > 8 * 1024 * 1024) return;
    if (!command({{"command", kind}, {"data", QString::fromLatin1(data.toBase64())}, {"duration", double(durationUs)}, {"timestamp", double(timestamp)}}, true)
        && kind == "video") emit keyframeRequested();
}
void SfuTransport::watch(const QString& peer, bool enabled) {
    if (enabled) disabled_.remove(peer); else disabled_.insert(peer);
    if (connected_) command({{"command", "subscription"}, {"peer", peer}, {"disabled", !enabled}});
}
void SfuTransport::requestKeyframe(const QString& peer) { if (connected_) command({{"command", "keyframe"}, {"peer", peer}}); }
void SfuTransport::failed() {
    connected_ = false;
    if (!selected_ || retry_.isActive()) return;
    std::printf("media: %s SFU transport needs reconnection\n", qPrintable(kind_)); std::fflush(stdout);
    emit message("Reconectando a mídia à VPS."); retry_.start();
}
void SfuTransport::read() {
    input_ += process_.readAllStandardOutput();
    if (input_.size() > 16 * 1024 * 1024) { process_.kill(); input_.clear(); failed(); return; }
    for (;;) {
        const auto end = input_.indexOf('\n'); if (end < 0) break;
        const auto value = QJsonDocument::fromJson(input_.left(end)).object(); input_.remove(0, end + 1);
        const auto event = value.value("event").toString(); const auto peer = value.value("peer").toString();
        if (event == "connected") {
            connected_ = true; retry_.stop();
            if (!publication_.isEmpty()) command(publication_);
            for (const auto& id : disabled_) watch(id, false);
            std::printf("media: %s connected to SFU\n", qPrintable(kind_)); std::fflush(stdout);
        } else if (event == "disconnected" || event == "error") failed();
        else if (event == "reconnecting") { connected_ = false; }
        else if (event == "keyframe") emit keyframeRequested();
        else if (event == "bitrate") emit bitrateRequested(value.value("bitrate").toInt());
        else if (!peer.isEmpty() && peer.size() <= 64 && (event == "audio" || event == "video")) {
            const auto data = QByteArray::fromBase64(value.value("data").toString().toLatin1());
            const auto stamp = quint32(value.value("timestamp").toDouble());
            if (event == "audio") {
                const auto track = value.value("track").toString();
                if (audioTracks_.value(peer) != track) { audioTracks_.insert(peer, track); emit audioReset(peer); }
                emit audio(peer, data, stamp);
            }
            else emit video(peer, data, stamp, value.value("key").toBool(), value);
        }
    }
}
}
