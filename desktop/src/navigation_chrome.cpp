#include "navigation_chrome.h"
#include "hub_api.h"

#include "account_panel.h"
#include "discord_icons.h"
#include "discord_tooltip.h"

#include <QCursor>
#include <QEvent>
#include <QMouseEvent>

#include <QAbstractItemView>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QJsonObject>
#include <QLabel>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QVBoxLayout>
#include <QWindow>
#include <algorithm>

namespace triscord {

namespace {

enum class Glyph { Minimize, Maximize, Close };

// Observed glyphs: 1px strokes in a 10x10 box at offset (11,11) of the 32x32 button; minimize at y=16.
QIcon windowGlyph(Glyph glyph, const QColor& color) {
    QIcon icon;
    for (int ratio : {1, 2}) {
        QPixmap px(32 * ratio, 32 * ratio);
        px.fill(Qt::transparent);
        px.setDevicePixelRatio(ratio);
        QPainter p(&px);
        p.setRenderHint(QPainter::Antialiasing, glyph == Glyph::Close);
        p.setPen(QPen(color, 1, Qt::SolidLine, Qt::FlatCap));
        switch (glyph) {
        case Glyph::Minimize: p.drawLine(QPointF(11, 16.5), QPointF(21, 16.5)); break;
        case Glyph::Maximize: p.drawRect(QRectF(11.5, 11.5, 9, 9)); break;
        case Glyph::Close:
            p.drawLine(QPointF(11, 11), QPointF(21, 21));
            p.drawLine(QPointF(21, 11), QPointF(11, 21));
            break;
        }
        p.end();
        icon.addPixmap(px);
    }
    return icon;
}

QPixmap rounded(const QPixmap& source, int size, qreal radius, qreal ratio) {
    QPixmap out(QSize(size, size) * ratio);
    out.fill(Qt::transparent);
    out.setDevicePixelRatio(ratio);
    QPainter p(&out);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);
    QPainterPath clip; clip.addRoundedRect(QRectF(0, 0, size, size), radius, radius);
    p.setClipPath(clip);
    p.drawPixmap(QRect(0, 0, size, size), source);
    return out;
}

} // namespace

TitleBar::TitleBar(QWidget* parent) : QWidget(parent) {
    setObjectName("titleBar");
    setAttribute(Qt::WA_StyledBackground);
    setFixedHeight(32);
    titleGroup_ = new QWidget(this);
    titleGroup_->setAttribute(Qt::WA_TransparentForMouseEvents);
    auto* group = new QHBoxLayout(titleGroup_);
    group->setContentsMargins(0, 0, 0, 0);
    group->setSpacing(8);
    icon_ = new QLabel(titleGroup_);
    icon_->setFixedSize(16, 16);
    name_ = new QLabel(titleGroup_);
    name_->setObjectName("titleBarName");
    group->addWidget(icon_);
    group->addWidget(name_);

    auto makeButton = [this](const char* name, Glyph glyph) {
        auto* button = new QPushButton(this);
        button->setObjectName(name);
        button->setFixedSize(32, 32);
        button->setIconSize(QSize(32, 32));
        button->setFocusPolicy(Qt::NoFocus);
        button->setIcon(windowGlyph(glyph, QColor("#96979e")));
        return button;
    };
    minimize_ = makeButton("windowMinimizeButton", Glyph::Minimize);
    maximize_ = makeButton("windowMaximizeButton", Glyph::Maximize);
    close_ = makeButton("windowCloseButton", Glyph::Close);
    // Observed close hover: red background with a white glyph.
    setHoverIcons(close_, windowGlyph(Glyph::Close, QColor("#96979e")), windowGlyph(Glyph::Close, Qt::white));
    connect(minimize_, &QPushButton::clicked, this, [this] { window()->showMinimized(); });
    connect(maximize_, &QPushButton::clicked, this, [this] {
        window()->isMaximized() ? window()->showNormal() : window()->showMaximized();
    });
    connect(close_, &QPushButton::clicked, this, [this] { window()->close(); });
}

void TitleBar::setContext(const QPixmap& icon, const QString& name) {
    const qreal ratio = devicePixelRatioF();
    icon_->setPixmap(rounded(icon, 16, 4, ratio));
    name_->setText(name);
    layoutTitle();
}

void TitleBar::syncMaximized(bool maximized) {
    // The restore glyph Discord uses while maximized was not observed; the square is kept.
    maximize_->setProperty("maximized", maximized);
}

bool TitleBar::isCaption(const QPoint& local) const {
    if (!rect().contains(local)) return false;
    for (auto* button : {minimize_, maximize_, close_})
        if (button->geometry().contains(local)) return false;
    return true;
}

void TitleBar::resizeEvent(QResizeEvent*) {
    const int right = width();
    close_->move(right - 32, 0);
    maximize_->move(right - 32 - 4 - 32, 0);
    minimize_->move(right - 3 * 32 - 2 * 4, 0);
    layoutTitle();
}

void TitleBar::layoutTitle() {
    titleGroup_->adjustSize();
    const QSize size = titleGroup_->sizeHint();
    // Observed: the icon + name group is centred on the window, not on the free space.
    titleGroup_->setGeometry((width() - size.width()) / 2, (height() - size.height()) / 2, size.width(), size.height());
}

ServerRailItem::ServerRailItem(const QPixmap& image, const QString& name, QWidget* parent)
    : QAbstractButton(parent), image_(image) {
    setObjectName("serverRailItem");
    setFixedSize(72, 40);
    setAttribute(Qt::WA_Hover);
    setCursor(Qt::PointingHandCursor);
    setToolTip(name);
    setAccessibleName(name);
    installDiscordTooltip(this, TooltipPlacement::Right);
}

bool ServerRailItem::hitButton(const QPoint& pos) const {
    return QRect(16, 0, 40, 40).contains(pos);
}

void ServerRailItem::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);
    const bool hovered = underMouse();
    const int pill = selected_ ? 40 : hovered ? 20 : 0;
    if (pill > 0) {
        QPainterPath path;
        path.addRoundedRect(QRectF(-4, (height() - pill) / 2.0, 8, pill), 4, 4);
        p.fillPath(path, Qt::white);
    }
    QPainterPath clip; clip.addRoundedRect(QRectF(16, 0, 40, 40), 12, 12);
    p.setClipPath(clip);
    p.drawPixmap(QRect(16, 0, 40, 40), image_);
}

ChannelSectionHeader::ChannelSectionHeader(const QString& title, QWidget* parent) : QWidget(parent), title_(title) {
    setObjectName("channelSectionHeader");
    // 42px observed block; the list adds 1px spacing above the first row.
    setFixedHeight(41);
    setAttribute(Qt::WA_Hover);
    setMouseTracking(true);
    setAccessibleName(title);
    add_ = new QPushButton(this);
    add_->setObjectName("createRoomButton");
    add_->setFixedSize(18, 18);
    add_->setIconSize(QSize(16, 16));
    add_->setCursor(Qt::PointingHandCursor);
    add_->setToolTip("Criar canal");
    setHoverIcons(add_, DiscordIcons::icon(DiscordIcons::IconType::PlusSmall, QColor("#96979e"), 16),
                  DiscordIcons::icon(DiscordIcons::IconType::PlusSmall, QColor("#dcdcdf"), 16));
    installDiscordTooltip(add_);
    add_->installEventFilter(this);
}

bool ChannelSectionHeader::eventFilter(QObject* watched, QEvent* event) {
    if (watched == add_ && (event->type() == QEvent::Enter || event->type() == QEvent::Leave)) {
        addHovered_ = event->type() == QEvent::Enter;
        update();
    }
    return QWidget::eventFilter(watched, event);
}

QRect ChannelSectionHeader::titleArea() const {
    // Title row centred on y=28.5 of the 42px block, text starting 16px from the sidebar edge.
    return QRect(0, 19, add_->x() - 4, 19);
}

void ChannelSectionHeader::resizeEvent(QResizeEvent*) {
    add_->move(width() - 16 - add_->width(), 20);
}

void ChannelSectionHeader::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    QFont f = font(); f.setPixelSize(14); f.setWeight(QFont::Medium);
    p.setFont(f);
    const bool hovered = underMouse() && titleArea().contains(mapFromGlobal(QCursor::pos()));
    const QColor color = hovered || addHovered_ ? QColor("#dcdcdf") : QColor("#96979e");
    const QFontMetrics fm(f);
    const QRect area = titleArea().adjusted(16, 0, 0, 0);
    const QString text = fm.elidedText(title_, Qt::ElideRight, area.width() - 16);
    p.setPen(color);
    p.drawText(area, Qt::AlignLeft | Qt::AlignVCenter, text);
    const int chevronX = area.left() + fm.horizontalAdvance(text) + 4;
    DiscordIcons::paint(&p, collapsed_ ? DiscordIcons::IconType::ChevronSmallRight : DiscordIcons::IconType::ChevronSmallDown,
                        QRectF(chevronX, area.center().y() - 5.5, 12, 12), color);
}

void ChannelSectionHeader::mouseReleaseEvent(QMouseEvent* event) {
    if (event->button() != Qt::LeftButton || !titleArea().contains(event->position().toPoint())) return;
    collapsed_ = !collapsed_;
    update();
    emit collapsedChanged(collapsed_);
}

ChannelRowDelegate::ChannelRowDelegate(QObject* parent) : QStyledItemDelegate(parent) {}

namespace {
int voiceUserCount(const QModelIndex& index) { return index.data(ChannelRowDelegate::VoiceUsersRole).toJsonArray().size(); }

class ParticipantClickGuard : public QObject {
public:
    explicit ParticipantClickGuard(QAbstractItemView* view) : QObject(view), view_(view) {}
protected:
    bool eventFilter(QObject*, QEvent* event) override {
        const auto type = event->type();
        if (type == QEvent::MouseMove || type == QEvent::Leave) { view_->viewport()->update(); return false; }
        if (type != QEvent::MouseButtonPress && type != QEvent::MouseButtonRelease && type != QEvent::MouseButtonDblClick) return false;
        const QPoint pos = static_cast<QMouseEvent*>(event)->position().toPoint();
        const QModelIndex index = view_->indexAt(pos);
        return index.isValid() && pos.y() >= view_->visualRect(index).top() + ChannelRowDelegate::RowHeight;
    }
private:
    QAbstractItemView* view_;
};
} // namespace

void ChannelRowDelegate::guardParticipantClicks(QAbstractItemView* view) {
    view->viewport()->installEventFilter(new ParticipantClickGuard(view));
}

QSize ChannelRowDelegate::sizeHint(const QStyleOptionViewItem&, const QModelIndex& index) const {
    const int users = voiceUserCount(index);
    return {0, RowHeight + (users ? UsersTop + users * UserHeight + UsersBottom : 0)};
}

void ChannelRowDelegate::paint(QPainter* p, const QStyleOptionViewItem& option, const QModelIndex& index) const {
    p->save();
    p->setRenderHint(QPainter::Antialiasing);
    // Observed rows: 32px, inset 8px on both sides of the list, radius 8; hover ~6% and selected ~10%
    // white over the background (black-theme values), icon box at +3 with a 20px glyph, name at +34.
    const QRect row = QRect(option.rect.left(), option.rect.top(), option.rect.width(), RowHeight).adjusted(8, 0, -8, 0);
    const bool selected = option.state & QStyle::State_Selected;
    // Hover highlights the channel row only, not the participants below it.
    const auto* view = qobject_cast<const QAbstractItemView*>(option.widget);
    const bool hovered = (option.state & QStyle::State_MouseOver)
        && (!view || view->viewport()->mapFromGlobal(QCursor::pos()).y() <= row.bottom());
    if (selected || hovered) {
        QPainterPath bg; bg.addRoundedRect(QRectF(row), 8, 8);
        p->fillPath(bg, selected ? QColor("#414248") : QColor(151, 151, 159, 31));
    }
    const QColor fg = selected || hovered ? QColor("#dcdcdf") : QColor("#96979e");
    const auto type = static_cast<DiscordIcons::IconType>(index.data(IconRole).toInt());
    // Observed: the connected channel's speaker turns green (#7ecb94 over the selected row).
    DiscordIcons::paint(p, type, QRectF(row.left() + 5, row.top() + 6, 20, 20), index.data(ConnectedRole).toBool() ? QColor("#7ecb94") : fg);
    QFont f = option.font; f.setPixelSize(16); f.setWeight(QFont::Medium);
    p->setFont(f);
    p->setPen(fg);
    const QRect textRect(row.left() + 34, row.top(), row.width() - 34 - 8, row.height());
    p->drawText(textRect, Qt::AlignLeft | Qt::AlignVCenter,
                QFontMetrics(f).elidedText(index.data(Qt::DisplayRole).toString(), Qt::ElideRight, textRect.width()));

    const auto users = index.data(VoiceUsersRole).toJsonArray();
    QFont nameFont = option.font; nameFont.setPixelSize(14); nameFont.setWeight(QFont::Medium);
    const QColor muted("#96979e");
    for (int n = 0; n < users.size(); ++n) {
        const auto user = users.at(n).toObject();
        const QRect line(row.left(), row.bottom() + 1 + UsersTop + n * UserHeight, row.width(), UserHeight);
        const QRect avatar(line.left() + 36, line.top() + 3, 24, 24);
        // triscord avatars are the coloured initial used everywhere else in the app.
        QColor color(user.value("avatar").toString()); if (!color.isValid()) color = QColor("#5865f2");
        p->setPen(Qt::NoPen); p->setBrush(color); p->drawEllipse(avatar);
        QFont initialFont = option.font; initialFont.setPixelSize(11); initialFont.setWeight(QFont::Bold);
        p->setFont(initialFont); p->setPen(Qt::white);
        const QString name = user.value("username").toString();
        p->drawText(avatar, Qt::AlignCenter, name.left(1).toUpper());
        int iconsLeft = line.right() + 1 - 8;
        // Observed: a red "AO VIVO" badge (61x16, radius 4) ends the row while the participant streams.
        if (user.value("isScreenSharing").toBool()) {
            QFont badge = option.font; badge.setPixelSize(11); badge.setWeight(QFont::Bold);
            const QRect box(iconsLeft - 61, line.top() + 7, 61, 16);
            QPainterPath path; path.addRoundedRect(QRectF(box), 4, 4);
            p->fillPath(path, QColor("#d22d39")); p->setFont(badge); p->setPen(Qt::white);
            p->drawText(box, Qt::AlignCenter, "AO VIVO");
            iconsLeft -= 61 + 4;
        }
        QList<DiscordIcons::IconType> states;
        if (user.value("isMuted").toBool() || user.value("isDeafened").toBool()) states << DiscordIcons::IconType::MicrophoneMuted;
        if (user.value("isDeafened").toBool()) states << DiscordIcons::IconType::HeadphonesDeafened;
        if (user.value("isCameraOn").toBool()) states << DiscordIcons::IconType::Video;
        for (int s = states.size() - 1; s >= 0; --s) {
            iconsLeft -= 16;
            DiscordIcons::paint(p, states[s], QRectF(iconsLeft, line.top() + 7, 16, 16), muted);
            iconsLeft -= 4;
        }
        p->setFont(nameFont); p->setPen(muted);
        const QRect nameRect(avatar.right() + 1 + 8, line.top(), iconsLeft - avatar.right() - 8 - 4, line.height());
        p->drawText(nameRect, Qt::AlignLeft | Qt::AlignVCenter, QFontMetrics(nameFont).elidedText(name, Qt::ElideRight, nameRect.width()));
    }
    p->restore();
}

ServerRail::ServerRail(QWidget* parent) : QWidget(parent) {
    setObjectName("serverRail");
    setAttribute(Qt::WA_StyledBackground);
    setFixedWidth(72);
    auto* layout = new QVBoxLayout(this);
    // Observed: the first rail item starts directly below the title bar; items are spaced 8px.
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(8);
    layout->addStretch(1);
}

ServerRailItem* ServerRail::addServer(const QPixmap& image, const QString& name) {
    auto* item = new ServerRailItem(image, name, this);
    auto* box = static_cast<QVBoxLayout*>(layout());
    box->insertWidget(add_ ? box->indexOf(add_) : box->count() - 1, item);
    return item;
}

ServerRailAction* ServerRail::addServerButton() {
    if (add_) return add_;
    add_ = new ServerRailAction("Adicionar um servidor", this);
    auto* box = static_cast<QVBoxLayout*>(layout());
    box->insertWidget(box->count() - 1, add_);
    return add_;
}

QPixmap ServerRail::acronymTile(const QString& name, qreal devicePixelRatio) {
    QPixmap tile(QSize(40, 40) * devicePixelRatio);
    tile.setDevicePixelRatio(devicePixelRatio);
    tile.fill(QColor("#1e1e20"));
    QPainter p(&tile);
    p.setRenderHint(QPainter::TextAntialiasing);
    QFont f = p.font();
    f.setPixelSize(16);
    f.setWeight(QFont::Medium);
    const auto acronym = HubApi::serverAcronym(name);
    // Long acronyms shrink to stay inside the tile; only the 3-letter case was observed.
    while (f.pixelSize() > 10 && QFontMetrics(f).horizontalAdvance(acronym) > 34) f.setPixelSize(f.pixelSize() - 1);
    p.setFont(f);
    p.setPen(QColor("#d4d5d8"));
    p.drawText(QRect(0, 0, 40, 40), Qt::AlignCenter, acronym);
    return tile;
}

ServerRailAction::ServerRailAction(const QString& name, QWidget* parent) : QAbstractButton(parent) {
    setObjectName("addServerButton");
    setFixedSize(72, 40);
    setAttribute(Qt::WA_Hover);
    setCursor(Qt::PointingHandCursor);
    setToolTip(name);
    setAccessibleName(name);
    installDiscordTooltip(this, TooltipPlacement::Right);
}

bool ServerRailAction::hitButton(const QPoint& pos) const {
    return QRect(16, 0, 40, 40).contains(pos);
}

void ServerRailAction::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    const bool hovered = underMouse() || isDown();
    QPainterPath tile; tile.addRoundedRect(QRectF(16, 0, 40, 40), 12, 12);
    p.fillPath(tile, hovered ? QColor("#5865f2") : QColor("#1e1e20"));
    p.drawPixmap(QRect(24, 8, 24, 24), DiscordIcons::pixmap(DiscordIcons::IconType::CirclePlus,
        hovered ? Qt::white : QColor("#d4d5d8"), 24, qMax(1, qRound(devicePixelRatioF()))));
}

NotificationBadge::NotificationBadge(QWidget* parent) : QWidget(parent) {
    setObjectName("notificationBadge");
    setAttribute(Qt::WA_TransparentForMouseEvents);
    setAttribute(Qt::WA_TranslucentBackground);
    setFixedSize(16, 16);
    hide();
}

void NotificationBadge::relayout() {
    const QString text = count_ > 999 ? QStringLiteral("999+") : QString::number(count_);
    QFont f; f.setPixelSize(11); f.setBold(true);
    const int textWidth = QFontMetrics(f).horizontalAdvance(text);
    // Observed: a single digit stays a 16x16 circle; 3 digits measured 30px wide. Not independently
    // measured for 2 or 4+ digits, so the pill is widened from the single-digit case by actual text
    // metrics rather than guessing a specific width.
    const int width = text.size() <= 1 ? 16 : std::max(16, textWidth + 12);
    setFixedSize(width, 16);
}

void NotificationBadge::setCount(int count) {
    count_ = count;
    if (count_ <= 0) { hide(); return; }
    relayout();
    show();
    raise();
    update();
}

void NotificationBadge::paintEvent(QPaintEvent*) {
    if (count_ <= 0) return;
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setPen(Qt::NoPen);
    p.setBrush(QColor("#d22d39"));
    p.drawRoundedRect(rect(), 8, 8);
    QFont f = font(); f.setPixelSize(11); f.setBold(true);
    p.setFont(f);
    p.setPen(Qt::white);
    const QString text = count_ > 999 ? QStringLiteral("999+") : QString::number(count_);
    p.drawText(rect(), Qt::AlignCenter, text);
}

} // namespace triscord
