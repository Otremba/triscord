#pragma once
#include <QHash>
#include <QImage>
#include <QObject>
#include <QRect>
#include <QString>
#include <QVector>

class QWindow;

namespace triscord {

class VideoOverlayWindow;

// Video path A (desktop/ARQUITETURA_WEBVIEW2.md, measured 2.8% CPU at 1080p30 vs 31-37% for shared
// buffers): one native child window per stream, placed exactly over the tile rectangle the web interface
// reports (videoSurface), drawing the latest frame with QPainter. The web tile stays empty underneath.
// A window is shown only when both a frame and a non-empty rectangle exist.
class VideoOverlays final : public QObject {
    Q_OBJECT
public:
    explicit VideoOverlays(QWindow* parent);
signals:
    void escapePressed();
    void pointerActivity();
    // Right click on a video window (released, as Chromium opens context menus on Windows): the page under it
    // cannot see the click, so the host forwards it and the page opens the participant menu there.
    void contextMenuRequested(const QString& streamId, const QPoint& point);
    // Left click on a video window (the page cannot see it): the page focuses that card (visão ampliada) or goes back.
    void clicked(const QString& streamId);
public:
    ~VideoOverlays() override;
    void setFrame(const QString& streamId, const QImage& image);
    void setSurface(const QString& streamId, const QRect& rect, double scale);
    void remove(const QString& streamId);
    // Name pill drawn by the native window itself (the web pill would sit under it): bottom-left, 12px
    // inset, 32px high, radius 8, black at 60%, white 16px medium text — the participant card's values.
    void setLabel(const QString& streamId, const QString& label);
    // Screen share card badges (SHARE.md, observed; same drawing as the Qt client's ParticipantPane): a red "AO VIVO"
    // 8px from the top-right corner and, while hovered, the quality before it ("720P 30FPS": the frame height, and the
    // frame rate only when known, i.e. our own share). `fps` 0 = unknown; `height` > 0 replaces the frame height (our own
    // share: its local preview is reduced, the configured resolution is what the others get).
    void setLive(const QString& streamId, bool live, int fps, int height = 0);
    QString badgeText(const QString& streamId, bool hovered) const;   // diagnostics / tests: what the badges show
    // Where the card is shown (visão ampliada, SHARE.md / Qt ParticipantPane): "grid" (badges, hover quality),
    // "stage" (the focused card: name pill only, the header carries the pills) or "film" (filmstrip thumbnail:
    // 28px name pill, "AO VIVO" without the quality, the screen glyph centred over a stream).
    void setRole(const QString& streamId, const QString& role);
    void setIdle(bool idle);   // idle call view: no name pill (Discord shows only the badges and icons then)
    QString role(const QString& streamId) const;
    bool hovered(const QString& streamId) const;
    // Page layers floating over the video (an open menu), in parent-window CSS px: each video window cuts them out of
    // its mask, so the page shows there and the video stays visible around it (Discord keeps the video under menus).
    void setOccluders(const QVector<QRect>& rects);
    // Cut out of the "stage" window only: the filmstrip floats over the bottom of the focused card's area (observed),
    // and the stage's letterbox would otherwise paint over the thumbnails.
    void setStageOccluders(const QVector<QRect>& rects);
    int paintedFrames(const QString& streamId) const;   // diagnostics / tests
    QStringList occludedStreams() const;                // visible windows with a cut-out
    QStringList visibleStreams() const;
    QHash<QString, QPair<QRect, QImage>> snapshots() const;   // visible windows: rect + rendered image

private:
    VideoOverlayWindow* windowFor(const QString& streamId);
    QWindow* parent_;
    QHash<QString, VideoOverlayWindow*> windows_;
    QVector<QRect> occluders_, stageOccluders_;
    bool idle_ = false;
};

} // namespace triscord
