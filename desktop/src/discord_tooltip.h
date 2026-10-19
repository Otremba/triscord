#pragma once

#include <QWidget>

namespace triscord {

// Tooltip shapes observed in Discord (desktop/out/claude-observations/ACCOUNT_PANEL.md, NAVIGATION.md).
// Above: 14px semibold, 8px/12px padding, centred above the target, 12x6 arrow ending 5px above it.
// Right (server rail): 16px bold, 36px body, 6x12 arrow pointing left, tip 6px right of the target.
// The widget's own toolTip() text is shown; native tooltips for it are suppressed.
// Below (voice view "Mostrar chat"): the Above shape mirrored; its exact gap was not measured.
enum class TooltipPlacement { Above, Right, Below };
void installDiscordTooltip(QWidget* target, TooltipPlacement placement = TooltipPlacement::Above);

} // namespace triscord
