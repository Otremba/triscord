#include "camera_view.h"
#include "video_stage_label.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QPushButton>
namespace triscord {
CameraView::CameraView(QWidget* parent) : QDialog(parent), stage_(new VideoStageLabel(this)) {
    setObjectName("cameraView"); stage_->setObjectName("cameraStage");
    auto* layout = new QVBoxLayout(this); layout->setContentsMargins(8,8,8,8);
    layout->addWidget(stage_, 1);
    auto* controls = new QHBoxLayout;
    auto* reset = new QPushButton("ajustar", this); reset->setObjectName("cameraResetZoom");
    auto* close = new QPushButton("voltar (esc)", this);
    controls->addWidget(reset); controls->addStretch(); controls->addWidget(close); layout->addLayout(controls);
    connect(reset, &QPushButton::clicked, stage_, &VideoStageLabel::resetZoom);
    connect(close, &QPushButton::clicked, this, &QDialog::reject);
    connect(stage_, &VideoStageLabel::doubleClicked, this, [this] { emit returnToGridRequested(); reject(); });
    connect(this, &QDialog::finished, this, [this] {
        peer_.clear(); stage_->setFrame({}); stage_->resetZoom(); emit focusChanged({});
    });
}
void CameraView::openPeer(const QString& id, const QString& name, const QImage& image) {
    if (id.isEmpty() || image.isNull()) return;
    peer_ = id; setWindowTitle("Triscord — " + name);
    stage_->resetZoom(); stage_->setFrame(image); emit focusChanged(id); showFullScreen();
}
void CameraView::setFrame(const QString& id, const QImage& image) {
    if (isVisible() && id == peer_) stage_->setFrame(image);
}
void CameraView::removePeer(const QString& id) { if (id == peer_) reject(); }
}
