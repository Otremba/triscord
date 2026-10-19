#pragma once

#include <QPoint>
#include <QtGlobal>
#include <functional>

class QWidget;

namespace triscord {

// Frameless top-level window that keeps the native resize borders, snapping, minimise/maximise
// animations and the system menu. The custom title bar answers which client points are caption.
void enableNativeFrame(QWidget* window);
bool handleNativeFrameMessage(QWidget* window, void* message, qintptr* result,
                              const std::function<bool(const QPoint& clientLogical)>& isCaption);

} // namespace triscord
