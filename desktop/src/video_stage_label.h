#pragma once
#include <QImage>
#include <QLabel>
#include <QMouseEvent>
#include <QPointF>
#include <QWheelEvent>

namespace triscord {

// Image area with wheel zoom and drag panning, used by the enlarged viewers (CameraView).
class VideoStageLabel final : public QLabel {
    Q_OBJECT
public:
    explicit VideoStageLabel(QWidget* parent = nullptr);
    void setFrame(const QImage& image);
    void resetZoom();
    double zoomScale() const { return scale_; }
    void setZoomScale(double s);

signals:
    void doubleClicked();

protected:
    void resizeEvent(QResizeEvent* event) override;
    void wheelEvent(QWheelEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseDoubleClickEvent(QMouseEvent* event) override;

private:
    void updateDisplayedPixmap();
    void clampPan();
    QImage currentImage_;
    double scale_ = 1.0;
    QPointF pan_ = {0, 0};
    bool dragging_ = false;
    QPoint lastMousePos_;
};

} // namespace triscord
