#include "settings_view.h"

#include "discord_icons.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QVBoxLayout>

namespace triscord {

SettingsToggle::SettingsToggle(QWidget* parent) : QCheckBox(parent) {
    setFixedSize(48, 24);
    setCursor(Qt::PointingHandCursor);
}

void SettingsToggle::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    const bool on = isChecked();
    QPainterPath track; track.addRoundedRect(QRectF(rect()), 12, 12);
    // Observed: accent #5865f2 track when on; the off track is a neutral gray.
    p.fillPath(track, !isEnabled() ? QColor("#262629") : on ? QColor("#5865f2") : QColor("#4d505b"));
    const QRectF knob(on ? width() - 4 - 16 : 4, 4, 16, 16);
    p.setPen(Qt::NoPen);
    p.setBrush(isEnabled() ? QColor("#dcdcdf") : QColor("#81828a"));
    p.drawEllipse(knob);
}

QWidget* settingsRow(QWidget* parent, const QString& label, const QString& description, QWidget* control) {
    auto* row = new QWidget(parent);
    auto* layout = new QHBoxLayout(row);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(16);
    auto* text = new QVBoxLayout;
    text->setContentsMargins(0, 0, 0, 0);
    text->setSpacing(2);
    auto* title = new QLabel(label, row);
    title->setObjectName("settingsRowLabel");
    text->addWidget(title);
    if (!description.isEmpty()) {
        auto* desc = new QLabel(description, row);
        desc->setObjectName("settingsRowDescription");
        desc->setWordWrap(true);
        text->addWidget(desc);
    }
    layout->addLayout(text, 1);
    if (control) layout->addWidget(control, 0, Qt::AlignVCenter);
    return row;
}

QLabel* settingsHeading(QWidget* parent, const QString& text) {
    auto* heading = new QLabel(text, parent);
    heading->setObjectName("settingsHeading");
    return heading;
}

QWidget* settingsDivider(QWidget* parent) {
    auto* line = new QWidget(parent);
    line->setObjectName("settingsDivider");
    line->setAttribute(Qt::WA_StyledBackground);
    line->setFixedHeight(1);
    return line;
}

QSize SettingsNavDelegate::sizeHint(const QStyleOptionViewItem&, const QModelIndex& index) const {
    switch (index.data(KindRole).toInt()) {
    case Section: return {0, 40};
    case Sub: return {0, 36};
    default: return {0, 40};
    }
}

void SettingsNavDelegate::paint(QPainter* p, const QStyleOptionViewItem& option, const QModelIndex& index) const {
    p->save();
    p->setRenderHint(QPainter::Antialiasing);
    const QRect r = option.rect;
    const int kind = index.data(KindRole).toInt();
    const QString text = index.data(Qt::DisplayRole).toString();
    QFont f = option.font;
    if (kind == Section) {
        f.setPixelSize(14); f.setWeight(QFont::Medium);
        p->setFont(f); p->setPen(QColor("#96979e"));
        p->drawText(r.adjusted(8, 12, -8, 0), Qt::AlignLeft | Qt::AlignVCenter, text);
    } else if (kind == Sub) {
        const bool active = index.data(ActiveRole).toBool();
        // Observed rail: 1px line at +17 of the nav item, active segment white and 20px tall.
        const int railX = r.left() + 17;
        p->setPen(QPen(QColor("#1e1e20"), 1));
        p->drawLine(railX, r.top(), railX, r.bottom());
        if (active) p->fillRect(QRect(railX - 1, r.center().y() - 10, 2, 20), Qt::white);
        f.setPixelSize(16); f.setWeight(QFont::Medium);
        p->setFont(f); p->setPen(active ? QColor("#dcdcdf") : QColor("#96979e"));
        p->drawText(r.adjusted(36, 0, -8, 0), Qt::AlignLeft | Qt::AlignVCenter, text);
    } else {
        const bool selected = option.state & QStyle::State_Selected;
        const bool hovered = option.state & QStyle::State_MouseOver;
        const QRect item = r.adjusted(0, 2, 0, -2);
        if (selected || hovered) {
            QPainterPath bg; bg.addRoundedRect(QRectF(item), 8, 8);
            p->fillPath(bg, selected ? QColor("#414248") : QColor(151, 151, 159, 31));
        }
        const QColor fg = selected || hovered ? QColor("#dcdcdf") : QColor("#96979e");
        const auto icon = static_cast<DiscordIcons::IconType>(index.data(IconRole).toInt());
        DiscordIcons::paint(p, icon, QRectF(item.left() + 10, item.center().y() - 10, 20, 20), fg);
        f.setPixelSize(16); f.setWeight(QFont::Medium);
        p->setFont(f); p->setPen(fg);
        p->drawText(item.adjusted(36, 0, -8, 0), Qt::AlignLeft | Qt::AlignVCenter, text);
    }
    p->restore();
}

} // namespace triscord
