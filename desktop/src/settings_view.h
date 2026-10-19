#pragma once

#include <QCheckBox>
#include <QStyledItemDelegate>
#include <QWidget>

class QLabel;
class QListWidget;
class QScrollArea;
class QVBoxLayout;

namespace triscord {

// Settings components observed in Discord's user settings modal (desktop/out/claude-observations/SETTINGS.md).

// 48x24 switch, radius 12, 16px knob; accent track when on.
class SettingsToggle : public QCheckBox {
    Q_OBJECT
public:
    explicit SettingsToggle(QWidget* parent = nullptr);
    QSize sizeHint() const override { return {48, 24}; }
protected:
    void paintEvent(QPaintEvent*) override;
    bool hitButton(const QPoint& pos) const override { return rect().contains(pos); }
};

// One settings row: 16px semibold label, optional 14px description, control on the right.
QWidget* settingsRow(QWidget* parent, const QString& label, const QString& description, QWidget* control);
// Section heading (about 20px semibold) that starts a scroll anchor.
QLabel* settingsHeading(QWidget* parent, const QString& text);
// 1px divider between sections.
QWidget* settingsDivider(QWidget* parent);

// Nav rows: kind Category (icon + 16px text, 36px, radius 8 selection), Section (14px muted label),
// Sub (indented anchor with the left rail; active segment white).
class SettingsNavDelegate : public QStyledItemDelegate {
public:
    enum Kind { Category = 0, Section = 1, Sub = 2 };
    static constexpr int KindRole = Qt::UserRole + 40;
    static constexpr int IconRole = Qt::UserRole + 41;
    static constexpr int ActiveRole = Qt::UserRole + 42;
    using QStyledItemDelegate::QStyledItemDelegate;
    void paint(QPainter* painter, const QStyleOptionViewItem& option, const QModelIndex& index) const override;
    QSize sizeHint(const QStyleOptionViewItem& option, const QModelIndex& index) const override;
};

} // namespace triscord
