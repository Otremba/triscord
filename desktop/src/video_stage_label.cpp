#include "video_stage_label.h"
#include <QPainter>
#include <QResizeEvent>
#include <algorithm>

namespace triscord {

VideoStageLabel::VideoStageLabel(QWidget* parent) : QLabel(parent) {
    setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Expanding);
    setMinimumSize(160, 200);
    setAlignment(Qt::AlignCenter);
    setStyleSheet("background:#000000; border:1px solid #1e1f22; border-radius:8px; color:#949ba4; font-family:\"gg sans\", \"Noto Sans\", \"Segoe UI\", Arial, sans-serif;");
    setText("Nenhuma transmissão ativa");
}

void VideoStageLabel::setFrame(const QImage& image) {
    if (currentImage_.cacheKey() == image.cacheKey()) return;
    currentImage_ = image;
    updateDisplayedPixmap();
}

void VideoStageLabel::resetZoom() {
    scale_ = 1.0;
    pan_ = {0, 0};
    setCursor(Qt::ArrowCursor);
    updateDisplayedPixmap();
}

void VideoStageLabel::setZoomScale(double s) {
    scale_ = std::clamp(s, 1.0, 5.0);
    clampPan();
    setCursor(scale_ > 1.05 ? Qt::OpenHandCursor : Qt::ArrowCursor);
    updateDisplayedPixmap();
}

void VideoStageLabel::clampPan() {
    if (currentImage_.isNull() || scale_ <= 1.01 || width() <= 0 || height() <= 0) {
        pan_ = {0, 0};
        return;
    }
    const QSize baseSize = currentImage_.size().scaled(size(), Qt::KeepAspectRatio);
    const QSize scaledSize = baseSize * scale_;
    const double maxPanX = std::max(0.0, (scaledSize.width() - width()) / 2.0);
    const double maxPanY = std::max(0.0, (scaledSize.height() - height()) / 2.0);
    pan_.setX(std::clamp(pan_.x(), -maxPanX, maxPanX));
    pan_.setY(std::clamp(pan_.y(), -maxPanY, maxPanY));
}

void VideoStageLabel::updateDisplayedPixmap() {
    if (currentImage_.isNull()) {
        setPixmap(QPixmap{});
        setText("Aguardando transmissão…");
        return;
    }
    if (width() <= 0 || height() <= 0) return;
    setText("");

    if (scale_ <= 1.01) {
        pan_ = {0, 0};
        setPixmap(QPixmap::fromImage(currentImage_).scaled(size(), Qt::KeepAspectRatio, Qt::SmoothTransformation));
    } else {
        clampPan();
        QPixmap canvas(size());
        canvas.fill(QColor("#000000"));
        QPainter p(&canvas);
        p.setRenderHint(QPainter::SmoothPixmapTransform);
        const QSize baseSize = currentImage_.size().scaled(size(), Qt::KeepAspectRatio);
        const QSize scaledSize = baseSize * scale_;
        const QPointF center(width() / 2.0 + pan_.x(), height() / 2.0 + pan_.y());
        const QRectF destRect(center.x() - scaledSize.width() / 2.0,
                             center.y() - scaledSize.height() / 2.0,
                             scaledSize.width(), scaledSize.height());
        p.drawImage(destRect, currentImage_);
        p.end();
        setPixmap(canvas);
    }
}

void VideoStageLabel::resizeEvent(QResizeEvent* event) {
    QLabel::resizeEvent(event);
    updateDisplayedPixmap();
}

void VideoStageLabel::wheelEvent(QWheelEvent* event) {
    if (currentImage_.isNull()) {
        QLabel::wheelEvent(event);
        return;
    }
    const double delta = event->angleDelta().y() > 0 ? 1.15 : (1.0 / 1.15);
    const double oldScale = scale_;
    scale_ = std::clamp(scale_ * delta, 1.0, 5.0);

    if (scale_ > 1.01 && oldScale != scale_) {
        const QPointF mousePos = event->position();
        const QPointF center(width() / 2.0, height() / 2.0);
        pan_ += (center - mousePos) * ((scale_ / oldScale) - 1.0);
    }
    clampPan();
    setCursor(scale_ > 1.05 ? Qt::OpenHandCursor : Qt::ArrowCursor);
    updateDisplayedPixmap();
    event->accept();
}

void VideoStageLabel::mousePressEvent(QMouseEvent* event) {
    if (event->button() == Qt::LeftButton && scale_ > 1.05) {
        dragging_ = true;
        lastMousePos_ = event->pos();
        setCursor(Qt::ClosedHandCursor);
        event->accept();
        return;
    }
    QLabel::mousePressEvent(event);
}

void VideoStageLabel::mouseMoveEvent(QMouseEvent* event) {
    if (dragging_) {
        const QPoint diff = event->pos() - lastMousePos_;
        lastMousePos_ = event->pos();
        pan_ += QPointF(diff.x(), diff.y());
        clampPan();
        updateDisplayedPixmap();
        event->accept();
        return;
    }
    QLabel::mouseMoveEvent(event);
}

void VideoStageLabel::mouseReleaseEvent(QMouseEvent* event) {
    if (dragging_) {
        dragging_ = false;
        setCursor(scale_ > 1.05 ? Qt::OpenHandCursor : Qt::ArrowCursor);
        event->accept();
        return;
    }
    QLabel::mouseReleaseEvent(event);
}

void VideoStageLabel::mouseDoubleClickEvent(QMouseEvent* event) {
    if (scale_ > 1.05) {
        resetZoom();
    } else {
        emit doubleClicked();
    }
    event->accept();
}

} // namespace triscord
