#include "account_panel.h"

#include "discord_icons.h"

#include <QEasingCurve>
#include <QPropertyAnimation>

#include <QEvent>
#include <QHBoxLayout>
#include <QLabel>
#include <QMenu>
#include <QPainter>
#include <QPainterPath>
#include <QPolygonF>
#include <QScreen>
#include <QStyle>
#include <QVBoxLayout>
#include <QWidgetAction>
#include <algorithm>
#include <optional>

namespace triscord {

namespace {

// Colours measured on the observed Discord panel; backgrounds adapted to the black theme.
const QColor kIconNormal("#96979e");
const QColor kIconHover("#efefef");
const QColor kChevronNormal("#b3b4b8");
const QColor kDanger("#da3e44");

// Row painted by its menu so QMenu keeps native hover, keyboard and submenu handling.
class MenuRow : public QWidget {
public:
    enum class Trailing { None, Chevron, Radio, Checkbox };
    MenuRow(QMenu* menu, QWidgetAction* action, const QString& title, const QString& subtitle,
            DiscordIcons::IconType leading, bool hasLeading, Trailing trailing, bool selected, int height, int width = 204,
            bool danger = false)
        : QWidget(menu), menu_(menu), action_(action), title_(title), subtitle_(subtitle), leading_(leading),
          hasLeading_(hasLeading), trailing_(trailing), selected_(selected), danger_(danger) {
        setAttribute(Qt::WA_TransparentForMouseEvents);
        setFixedSize(width, height);
        setAccessibleName(subtitle.isEmpty() ? title : title + ", " + subtitle);
    }

protected:
    void paintEvent(QPaintEvent*) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        const bool active = menu_->activeAction() == action_;
        if (active) {
            QPainterPath bg; bg.addRoundedRect(QRectF(rect()), 4, 4);
            p.fillPath(bg, QColor("#2d2d30"));
        }
        int x = 8;
        if (hasLeading_) {
            DiscordIcons::paint(&p, leading_, QRectF(x, (height() - 20) / 2.0, 20, 20), active ? kIconHover : kIconNormal);
            x += 28;
        }
        const int right = trailing_ == Trailing::None ? width() - 8 : width() - 36;
        QFont titleFont = font(); titleFont.setPixelSize(14); titleFont.setWeight(QFont::DemiBold);
        QFont subFont = font(); subFont.setPixelSize(12);
        const QFontMetrics tm(titleFont), sm(subFont);
        p.setPen(danger_ ? QColor("#f39a96") : QColor("#dcdcdf"));
        p.setFont(titleFont);
        if (subtitle_.isEmpty()) {
            p.drawText(QRect(x, 0, right - x, height()), Qt::AlignVCenter | Qt::AlignLeft, tm.elidedText(title_, Qt::ElideRight, right - x));
        } else {
            const int block = tm.height() + sm.height();
            const int top = (height() - block) / 2;
            p.drawText(QRect(x, top, right - x, tm.height()), Qt::AlignLeft | Qt::AlignVCenter, tm.elidedText(title_, Qt::ElideRight, right - x));
            p.setFont(subFont); p.setPen(QColor("#949ba4"));
            p.drawText(QRect(x, top + tm.height(), right - x, sm.height()), Qt::AlignLeft | Qt::AlignVCenter, sm.elidedText(subtitle_, Qt::ElideRight, right - x));
        }
        if (trailing_ == Trailing::Chevron) {
            DiscordIcons::paint(&p, DiscordIcons::IconType::ChevronSmallRight, QRectF(width() - 28, (height() - 20) / 2.0, 20, 20), kIconNormal);
        } else if (trailing_ == Trailing::Checkbox) {
            // Observed: 20px box, radius 4, 8px from the row edge; checked #5865f2 with a white tick, otherwise a 2px outline.
            const QRectF box(width() - 28, (height() - 20) / 2.0, 20, 20);
            if (action_->isChecked()) {
                p.setPen(Qt::NoPen); p.setBrush(QColor("#5865f2")); p.drawRoundedRect(box, 4, 4);
                QPen tick(Qt::white, 2.2, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin);
                p.setPen(tick); p.setBrush(Qt::NoBrush);
                p.drawPolyline(QPolygonF{box.topLeft() + QPointF(5, 10.5), box.topLeft() + QPointF(8.5, 14), box.topLeft() + QPointF(15, 6.5)});
            } else {
                p.setPen(QPen(QColor("#74747d"), 2)); p.setBrush(QColor("#373840"));
                p.drawRoundedRect(box.adjusted(1, 1, -1, -1), 3.5, 3.5);
            }
        } else if (trailing_ == Trailing::Radio) {
            const QRectF ring(width() - 30, (height() - 20) / 2.0, 20, 20);
            if (selected_) {
                p.setPen(Qt::NoPen); p.setBrush(QColor("#5865f2")); p.drawEllipse(ring);
                p.setBrush(Qt::white); p.drawEllipse(ring.center(), 4, 4);
            } else {
                p.setPen(QPen(kIconNormal, 2)); p.setBrush(Qt::NoBrush); p.drawEllipse(ring.adjusted(1, 1, -1, -1));
            }
        }
    }

private:
    QMenu* menu_;
    QWidgetAction* action_;
    QString title_, subtitle_;
    DiscordIcons::IconType leading_;
    bool hasLeading_;
    Trailing trailing_;
    bool selected_;
    bool danger_;
};

QWidgetAction* addRow(QMenu* menu, const QString& title, const QString& subtitle,
                      std::optional<DiscordIcons::IconType> leading, MenuRow::Trailing trailing,
                      bool selected, int height, int width = 204, bool danger = false) {
    auto* action = new QWidgetAction(menu);
    action->setText(title);
    action->setDefaultWidget(new MenuRow(menu, action, title, subtitle,
                                         leading.value_or(DiscordIcons::IconType::Settings), leading.has_value(),
                                         trailing, selected, height, width, danger));
    menu->addAction(action);
    return action;
}

void repaintRowsOnHover(QMenu* menu) {
    auto repaint = [menu] {
        for (auto* action : menu->actions())
            if (auto* widgetAction = qobject_cast<QWidgetAction*>(action); widgetAction && widgetAction->defaultWidget())
                widgetAction->defaultWidget()->update();
    };
    QObject::connect(menu, &QMenu::hovered, menu, repaint);
    struct LeaveFilter : QObject {
        std::function<void()> fn;
        bool eventFilter(QObject*, QEvent* e) override { if (e->type() == QEvent::Leave) fn(); return false; }
    };
    auto* filter = new LeaveFilter; filter->setParent(menu); filter->fn = repaint;
    menu->installEventFilter(filter);
}

QMenu* createMenu(QWidget* parent) {
    auto* menu = new QMenu(parent);
    menu->setObjectName("audioOptionsMenu");
    menu->setStyleSheet(
        "QMenu#audioOptionsMenu { background:#121214; border:1px solid #4c4c51; border-radius:8px; padding:8px; }"
        "QMenu#audioOptionsMenu QWidget { background:transparent; }"
        "QMenu#audioOptionsMenu::separator { height:1px; background:#2d2d30; margin:8px 8px; }"
        "QMenu#audioOptionsMenu[compactSeparators=\"true\"] { padding:6px 8px 8px 8px; }"
        "QMenu#audioOptionsMenu[compactSeparators=\"true\"]::separator { margin:8px 8px 7px 8px; }"
        "QLabel#audioOptionsVolumeTitle { color:#dcdcdf; font-size:14px; font-weight:600; background:transparent; }"
        "QMenu#audioOptionsMenu QSlider::groove:horizontal { height:3px; background:#4d505b; border-radius:1px; }"
        "QMenu#audioOptionsMenu QSlider::sub-page:horizontal { background:#5865f2; border-radius:1px; }"
        "QMenu#audioOptionsMenu QSlider::handle:horizontal { background:#ffffff; width:16px; height:16px; margin:-7px 0; border-radius:8px; }");
    repaintRowsOnHover(menu);
    return menu;
}

class HoverIconFilter : public QObject {
public:
    using QObject::QObject;
    bool eventFilter(QObject* watched, QEvent* event) override {
        auto* button = qobject_cast<QPushButton*>(watched);
        if (button && (event->type() == QEvent::Enter || event->type() == QEvent::Leave)) apply(button, event->type() == QEvent::Enter);
        return false;
    }
    static void apply(QPushButton* button, bool hovered) {
        const auto icon = button->property(hovered ? "hoverIcon" : "normalIcon").value<QIcon>();
        if (!icon.isNull()) button->setIcon(icon);
    }
};

} // namespace

void floatAtBottom(QWidget* panel, QWidget* column, int margin) {
    struct Filter : QObject {
        QWidget* panel; int margin;
        bool eventFilter(QObject* watched, QEvent* event) override {
            if (event->type() == QEvent::Resize || event->type() == QEvent::Show) {
                auto* column = watched == panel ? panel->parentWidget() : static_cast<QWidget*>(watched);
                if (watched == panel && event->type() == QEvent::Show) return false;
                panel->setGeometry(margin, column->height() - margin - panel->height(), column->width() - 2 * margin, panel->height());
                panel->raise();
            }
            return false;
        }
    };
    auto* filter = new Filter; filter->setParent(panel); filter->panel = panel; filter->margin = margin;
    column->installEventFilter(filter);
    panel->installEventFilter(filter);
}

void watchHover(QWidget* widget, std::function<void(bool)> changed) {
    struct Filter : QObject {
        std::function<void(bool)> changed;
        bool eventFilter(QObject*, QEvent* event) override {
            if (event->type() == QEvent::Enter) changed(true);
            else if (event->type() == QEvent::Leave) changed(false);
            return false;
        }
    };
    auto* filter = new Filter; filter->setParent(widget); filter->changed = std::move(changed);
    widget->installEventFilter(filter);
}

void setHoverIcons(QPushButton* button, const QIcon& normal, const QIcon& hover) {
    button->setProperty("normalIcon", normal);
    button->setProperty("hoverIcon", hover);
    if (!button->property("hoverIconFilter").toBool()) {
        button->installEventFilter(new HoverIconFilter(button));
        button->setProperty("hoverIconFilter", true);
    }
    HoverIconFilter::apply(button, button->underMouse());
}

SplitAudioButton::SplitAudioButton(const QString& objectName, QWidget* parent) : QWidget(parent) {
    setObjectName(objectName);
    setAttribute(Qt::WA_Hover);
    setFixedSize(49, 32);
    auto* layout = new QHBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);
    toggle_ = new QPushButton(this);
    toggle_->setObjectName("splitToggle");
    toggle_->setFixedSize(32, 32);
    toggle_->setIconSize(QSize(20, 20));
    toggle_->setCheckable(true);
    divider_ = new QWidget(this);
    divider_->setObjectName("splitDivider");
    divider_->setFixedSize(1, 32);
    options_ = new QPushButton(this);
    options_->setObjectName("splitOptions");
    options_->setFixedSize(16, 32);
    options_->setIconSize(QSize(16, 16));
    layout->addWidget(toggle_);
    layout->addWidget(divider_);
    layout->addWidget(options_);
    refreshChevron();
}

void ElidedLabel::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setFont(font());
    p.setPen(palette().color(foregroundRole()));
    const QRect area = contentsRect();
    p.drawText(area, Qt::AlignLeft | Qt::AlignVCenter, fontMetrics().elidedText(text(), Qt::ElideRight, area.width()));
}

void SplitAudioButton::repolish(const char* property, const QVariant& value) {
    setProperty(property, value);
    for (auto* w : {static_cast<QWidget*>(this), static_cast<QWidget*>(toggle_), static_cast<QWidget*>(options_)}) {
        w->style()->unpolish(w); w->style()->polish(w); w->update();
    }
}

bool SplitAudioButton::event(QEvent* event) {
    if (event->type() == QEvent::Enter) repolish("groupHover", true);
    else if (event->type() == QEvent::Leave) repolish("groupHover", false);
    return QWidget::event(event);
}

void SplitAudioButton::setActive(bool active) {
    if (active_ == active) return;
    active_ = active;
    repolish("active", active);
    refreshChevron();
}

void SplitAudioButton::setMenuOpen(bool open) {
    menuOpen_ = open;
    options_->setProperty("open", open);
    options_->style()->unpolish(options_); options_->style()->polish(options_);
    refreshChevron();
}

void SplitAudioButton::refreshChevron() {
    const auto type = menuOpen_ ? DiscordIcons::IconType::ChevronSmallUp : DiscordIcons::IconType::ChevronSmallDown;
    const QColor normal = active_ ? kDanger : kChevronNormal;
    const QColor hover = active_ ? kDanger : kIconHover;
    setHoverIcons(options_, DiscordIcons::icon(type, menuOpen_ ? hover : normal, 16), DiscordIcons::icon(type, hover, 16));
}

QMenu* createDiscordMenu(QWidget* parent) {
    // Observed context menus: 15px between a row and the next one across a separator (the audio menu keeps its own 17px).
    auto* menu = createMenu(parent);
    menu->setProperty("compactSeparators", true);
    return menu;
}

QAction* addDiscordMenuRow(QMenu* menu, const QString& title, std::optional<DiscordIcons::IconType> icon,
                           DiscordMenuTrailing trailing, bool checked, bool danger) {
    // Width follows the longest label, as observed (258px for the longest user-menu title).
    QFont font = menu->font(); font.setPixelSize(14); font.setWeight(QFont::DemiBold);
    const int width = std::max(204, QFontMetrics(font).horizontalAdvance(title) + (icon ? 36 : 8) + (trailing == DiscordMenuTrailing::None ? 8 : 36));
    const auto kind = trailing == DiscordMenuTrailing::Checkbox ? MenuRow::Trailing::Checkbox
                    : trailing == DiscordMenuTrailing::Chevron ? MenuRow::Trailing::Chevron : MenuRow::Trailing::None;
    auto* action = addRow(menu, title, {}, icon, kind, checked, 36, width, danger);
    if (trailing == DiscordMenuTrailing::Checkbox) { action->setCheckable(true); action->setChecked(checked); }
    return action;
}

void addDiscordMenuSlider(QMenu* menu, const QString& title, int minimum, int maximum, int value,
                          const QString& objectName, std::function<void(int)> changed) {
    auto* action = new QWidgetAction(menu);
    auto* block = new QWidget(menu);
    block->setFixedWidth(204);
    auto* layout = new QVBoxLayout(block);
    layout->setContentsMargins(8, 8, 5, 8);
    layout->setSpacing(7);
    auto* label = new QLabel(title, block);
    label->setObjectName("audioOptionsVolumeTitle");
    label->setFixedHeight(19);
    auto* slider = new QSlider(Qt::Horizontal, block);
    slider->setObjectName(objectName);
    slider->setProperty("discordMenuSlider", true);
    slider->setAccessibleName(title);
    slider->setRange(minimum, maximum);
    slider->setValue(value);
    slider->setFixedHeight(16);
    QObject::connect(slider, &QSlider::valueChanged, menu, std::move(changed));
    layout->addWidget(label);
    layout->addWidget(slider);
    action->setDefaultWidget(block);
    menu->addAction(action);
}

constexpr int kAudioMenuFadeInMs = 70;

void showAudioOptionsMenu(SplitAudioButton* anchor, const AudioOptionsSpec& spec) {
    if (!anchor || !spec.devices || !spec.volume) return;
    auto* menu = createMenu(anchor);
    menu->setAttribute(Qt::WA_DeleteOnClose);

    auto* devicesMenu = createMenu(menu);
    const bool input = spec.deviceTitle.contains("entrada");
    // Observed submenu (208px for "Padrão do Windows") sizes to its longest name: 8+20+8 text 8+20+8.
    QFont rowFont = devicesMenu->font(); rowFont.setPixelSize(14); rowFont.setWeight(QFont::DemiBold);
    const QFontMetrics rowMetrics(rowFont);
    int rowWidth = 0;
    for (int i = 0; i < spec.devices->count(); ++i)
        rowWidth = std::max(rowWidth, rowMetrics.horizontalAdvance(spec.devices->itemText(i)) + (input ? 72 : 44));
    rowWidth = std::min(rowWidth, 360);
    for (int i = 0; i < spec.devices->count(); ++i) {
        // Discord shows a second line per device; its source is not identified yet, so it is omitted.
        auto* row = addRow(devicesMenu, spec.devices->itemText(i), {},
                           input ? std::optional(DiscordIcons::IconType::Microphone) : std::nullopt,
                           MenuRow::Trailing::Radio, i == spec.devices->currentIndex(), 52, rowWidth);
        QObject::connect(row, &QAction::triggered, spec.devices, [combo = spec.devices, i] { if (combo) combo->setCurrentIndex(i); });
    }
    auto* deviceRow = addRow(menu, spec.deviceTitle, spec.devices->currentText(), std::nullopt, MenuRow::Trailing::Chevron, false, 52);
    deviceRow->setMenu(devicesMenu);
    menu->addSeparator();

    auto* volumeAction = new QWidgetAction(menu);
    auto* volumeBlock = new QWidget(menu);
    volumeBlock->setFixedWidth(204);
    auto* volumeLayout = new QVBoxLayout(volumeBlock);
    // Observed block: 58px between separators, label at 8px, 16px slider handle at 34px.
    volumeLayout->setContentsMargins(8, 8, 5, 8);
    volumeLayout->setSpacing(7);
    auto* volumeTitle = new QLabel(spec.volumeTitle, volumeBlock);
    volumeTitle->setObjectName("audioOptionsVolumeTitle");
    volumeTitle->setFixedHeight(19);
    auto* slider = new QSlider(Qt::Horizontal, volumeBlock);
    slider->setObjectName("audioOptionsVolume");
    slider->setAccessibleName(spec.volumeTitle);
    slider->setRange(spec.volume->minimum(), spec.volume->maximum());
    slider->setValue(spec.volume->value());
    slider->setFixedHeight(16);
    QObject::connect(slider, &QSlider::valueChanged, spec.volume, [target = spec.volume](int value) { if (target) target->setValue(value); });
    volumeLayout->addWidget(volumeTitle);
    volumeLayout->addWidget(slider);
    volumeAction->setDefaultWidget(volumeBlock);
    menu->addAction(volumeAction);
    menu->addSeparator();

    auto* settingsRow = addRow(menu, "Configurações de voz", {}, DiscordIcons::IconType::Settings, MenuRow::Trailing::None, false, 36);
    QObject::connect(settingsRow, &QAction::triggered, menu, [open = spec.openVoiceSettings] { if (open) open(); });

    anchor->setMenuOpen(true);
    QObject::connect(menu, &QMenu::aboutToHide, anchor, [anchor] { anchor->setMenuOpen(false); });
    menu->ensurePolished();
    const QSize size = menu->sizeHint();
    // Observed: left edge aligned with the split control, 4px gap above it.
    // Observed (out/claude-observations/ANIMATIONS.md): opacity fades in, ~93% after ~65 ms with ease-out; closing is instant.
    menu->setWindowOpacity(0.0);
    menu->popup(anchor->mapToGlobal(QPoint(0, -size.height() - 4)));
    auto* fade = new QPropertyAnimation(menu, "windowOpacity", menu);
    fade->setDuration(kAudioMenuFadeInMs);
    fade->setStartValue(0.0);
    fade->setEndValue(1.0);
    fade->setEasingCurve(QEasingCurve::OutCubic);
    fade->start();
}

namespace {

// Header painted directly (no QSS) so the banner can bleed to the popover's edges while the menu itself
// keeps 0 padding for this widget's width. Colours: banner observed as solid black, the same tone used for
// the profile modal banner (CONTA_POPOVER.md); avatar ring uses the popover's own surface colour (#121214)
// so the avatar reads as cut out of the banner, matching the observed overlap without borrowing the
// theme-dark card colours (#323339/#3f4048) the capture itself was taken against — this build ships
// theme-midnight, so the card/body tones below use the already-resolved midnight equivalents
// (out/claude-observations/rea-css/AUDITORIA_CORES.md: #323339 -> #000000, #3f4048 kept as the nearest
// resolved neutral #121214 surface already used by every other triscord menu).
class AccountPopoverHeader : public QWidget {
public:
    AccountPopoverHeader(const QString& displayName, const QString& subtitle, bool online, QWidget* parent)
        : QWidget(parent), displayName_(displayName), subtitle_(subtitle), online_(online) {
        setFixedSize(300, 150);
        setAttribute(Qt::WA_TransparentForMouseEvents);
    }

protected:
    void paintEvent(QPaintEvent*) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        p.fillRect(QRect(0, 0, width(), 60), QColor("#000000"));
        const QRectF avatarRect(16, 28, 64, 64);
        p.setPen(Qt::NoPen);
        p.setBrush(QColor("#121214"));
        p.drawEllipse(avatarRect.adjusted(-4, -4, 4, 4));
        p.setBrush(QColor("#5865f2"));
        p.drawEllipse(avatarRect);
        QFont letter = font(); letter.setPixelSize(24); letter.setWeight(QFont::Bold);
        p.setFont(letter); p.setPen(Qt::white);
        p.drawText(avatarRect, Qt::AlignCenter, displayName_.left(1).toUpper());
        // Status dot reuses the same colours as MainWindow::updateUserProfile's connection dot (#23a55a
        // online / #81828a offline) rather than inventing Discord's online/idle/dnd/invisible picker, which
        // triscord has no backing state for.
        p.setPen(QPen(QColor("#121214"), 3));
        p.setBrush(QColor(online_ ? "#23a55a" : "#81828a"));
        p.drawEllipse(QRectF(avatarRect.right() - 17, avatarRect.bottom() - 17, 18, 18));
        QFont nameFont = font(); nameFont.setPixelSize(16); nameFont.setWeight(QFont::Bold);
        p.setFont(nameFont); p.setPen(QColor("#f2f3f5"));
        p.drawText(QRect(16, 100, width() - 32, 20), Qt::AlignLeft | Qt::AlignVCenter, displayName_);
        QFont subFont = font(); subFont.setPixelSize(13);
        p.setFont(subFont); p.setPen(QColor("#949ba4"));
        p.drawText(QRect(16, 122, width() - 32, 16), Qt::AlignLeft | Qt::AlignVCenter, subtitle_);
    }

private:
    QString displayName_, subtitle_;
    bool online_;
};

} // namespace

QMenu* buildAccountPopover(QWidget* anchor, const QString& displayName, const QString& subtitle, bool online,
                           bool signedIn, std::function<void()> onEditProfile, std::function<void()> onGoogleToggle) {
    auto* menu = new QMenu(anchor);
    menu->setObjectName("accountPopoverMenu");
    menu->setAttribute(Qt::WA_DeleteOnClose);
    menu->setStyleSheet(
        "QMenu#accountPopoverMenu { background:#121214; border:1px solid #4c4c51; border-radius:8px; padding:0px; }"
        "QMenu#accountPopoverMenu QWidget { background:transparent; }"
        "QMenu#accountPopoverMenu::separator { height:1px; background:#2d2d30; margin:6px 16px; }");
    repaintRowsOnHover(menu);

    auto* headerAction = new QWidgetAction(menu);
    headerAction->setDefaultWidget(new AccountPopoverHeader(displayName, subtitle, online, menu));
    menu->addAction(headerAction);
    menu->addSeparator();

    auto* editRow = addRow(menu, "Editar perfil", {}, DiscordIcons::IconType::Pencil, MenuRow::Trailing::None, false, 42, 300);
    QObject::connect(editRow, &QAction::triggered, menu, [cb = std::move(onEditProfile)] { if (cb) cb(); });
    menu->addSeparator();

    // No Google-branded glyph is in DiscordIcons; Group (a generic person icon) stands in for the account
    // row rather than fabricating a brand mark.
    auto* googleRow = addRow(menu, signedIn ? "Sair da conta Google" : "Entrar com Google", {},
                             DiscordIcons::IconType::Group, MenuRow::Trailing::None, false, 42, 300, signedIn);
    QObject::connect(googleRow, &QAction::triggered, menu, [cb = std::move(onGoogleToggle)] { if (cb) cb(); });

    return menu;
}

} // namespace triscord
