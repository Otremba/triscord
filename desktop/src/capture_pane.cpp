#include "capture_pane.h"
#include <QComboBox>
#include <QPushButton>
#include <QLabel>
#include <QHBoxLayout>
#include <QVBoxLayout>

namespace triscord {
CapturePane::CapturePane(CaptureService* service, QWidget* parent) : QWidget(parent), service_(service) {
    auto* layout = new QVBoxLayout(this); layout->setContentsMargins(0, 0, 0, 0);
    auto* controls = new QHBoxLayout;
    source_ = new QComboBox(this);
    auto* refresh = new QPushButton("atualizar fontes", this);
    start_ = new QPushButton("iniciar prévia", this);
    auto* stop = new QPushButton("parar prévia", this); stop->setEnabled(false);
    controls->addWidget(source_, 1); controls->addWidget(refresh);
    controls->addWidget(start_); controls->addWidget(stop);
    layout->addLayout(controls);
    auto* preview = new QLabel("prévia local de janela ou monitor", this);
    preview->setAlignment(Qt::AlignCenter); preview->setFixedHeight(180);
    preview->setStyleSheet("background: #080808; border: 1px solid #303030;");
    layout->addWidget(preview);
    connect(refresh, &QPushButton::clicked, this, &CapturePane::refreshSources);
    connect(start_, &QPushButton::clicked, this, [this, preview] {
        const int index = source_->currentIndex();
        if (index < 0 || index >= sources_.size()) return;
        preview->setText("iniciando prévia local…"); service_->start(sources_.at(index));
    });
    connect(stop, &QPushButton::clicked, service_, &CaptureService::stop);
    connect(service_, &CaptureService::activeChanged, this, [stop, preview](bool active) {
        stop->setEnabled(active); preview->setPixmap({});
        preview->setText(active ? "aguardando imagem da fonte selecionada…" : "prévia parada");
    });
    connect(service_, &CaptureService::pausedChanged, this, [preview](bool paused) {
        if (paused) { preview->setPixmap({}); preview->setText("janela minimizada. restaure-a para retomar a prévia."); }
    });
    connect(service_, &CaptureService::previewReady, this, [preview](const CapturePreview& frame) {
        preview->setPixmap(QPixmap::fromImage(frame.image).scaled(preview->size(), Qt::KeepAspectRatio, Qt::SmoothTransformation));
    });
    refreshSources();
}
void CapturePane::refreshSources() {
    const int index = source_->currentIndex();
    const auto selected = index >= 0 && index < sources_.size() ? sources_.at(index) : CaptureSource{};
    source_->clear(); sources_ = captureSources();
    for (const auto& item : sources_) source_->addItem(item.name);
    for (int i = 0; i < sources_.size(); ++i)
        if (sources_.at(i).handle == selected.handle && sources_.at(i).kind == selected.kind) source_->setCurrentIndex(i);
    start_->setEnabled(!sources_.isEmpty());
}
}
