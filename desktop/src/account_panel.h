#pragma once

#include <QComboBox>
#include <QLabel>
#include <QPointer>
#include <QPushButton>
#include <QSlider>
#include <QMenu>
#include <QWidget>
#include <functional>
#include <optional>

#include "discord_icons.h"

namespace triscord {

// Label that elides with "…" instead of being clipped when the panel narrows.
class ElidedLabel : public QLabel {
public:
    using QLabel::QLabel;
    QSize minimumSizeHint() const override { return {0, QLabel::minimumSizeHint().height()}; }
protected:
    void paintEvent(QPaintEvent*) override;
};

// Toggle + "options" chevron pair observed in the Discord account panel
// (desktop/out/claude-observations/ACCOUNT_PANEL.md): 32px toggle, 1px divider, 16px chevron.
class SplitAudioButton : public QWidget {
    Q_OBJECT
public:
    SplitAudioButton(const QString& objectName, QWidget* parent = nullptr);
    QPushButton* toggle() const { return toggle_; }
    QPushButton* options() const { return options_; }
    // Muted/deafened: both halves keep the red tint, not only on hover.
    void setActive(bool active);
    void setMenuOpen(bool open);

protected:
    // QSS does not evaluate :hover on ancestors, so the observed group hover uses a property.
    bool event(QEvent* event) override;

private:
    void repolish(const char* property, const QVariant& value);
    void refreshChevron();
    QPushButton* toggle_;
    QWidget* divider_;
    QPushButton* options_;
    bool active_ = false;
    bool menuOpen_ = false;
};

// Keeps panel floating over the bottom of column with the given margin (observed account panel).
void floatAtBottom(QWidget* panel, QWidget* column, int margin);

// Reports when the pointer enters or leaves widget (children included).
void watchHover(QWidget* widget, std::function<void(bool hovered)> changed);

// QPushButton paints QIcon::Normal even when hovered; swap the observed hover colour explicitly.
void setHoverIcons(QPushButton* button, const QIcon& normal, const QIcon& hover);

struct AudioOptionsSpec {
    QString deviceTitle;          // "Dispositivo de entrada" / "Dispositivo de saída"
    QString volumeTitle;          // "Volume de entrada" / "Volume de saída"
    QPointer<QComboBox> devices;  // Settings combo that owns device choice and persistence.
    QPointer<QSlider> volume;     // Settings slider that owns volume and persistence.
    std::function<void()> openVoiceSettings;
};

enum class DiscordMenuTrailing { None, Chevron, Checkbox };

// Menu surface and rows observed in Discord's popups and context menus (#121214, 8px padding, 36px rows).
QMenu* createDiscordMenu(QWidget* parent);
QAction* addDiscordMenuRow(QMenu* menu, const QString& title, std::optional<DiscordIcons::IconType> icon = std::nullopt,
                           DiscordMenuTrailing trailing = DiscordMenuTrailing::None, bool checked = false, bool danger = false);
void addDiscordMenuSlider(QMenu* menu, const QString& title, int minimum, int maximum, int value,
                          const QString& objectName, std::function<void(int)> changed);

// Opens the input/output options popup above the chevron, as observed in Discord.
void showAudioOptionsMenu(SplitAudioButton* anchor, const AudioOptionsSpec& spec);

// Account popover reconstructed from the real Discord capture (desktop/out/claude-observations/CONTA_POPOVER.md):
// ~300px wide, black banner with the avatar overlapping it, display name + username line, then only the rows
// that map to something real triscord has. Discord's "200 Orbs" (virtual currency) and "Mudar de conta"
// (multi-account) have no triscord equivalent and are not drawn; Discord's "Invisível" manual presence picker
// is also left out because triscord has no manual presence state — its only "status" is the automatic
// online/offline dot already painted by MainWindow::updateUserProfile, which is what `online` reflects here.
// `username` is triscord's single identity string shown twice (as both the bold name and, reused from the
// existing account row, the "@online"/"@offline" line) since triscord has no separate display-name/handle pair.
QMenu* buildAccountPopover(QWidget* anchor, const QString& displayName, const QString& subtitle, bool online,
                           bool signedIn, std::function<void()> onEditProfile, std::function<void()> onGoogleToggle);

} // namespace triscord
