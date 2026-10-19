#pragma once

#include <QAbstractButton>
#include <QStyledItemDelegate>
#include <QPixmap>
#include <QWidget>

class QLabel;
class QPushButton;

namespace triscord {

// Discord title bar observed at 1280x900, 96 DPI (desktop/out/claude-observations/NAVIGATION.md): 32px,
// centred 16px server icon + name, 32x32 window controls with 4px gaps. Back/forward, inbox and help
// have no triscord function and are not drawn.
class TitleBar : public QWidget {
    Q_OBJECT
public:
    explicit TitleBar(QWidget* parent = nullptr);
    void setContext(const QPixmap& icon, const QString& name);
    // True where the native window should treat the press as a caption drag.
    bool isCaption(const QPoint& local) const;
    void syncMaximized(bool maximized);

protected:
    void resizeEvent(QResizeEvent* event) override;

private:
    void layoutTitle();
    QWidget* titleGroup_;
    QLabel* icon_;
    QLabel* name_;
    QPushButton* minimize_;
    QPushButton* maximize_;
    QPushButton* close_;
};

// One server in the 72px rail: 40x40 icon (radius 12) at x=16 with the 4px white indicator at x=0
// (8px unread, 20px hover, 40px selected).
class ServerRailItem : public QAbstractButton {
    Q_OBJECT
public:
    ServerRailItem(const QPixmap& image, const QString& name, QWidget* parent = nullptr);
    void setSelected(bool selected) { selected_ = selected; update(); }
    bool isSelected() const { return selected_; }
    QSize sizeHint() const override { return {72, 40}; }

protected:
    void paintEvent(QPaintEvent*) override;
    bool hitButton(const QPoint& pos) const override;

private:
    QPixmap image_;
    bool selected_ = false;
};

// Channel list section observed in Discord ("Canais de Voz"): 42px block (41 + list spacing), 14px sentence-case title
// centred at y=28.5, 12px chevron 4px after it (right-pointing while collapsed), PlusSmall at the right
// with the tooltip "Criar canal". Hover turns the title white; clicking the title collapses the list.
class ChannelSectionHeader : public QWidget {
    Q_OBJECT
public:
    ChannelSectionHeader(const QString& title, QWidget* parent = nullptr);
    QPushButton* addButton() const { return add_; }
    bool isCollapsed() const { return collapsed_; }
signals:
    void collapsedChanged(bool collapsed);

protected:
    void paintEvent(QPaintEvent*) override;
    void mouseReleaseEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent*) override { update(); }
    void leaveEvent(QEvent*) override { update(); }
    bool eventFilter(QObject* watched, QEvent* event) override;
    void resizeEvent(QResizeEvent*) override;

private:
    QRect titleArea() const;
    QString title_;
    QPushButton* add_;
    bool collapsed_ = false;
    bool addHovered_ = false;
};

// Channel row painted as observed (see ChannelSectionHeader); IconRole holds a DiscordIcons::IconType.
// Voice channel row (32px) followed by the participants in that channel, as observed under a connected
// channel (CALLS.md, SIDEBAR.md): 24px avatar at +36 of the row box, 14px name 8px after it, 16px muted /
// deafened icons with 4px gaps ending 8px from the right edge. The connected channel's speaker is green.
class ChannelRowDelegate : public QStyledItemDelegate {
public:
    static constexpr int IconRole = Qt::UserRole + 20;
    static constexpr int VoiceUsersRole = Qt::UserRole + 21; // QJsonArray of {username, avatar, isMuted, isDeafened}
    static constexpr int ConnectedRole = Qt::UserRole + 22;
    static constexpr int RowHeight = 32, UsersTop = 2, UserHeight = 30, UsersBottom = 4;
    explicit ChannelRowDelegate(QObject* parent = nullptr);
    void paint(QPainter* painter, const QStyleOptionViewItem& option, const QModelIndex& index) const override;
    QSize sizeHint(const QStyleOptionViewItem& option, const QModelIndex& index) const override;
    // Participant rows are not part of the channel's click target (their profile popout has no equivalent).
    static void guardParticipantClicks(QAbstractItemView* view);
};

// "Adicionar um servidor" (NAVIGATION.md, SERVIDORES.md): 40x40 tile, radius 12, CirclePlus glyph (module
// 245604, 24px box). Rest: --background-mod-normal over the rail (#393a3f measured in theme-dark ->
// #1e1e20 in midnight) with a --text-default glyph (#f3f3f4 -> #d4d5d8). Hover: #5865f2 with a white
// glyph (observed). Tooltip "Adicionar um servidor" on the right.
class ServerRailAction : public QAbstractButton {
    Q_OBJECT
public:
    explicit ServerRailAction(const QString& name, QWidget* parent = nullptr);
    QSize sizeHint() const override { return {72, 40}; }

protected:
    void paintEvent(QPaintEvent*) override;
    bool hitButton(const QPoint& pos) const override;
};

class ServerRail : public QWidget {
    Q_OBJECT
public:
    explicit ServerRail(QWidget* parent = nullptr);
    ServerRailItem* addServer(const QPixmap& image, const QString& name);
    // Servers listed after the add button would be wrong: the button always stays last.
    ServerRailAction* addServerButton();
    // A server without an uploaded icon: Discord draws its acronym (HubApi::serverAcronym) on the tile
    // (observed "Sdc" for "Servidor de camargo": 40x40, #393a3f in theme-dark, #f3f3f4 text, cap height 12px).
    static QPixmap acronymTile(const QString& name, qreal devicePixelRatio = 2.0);

private:
    ServerRailAction* add_ = nullptr;
};

// Red notification badge observed on the real Discord client (desktop/out/claude-observations/BADGES.md):
// one digit draws a 16x16 circle, three digits draw a 30x16 pill (corner radius = height/2 = 8px in both
// cases). Two digits and 4+ were not captured there ("Desconhecido"); this widens the pill by measured text
// metrics instead of assuming an unobserved cap. Fill colour keeps the measured `#d22d39`/`#cf2d39` rather
// than the declared `--status-danger` token `#f23f43` (close but not identical per BADGES.md), matching the
// project's own precedent that a direct capture outweighs a token for the surface it measures
// (out/claude-observations/rea-css/AUDITORIA_CORES.md, bucket B).
class NotificationBadge : public QWidget {
    Q_OBJECT
public:
    explicit NotificationBadge(QWidget* parent = nullptr);
    void setCount(int count);
    int count() const { return count_; }

protected:
    void paintEvent(QPaintEvent*) override;

private:
    void relayout();
    int count_ = 0;
};

} // namespace triscord
