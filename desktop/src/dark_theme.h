#pragma once
#include <QApplication>
#include <QPalette>
#include <QStyleHints>

namespace triscord {
inline void applyDarkTheme() {
    QApplication::styleHints()->setColorScheme(Qt::ColorScheme::Dark);
    QApplication::setStyle("Fusion");
    QPalette palette;
    palette.setColor(QPalette::Window, QColor("#000000"));
    palette.setColor(QPalette::WindowText, QColor("#d4d5d8"));
    palette.setColor(QPalette::Base, QColor("#000000"));
    palette.setColor(QPalette::AlternateBase, QColor("#111214"));
    palette.setColor(QPalette::Text, QColor("#d4d5d8"));
    palette.setColor(QPalette::Button, QColor("#1e1f22"));
    palette.setColor(QPalette::ButtonText, QColor("#d4d5d8"));
    palette.setColor(QPalette::ToolTipBase, QColor("#111214"));
    palette.setColor(QPalette::ToolTipText, QColor("#d4d5d8"));
    palette.setColor(QPalette::Highlight, QColor("#5865f2"));
    palette.setColor(QPalette::HighlightedText, QColor("#dcdcdf"));
    palette.setColor(QPalette::Link, QColor("#2781e7"));
    palette.setColor(QPalette::LinkVisited, QColor("#c28cfc"));
    palette.setColor(QPalette::PlaceholderText, QColor("#81828a"));
    for (auto role : {QPalette::Text, QPalette::WindowText, QPalette::ButtonText})
        palette.setColor(QPalette::Disabled, role, QColor("#4d505b"));
    QApplication::setPalette(palette);
}
}
