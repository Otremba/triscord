#pragma once
#include "capture_types.h"
#include "participant_pane.h"
#include "screen_service.h"
#include <QJsonArray>
#include <QObject>
#include <QPixmap>
#include <QSet>
#include <QVector>

namespace triscord {

class SharePicker;

// Everything about screen sharing that is not drawing: the source picker, the user's own share and the
// streams of other participants. Streams and their frames are published to the call grid (ParticipantPane),
// where Discord shows them as tiles (desktop/out/claude-observations/SHARE.md).
class ShareSession final : public QObject {
    Q_OBJECT
public:
    ShareSession(ScreenService* service, QWidget* window, QObject* parent = nullptr);
    void chooseSource();
    void setLocalName(const QString& name);
    void setPeerVideoDisabled(const QString& peer, bool disabled);
    // The stream being looked at (empty for none). The service sends it the higher-quality layer.
    void setViewedStream(const QString& streamId);
    // State of the current share, so a caller (the reconnect path) can remember it across a signaling drop.
    bool isSharing() const { return sharing_; }
    CaptureSource sharedSource() const { return sharedSource_; }
    bool sharedAudio() const { return sharedAudio_; }
    VideoConfig sharedConfig() const { return sharedConfig_; }
    // Re-starts a share after an automatic reconnect, exactly like chooseSource()+startRequested would, but
    // only if a source matching the remembered one (kind, handle and name) still exists; otherwise it is a
    // no-op and ScreenCall's own start() failure path is never reached, so nothing is silently shared.
    bool resumeShare(const CaptureSource& source, bool shareAudio, const VideoConfig& config);
signals:
    void streamsChanged(const QVector<triscord::StreamTile>& streams);
    void streamFrame(const QString& streamId, const QImage& image);
    void streamFrameRemoved(const QString& streamId);
    // Title and icon of the source being shared (empty when not sharing), for the voice panel.
    void sharedSourceChanged(const QString& title, const QPixmap& icon);
private:
    void publishStreams();
    void refreshSources();
    void updateStart();

    ScreenService* service_;
    QWidget* window_;
    SharePicker* picker_ = nullptr;
    QVector<CaptureSource> sources_;
    QJsonArray remoteStreams_;
    QSet<QString> disabledPeers_;
    QString localName_ = QStringLiteral("Sua Tela");
    QString viewed_;
    VideoConfig sharedConfig_;
    CaptureSource sharedSource_;
    bool sharedAudio_ = false;
    quint64 thumbnailGeneration_ = 0;
    bool room_ = false;
    bool sharing_ = false;
};

} // namespace triscord
