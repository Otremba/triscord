#include "video_overlays.h"

#include <QPainter>
#include <QPainterPath>
#include <QRasterWindow>
#include <QRegion>
#include <QKeyEvent>
#include <QMouseEvent>
#include "discord_icons.h"
#include <QElapsedTimer>
#include <QFontMetricsF>
#include <cmath>
#include <functional>

namespace triscord {

class VideoOverlayWindow final : public QRasterWindow {
public:
    explicit VideoOverlayWindow(QWindow* parent) : QRasterWindow(parent) { activity_.start(); }
    std::function<void()> onEscape;
    std::function<void()> onPointerActivity;
    std::function<void(const QPoint&)> onContextMenu;   // point in the parent window
    std::function<void()> onClick;
    void setRole(const QString& role) { role_ = role; applyMask(); refreshVisibility(); update(); }
    void setIdle(bool idle) { if (idle_ != idle) { idle_ = idle; update(); } }
    bool idle() const { return idle_; }
    QString role() const { return role_; }
    void setFrame(const QImage& image) { frame_ = image; refreshVisibility(); update(); }
    void setLabel(const QString& label) { label_ = label; update(); }
    void setLive(bool live, int fps, int height) { live_ = live; fps_ = fps; height_ = height; update(); }
    QString quality() const {
        if (frame_.isNull()) return {};
        return QString::number(height_ > 0 ? height_ : frame_.height()) + "P" + (fps_ > 0 ? QString(" %1FPS").arg(fps_) : QString());
    }
    bool hovered() const { return hovered_; }
    QString badges(bool hovered) const { return !live_ ? QString() : hovered && !quality().isEmpty() ? quality() + " | AO VIVO" : QStringLiteral("AO VIVO"); }
    void setSurface(const QRect& rect) {
        surface_ = rect;
        if (rect.isValid() && !rect.isEmpty()) setGeometry(rect);
        applyMask();
        refreshVisibility();
    }
    void setOccluders(const QVector<QRect>& rects) { occluders_ = rects; applyMask(); refreshVisibility(); }
    void setStageOccluders(const QVector<QRect>& rects) { stageOccluders_ = rects; applyMask(); refreshVisibility(); }
    bool occluded() const { return occluded_; }
    int painted = 0;

    // Same drawing as on screen, into an image (diagnostics and tests).
    QImage snapshot() const {
        QImage image(size(), QImage::Format_ARGB32_Premultiplied);
        QPainter painter(&image);
        draw(painter);
        return image;
    }
    QRect surface() const { return surface_; }

protected:
    bool event(QEvent* event) override {
        if ((event->type() == QEvent::MouseMove || event->type() == QEvent::MouseButtonPress) && onPointerActivity && activity_.elapsed() >= 80) {
            activity_.restart(); onPointerActivity();
        }
        if (event->type() == QEvent::MouseButtonRelease && static_cast<QMouseEvent*>(event)->button() == Qt::LeftButton && onClick) {
            const auto point = static_cast<QMouseEvent*>(event)->position().toPoint();
            if (live_ && role_ == QLatin1String("grid") && hovered_ && !idle_ && QRect(width()-44,height()-44,32,32).contains(point) && onContextMenu)
                onContextMenu(geometry().topLeft()+point);
            else onClick();
            event->accept(); return true;
        }
        if (event->type() == QEvent::MouseButtonRelease && static_cast<QMouseEvent*>(event)->button() == Qt::RightButton && onContextMenu) {
            onContextMenu(geometry().topLeft() + static_cast<QMouseEvent*>(event)->position().toPoint());
            event->accept(); return true;
        }
        // Hover: Enter/Leave, and any move over the window (an Enter can be missed when the window appears under a
        // still cursor).
        if ((event->type() == QEvent::Enter || event->type() == QEvent::MouseMove) && !hovered_) { hovered_ = true; update(); }
        if (event->type() == QEvent::Leave && hovered_) { hovered_ = false; update(); }
        if (event->type() == QEvent::KeyPress && static_cast<QKeyEvent*>(event)->key() == Qt::Key_Escape && onEscape) {
            onEscape(); event->accept(); return true;
        }
        return QRasterWindow::event(event);
    }
    void paintEvent(QPaintEvent*) override {
        QPainter painter(this);
        draw(painter);
        ++painted;
    }

private:
    void draw(QPainter& painter) const {
        painter.fillRect(QRect(QPoint(), size()), Qt::black);
        if (frame_.isNull()) return;
        // Whole frame, aspect preserved (letterboxed), so nothing of a shared screen is cut off.
        const auto target = QRect(QPoint(), frame_.size().scaled(size(), Qt::KeepAspectRatio));
        painter.drawImage(target.translated((width() - target.width()) / 2, (height() - target.height()) / 2), frame_);
        const bool film = role_ == QLatin1String("film");
        if (film && live_)   // observed filmstrip thumbnail: the screen glyph centred over the picture
            DiscordIcons::paint(&painter, DiscordIcons::IconType::ScreenShare, QRectF(width() / 2.0 - 14, height() / 2.0 - 14, 28, 28), Qt::white);
        if (!label_.isEmpty() && (!idle_ || film)) {
            painter.setRenderHint(QPainter::Antialiasing);
            QFont font = painter.font();
            font.setFamilies({"gg sans", "Noto Sans", "Segoe UI"});
            font.setPixelSize(film ? 14 : 16);
            font.setWeight(QFont::Medium);
            painter.setFont(font);
            const int iconSpace = live_ ? 20 : 0;
            const auto text = QFontMetrics(font).elidedText(label_, Qt::ElideRight, std::max(0, width()-24-16-iconSpace-(live_ && !film ? 40 : 0)));
            const int textWidth = QFontMetrics(font).horizontalAdvance(text);
            const int pillHeight = film ? 28 : 32;
            const QRectF pill(12, height() - 12 - pillHeight, textWidth + 16 + iconSpace, pillHeight);
            QPainterPath path; path.addRoundedRect(pill, 8, 8);
            painter.fillPath(path, QColor(0, 0, 0, 153));
            painter.setPen(Qt::white);
            if (live_) DiscordIcons::paint(&painter, DiscordIcons::IconType::ScreenShare, QRectF(pill.left()+8,pill.center().y()-8,16,16), Qt::white);
            painter.drawText(pill.adjusted(8+iconSpace,0,-8,0), Qt::AlignVCenter | Qt::AlignLeft, text);
        }
        if (live_ && role_ != QLatin1String("stage")) {
            painter.setRenderHint(QPainter::Antialiasing);
            drawBadges(painter, width()-8, hovered_ && !film ? quality() : QString());
        }
        if (live_ && role_ == QLatin1String("grid") && hovered_ && !idle_) {
            const QRectF rect(width()-44,height()-44,32,32);
            QPainterPath path; path.addRoundedRect(rect,8,8); painter.fillPath(path,QColor(0,0,0,153));
            DiscordIcons::paint(&painter,DiscordIcons::IconType::MoreHorizontal,rect.adjusted(6,6,-6,-6),Qt::white);
        }
    }

    // Same 8px radius as the web tile (CALLS.md): the mask clips the native window's corners, minus the page layers
    // floating over it. Qt treats an empty mask as "no mask", so a window covered entirely is hidden instead.
    void applyMask() {
        covered_ = occluded_ = false;
        if (!surface_.isValid() || surface_.isEmpty()) return;
        QPainterPath path;
        path.addRoundedRect(QRectF(0, 0, surface_.width(), surface_.height()), 8, 8);
        QRegion region(path.toFillPolygon().toPolygon());
        auto rects = occluders_;
        if (role_ == QLatin1String("stage")) rects += stageOccluders_;
        for (const auto& rect : std::as_const(rects)) {
            if (!rect.intersects(surface_)) continue;
            occluded_ = true;
            region -= QRegion(rect.translated(-surface_.topLeft()));
        }
        covered_ = region.isEmpty();
        if (!covered_) setMask(region);
    }

    // Discord modules 872363 -> 812993 -> 85463: eyebrow 12/700, .02em, 16px line,
    // padding 6px. ROUND_LEFT/ROUND_RIGHT share one edge; radius token 16px clamps to 8.
    static void drawBadges(QPainter& painter, int right, const QString& quality) {
        QFont font = painter.font();
        font.setFamilies({"gg sans", "Noto Sans", "Segoe UI"});
        font.setPixelSize(12);
        font.setWeight(QFont::Bold);
        font.setLetterSpacing(QFont::AbsoluteSpacing,.24);
        const QString live = QStringLiteral("AO VIVO");
        const int liveWidth = int(std::ceil(QFontMetricsF(font).horizontalAdvance(live)))+12;
        const int qualityWidth = quality.isEmpty() ? 0 : int(std::ceil(QFontMetricsF(font).horizontalAdvance(quality)))+12;
        const QRectF whole(right-liveWidth-qualityWidth,8,liveWidth+qualityWidth,16);
        QPainterPath path; path.addRoundedRect(whole,8,8);
        painter.save(); painter.setClipPath(path);
        painter.fillRect(whole,QColor("#4e5058"));
        painter.fillRect(QRectF(right-liveWidth,8,liveWidth,16),QColor("#d22d39"));
        painter.restore();
        painter.setFont(font); painter.setPen(Qt::white);
        if (qualityWidth) painter.drawText(QRectF(whole.left(),8,qualityWidth,16),Qt::AlignCenter,quality);
        painter.drawText(QRectF(right-liveWidth,8,liveWidth,16),Qt::AlignCenter,live);
    }

    void refreshVisibility() {
        const bool wanted = !frame_.isNull() && surface_.isValid() && !surface_.isEmpty() && !covered_;
        if (wanted && !isVisible()) { show(); raise(); }
        if (!wanted && isVisible()) hide();
    }
    QImage frame_;
    QRect surface_;
    QVector<QRect> occluders_, stageOccluders_;
    bool covered_ = false, occluded_ = false;
    QString label_;
    bool live_ = false, hovered_ = false, idle_ = false;
    QString role_ = QStringLiteral("grid");
    int fps_ = 0, height_ = 0;
    QElapsedTimer activity_;
};

VideoOverlays::VideoOverlays(QWindow* parent) : QObject(parent), parent_(parent) {}

VideoOverlays::~VideoOverlays() { qDeleteAll(windows_); }

VideoOverlayWindow* VideoOverlays::windowFor(const QString& streamId) {
    auto*& window = windows_[streamId];
    if (!window) {
        window = new VideoOverlayWindow(parent_);
        window->onEscape = [this] { emit escapePressed(); };
        window->onPointerActivity = [this] { emit pointerActivity(); };
        window->onContextMenu = [this, streamId](const QPoint& point) { emit contextMenuRequested(streamId, point); };
        window->setOccluders(occluders_);
        window->setStageOccluders(stageOccluders_);
        window->onClick = [this, streamId] { emit clicked(streamId); };
        window->setIdle(idle_);
    }
    return window;
}

void VideoOverlays::setFrame(const QString& streamId, const QImage& image) { windowFor(streamId)->setFrame(image); }

void VideoOverlays::setSurface(const QString& streamId, const QRect& rect, double scale) {
    Q_UNUSED(scale);   // CSS pixels == Qt logical pixels for a WebView2 at 100% zoom; DPI > 100% not verified yet
    windowFor(streamId)->setSurface(rect);
}

void VideoOverlays::setLabel(const QString& streamId, const QString& label) { windowFor(streamId)->setLabel(label); }
void VideoOverlays::setLive(const QString& streamId, bool live, int fps, int height) { windowFor(streamId)->setLive(live, fps, height); }
void VideoOverlays::setRole(const QString& streamId, const QString& role) { windowFor(streamId)->setRole(role); }
void VideoOverlays::setIdle(bool idle) {
    idle_ = idle;
    for (auto* window : std::as_const(windows_)) window->setIdle(idle);
}
QString VideoOverlays::role(const QString& streamId) const {
    const auto* window = windows_.value(streamId);
    return window ? window->role() + (window->idle() ? " idle=1" : "") : QString();
}

bool VideoOverlays::hovered(const QString& streamId) const {
    const auto* window = windows_.value(streamId);
    return window && window->hovered();
}
QString VideoOverlays::badgeText(const QString& streamId, bool hovered) const {
    const auto* window = windows_.value(streamId);
    return window ? window->badges(hovered) : QString();
}

void VideoOverlays::remove(const QString& streamId) {
    if (auto* window = windows_.take(streamId)) { window->hide(); window->deleteLater(); }
}

void VideoOverlays::setStageOccluders(const QVector<QRect>& rects) {
    stageOccluders_ = rects;
    for (auto* window : std::as_const(windows_)) window->setStageOccluders(rects);
}

void VideoOverlays::setOccluders(const QVector<QRect>& rects) {
    occluders_ = rects;
    for (auto* window : std::as_const(windows_)) window->setOccluders(rects);
}

QStringList VideoOverlays::occludedStreams() const {
    QStringList list;
    for (auto it = windows_.cbegin(); it != windows_.cend(); ++it) if (it.value()->isVisible() && it.value()->occluded()) list << it.key();
    return list;
}

int VideoOverlays::paintedFrames(const QString& streamId) const {
    const auto* window = windows_.value(streamId);
    return window ? window->painted : 0;
}

QHash<QString, QPair<QRect, QImage>> VideoOverlays::snapshots() const {
    QHash<QString, QPair<QRect, QImage>> result;
    for (auto it = windows_.cbegin(); it != windows_.cend(); ++it)
        if (it.value()->isVisible()) result.insert(it.key(), {it.value()->surface(), it.value()->snapshot()});
    return result;
}

QStringList VideoOverlays::visibleStreams() const {
    QStringList visible;
    for (auto it = windows_.cbegin(); it != windows_.cend(); ++it) if (it.value()->isVisible()) visible << it.key();
    return visible;
}

} // namespace triscord
