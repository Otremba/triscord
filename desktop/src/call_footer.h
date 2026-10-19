#pragma once
#include <QWidget>
#include <QGridLayout>
#include <QResizeEvent>
#include <QEvent>
#include <algorithm>

namespace triscord {
// Native adaptation of the recovered left/center/right control tray.
// Layout changes only on resize or changed button size hints; no polling.
class CallFooter final : public QWidget {
public:
    CallFooter(QWidget* audio, QWidget* media, QWidget* actions, QWidget* parent = nullptr)
        : QWidget(parent), audio_(audio), media_(media), actions_(actions), grid_(new QGridLayout(this)) {
        setObjectName("footer"); grid_->setContentsMargins(18,12,18,12); grid_->setSpacing(8);
        grid_->setSizeConstraint(QLayout::SetNoConstraint);
        grid_->addWidget(audio_,0,0,Qt::AlignLeft | Qt::AlignVCenter);
        grid_->addWidget(media_,0,1,Qt::AlignCenter);
        grid_->addWidget(actions_,0,2,Qt::AlignRight | Qt::AlignVCenter);
        grid_->setColumnStretch(1,1);
    }
    QSize minimumSizeHint() const override {
        const int minimumWidth = std::max(audio_->minimumSizeHint().width() + actions_->minimumSizeHint().width() + 8,
                                         media_->minimumSizeHint().width()) + 36;
        return {minimumWidth, grid_->minimumSize().height()};
    }
protected:
    void resizeEvent(QResizeEvent* event) override { QWidget::resizeEvent(event); arrange(); }
    bool event(QEvent* event) override {
        if (event->type() == QEvent::LayoutRequest) arrange();
        return QWidget::event(event);
    }
private:
    void arrange() {
        const bool next = width() < audio_->sizeHint().width() + media_->sizeHint().width() + actions_->sizeHint().width() + 52;
        if (next == compact_) return;
        compact_ = next;
        grid_->removeWidget(media_);
        if (compact_) grid_->addWidget(media_,1,0,1,3,Qt::AlignCenter);
        else grid_->addWidget(media_,0,1,Qt::AlignCenter);
        grid_->invalidate(); updateGeometry();
    }
    QWidget* audio_;
    QWidget* media_;
    QWidget* actions_;
    QGridLayout* grid_;
    bool compact_ = false;
};
}
