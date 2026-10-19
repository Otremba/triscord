#include "discord_tooltip.h"

#include <QEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPointer>
#include <QScreen>
#include <algorithm>

namespace triscord {

namespace {

constexpr int kRadius = 8, kPadX = 12, kPadY = 8, kArrowLong = 12, kArrowShort = 6;

class TooltipBubble : public QWidget {
public:
    TooltipBubble() : QWidget(nullptr, Qt::ToolTip | Qt::FramelessWindowHint | Qt::NoDropShadowWindowHint) {
        setAttribute(Qt::WA_TranslucentBackground);
        setAttribute(Qt::WA_ShowWithoutActivating);
        setAttribute(Qt::WA_TransparentForMouseEvents);
    }
    void showFor(QWidget* target, TooltipPlacement placement) {
        text_ = target->toolTip();
        placement_ = placement;
        if (text_.isEmpty()) { hide(); return; }
        QFont f = font();
        f.setPixelSize(placement == TooltipPlacement::Right ? 16 : 14);
        f.setWeight(placement == TooltipPlacement::Right ? QFont::Bold : QFont::DemiBold);
        setFont(f);
        const QFontMetrics fm(f);
        QSize body(fm.horizontalAdvance(text_) + 2 * kPadX + 2, fm.height() + 2 * kPadY);
        if (text_.contains('\n')) {
            // Observed on quick reactions (CHAT.md): bold ":name:" over a 12px "Clique para reagir".
            const QStringList lines = text_.split('\n');
            QFont title = f; title.setWeight(QFont::Bold);
            QFont detail = f; detail.setPixelSize(12); detail.setWeight(QFont::Medium);
            const QFontMetrics tm(title), dm(detail);
            body = QSize(std::max(tm.horizontalAdvance(lines.value(0)), dm.horizontalAdvance(lines.value(1))) + 2 * kPadX + 2,
                         tm.height() + dm.height() + 2 * kPadY);
        }
        QPoint pos;
        if (placement == TooltipPlacement::Right) {
            resize(body.width() + kArrowShort, body.height());
            const QPoint anchor = target->mapToGlobal(QPoint(target->width(), target->height() / 2));
            pos = QPoint(anchor.x() + 6, anchor.y() - height() / 2);
        } else if (placement == TooltipPlacement::Below) {
            resize(body.width(), body.height() + kArrowShort);
            const QPoint anchor = target->mapToGlobal(QPoint(target->width() / 2, target->height()));
            pos = QPoint(anchor.x() - width() / 2, anchor.y() + 5);
        } else {
            resize(body.width(), body.height() + kArrowShort);
            const QPoint anchor = target->mapToGlobal(QPoint(target->width() / 2, 0));
            pos = QPoint(anchor.x() - width() / 2, anchor.y() - 5 - height());
        }
        if (auto* screen = target->screen()) {
            const QRect area = screen->availableGeometry();
            pos.setX(std::clamp(pos.x(), area.left(), area.right() - width()));
        }
        move(pos);
        update();
        show();
        raise();
    }

protected:
    void paintEvent(QPaintEvent*) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        QRectF body;
        QPainterPath arrow;
        if (placement_ == TooltipPlacement::Right) {
            body = QRectF(kArrowShort + 0.5, 0.5, width() - kArrowShort - 1, height() - 1);
            const qreal cy = height() / 2.0;
            arrow.moveTo(body.left() + 1, cy - kArrowLong / 2.0);
            arrow.lineTo(0, cy);
            arrow.lineTo(body.left() + 1, cy + kArrowLong / 2.0);
        } else if (placement_ == TooltipPlacement::Below) {
            body = QRectF(0.5, kArrowShort + 0.5, width() - 1, height() - kArrowShort - 1);
            const qreal cx = width() / 2.0;
            arrow.moveTo(cx - kArrowLong / 2.0, body.top() + 1);
            arrow.lineTo(cx, 0);
            arrow.lineTo(cx + kArrowLong / 2.0, body.top() + 1);
        } else {
            body = QRectF(0.5, 0.5, width() - 1, height() - kArrowShort - 1);
            const qreal cx = width() / 2.0;
            arrow.moveTo(cx - kArrowLong / 2.0, body.bottom() - 1);
            arrow.lineTo(cx, body.bottom() + kArrowShort);
            arrow.lineTo(cx + kArrowLong / 2.0, body.bottom() - 1);
        }
        arrow.closeSubpath();
        QPainterPath shape;
        shape.addRoundedRect(body, kRadius, kRadius);
        shape = shape.united(arrow);
        p.setPen(QPen(QColor("#48484d"), 1));
        p.setBrush(QColor("#0a0a0c"));
        p.drawPath(shape);
        p.setPen(QColor("#dcdcdf"));
        if (text_.contains('\n')) {
            const QStringList lines = text_.split('\n');
            QFont title = font(); title.setWeight(QFont::Bold);
            QFont detail = font(); detail.setPixelSize(12); detail.setWeight(QFont::Medium);
            const int titleHeight = QFontMetrics(title).height();
            const QRect inner = body.toRect().adjusted(0, kPadY, 0, -kPadY);
            p.setFont(title); p.drawText(QRect(inner.left(), inner.top(), inner.width(), titleHeight), Qt::AlignCenter, lines.value(0));
            p.setFont(detail); p.drawText(QRect(inner.left(), inner.top() + titleHeight, inner.width(), inner.height() - titleHeight), Qt::AlignHCenter | Qt::AlignTop, lines.value(1));
        } else {
            p.drawText(body.toRect(), Qt::AlignCenter, text_);
        }
    }

private:
    QString text_;
    TooltipPlacement placement_ = TooltipPlacement::Above;
};

TooltipBubble* bubble() {
    static QPointer<TooltipBubble> instance;
    if (!instance) instance = new TooltipBubble;
    return instance;
}

class TooltipFilter : public QObject {
public:
    TooltipFilter(QObject* parent, TooltipPlacement placement) : QObject(parent), placement_(placement) {}
    bool eventFilter(QObject* watched, QEvent* event) override {
        auto* target = qobject_cast<QWidget*>(watched);
        if (!target) return false;
        switch (event->type()) {
        case QEvent::ToolTip:
            bubble()->showFor(target, placement_);
            return true;
        case QEvent::Leave:
        case QEvent::Hide:
        case QEvent::MouseButtonPress:
        case QEvent::WindowDeactivate:
            bubble()->hide();
            break;
        case QEvent::ToolTipChange:
            if (bubble()->isVisible() && target->underMouse()) bubble()->showFor(target, placement_);
            break;
        default:
            break;
        }
        return false;
    }

private:
    TooltipPlacement placement_;
};

} // namespace

void installDiscordTooltip(QWidget* target, TooltipPlacement placement) {
    if (!target || target->property("discordTooltip").toBool()) return;
    target->setProperty("discordTooltip", true);
    target->installEventFilter(new TooltipFilter(target, placement));
}

} // namespace triscord
