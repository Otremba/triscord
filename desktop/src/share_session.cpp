#include "share_session.h"
#include "share_picker.h"
#include <QJsonObject>

namespace triscord {

ShareSession::ShareSession(ScreenService* service, QWidget* window, QObject* parent) : QObject(parent), service_(service), window_(window) {
    // The picker is a modal drawn over the main window; it is shown through present().
    picker_ = new SharePicker(window);
    connect(picker_, &QDialog::finished, this, [this] { ++thumbnailGeneration_; service_->cancelThumbnails(); });
    connect(picker_, &SharePicker::startRequested, this, [this](int index, bool shareAudio, const VideoConfig& config) {
        if (index < 0 || index >= sources_.size()) return;
        sharedConfig_ = config; sharedSource_ = sources_[index]; sharedAudio_ = shareAudio;
        const auto& source = sources_[index];
        const bool monitor = source.kind == CaptureSource::Kind::Monitor;
        emit sharedSourceChanged(monitor ? QString("Tela") : source.name.mid(QStringLiteral("Janela — ").size()), SharePicker::sourceIcon(source));
        service_->start(source, shareAudio, config);
    });
    connect(service_, &ScreenService::thumbnailReady, this, [this](quint64 generation, int index, const QImage& image) {
        if (generation != thumbnailGeneration_ || !picker_->isVisible()) return;
        picker_->setThumbnail(index, image);
    });
    connect(service_, &ScreenService::roomChanged, this, [this](bool ready) {
        room_ = ready;
        if (!ready) disabledPeers_.clear();
        updateStart();
    });
    connect(service_, &ScreenService::sharingChanged, this, [this](bool sharing) {
        sharing_ = sharing;
        updateStart();
        if (!sharing) { emit streamFrameRemoved(QStringLiteral("$local")); emit sharedSourceChanged({}, {}); }
        publishStreams();
    });
    connect(service_, &ScreenService::streamsChanged, this, [this](const QJsonArray& values) { remoteStreams_ = values; publishStreams(); });
    connect(service_, &ScreenService::frameRemoved, this, &ShareSession::streamFrameRemoved);
    connect(service_, &ScreenService::frameReady, this, [this](const QString& id, const QImage& image) {
        if (!disabledPeers_.contains(id)) emit streamFrame(id, image);
    });
}

void ShareSession::chooseSource() {
    refreshSources();
    picker_->present(window_);
}

void ShareSession::setLocalName(const QString& name) {
    const QString shown = name.isEmpty() ? QStringLiteral("Sua Tela") : name;
    if (shown == localName_) return;
    localName_ = shown;
    publishStreams();
}

void ShareSession::setPeerVideoDisabled(const QString& peer, bool disabled) {
    if (peer == "$local") return;
    if (disabled) disabledPeers_.insert(peer); else disabledPeers_.remove(peer);
    service_->setVideoDisabled(peer, disabled);
    emit streamFrameRemoved(peer);
}

bool ShareSession::resumeShare(const CaptureSource& source, bool shareAudio, const VideoConfig& config) {
    const auto fresh = captureSources();
    const bool stillThere = std::any_of(fresh.cbegin(), fresh.cend(), [&](const CaptureSource& candidate) {
        return candidate.kind == source.kind && candidate.handle == source.handle && candidate.name == source.name;
    });
    if (!stillThere) return false;
    sharedConfig_ = config; sharedSource_ = source; sharedAudio_ = shareAudio;
    const bool monitor = source.kind == CaptureSource::Kind::Monitor;
    emit sharedSourceChanged(monitor ? QString("Tela") : source.name.mid(QStringLiteral("Janela — ").size()), SharePicker::sourceIcon(source));
    service_->start(source, shareAudio, config);
    return true;
}

void ShareSession::setViewedStream(const QString& streamId) {
    viewed_ = streamId;
    publishStreams();
}

void ShareSession::publishStreams() {
    QVector<StreamTile> tiles;
    if (sharing_) tiles.push_back({QStringLiteral("$local"), localName_, sharedConfig_.fps});
    for (const auto& value : remoteStreams_) {
        const auto object = value.toObject();
        tiles.push_back({object.value("id").toString(), object.value("name").toString(), 0});
    }
    // Without an explicit choice the first stream is the one looked at, as before the call grid existed.
    QString focus = viewed_;
    const bool known = std::any_of(tiles.cbegin(), tiles.cend(), [&](const StreamTile& tile) { return tile.id == focus; });
    if (!known) focus = tiles.isEmpty() ? QString() : tiles.first().id;
    service_->setFocus(focus);
    emit streamsChanged(tiles);
}

void ShareSession::refreshSources() {
    sources_ = captureSources();
    picker_->setSources(sources_);
    updateStart();
    if (!sharing_) service_->requestThumbnails(sources_, ++thumbnailGeneration_);
}

void ShareSession::updateStart() {
    picker_->setCanStart(room_ && !sharing_);
}

} // namespace triscord
