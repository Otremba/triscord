#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include "native_frame.h"

#include <QWidget>

#ifdef Q_OS_WIN
#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#endif

namespace triscord {

#ifdef Q_OS_WIN
namespace {
int frameThickness(HWND hwnd, bool vertical) {
    const UINT dpi = GetDpiForWindow(hwnd);
    return GetSystemMetricsForDpi(vertical ? SM_CYSIZEFRAME : SM_CXSIZEFRAME, dpi)
         + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, dpi);
}
}
#endif

void enableNativeFrame(QWidget* window) {
#ifdef Q_OS_WIN
    auto hwnd = reinterpret_cast<HWND>(window->winId());
    const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    SetWindowLongPtrW(hwnd, GWL_STYLE, style | WS_THICKFRAME | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
    const MARGINS shadow{0, 0, 1, 0};
    DwmExtendFrameIntoClientArea(hwnd, &shadow);
    SetWindowPos(hwnd, nullptr, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
#else
    Q_UNUSED(window);
#endif
}

bool handleNativeFrameMessage(QWidget* window, void* message, qintptr* result,
                              const std::function<bool(const QPoint&)>& isCaption) {
#ifdef Q_OS_WIN
    auto* msg = static_cast<MSG*>(message);
    if (msg->message == WM_NCCALCSIZE && msg->wParam) {
        // The whole window is client area; when maximised Windows oversizes the window by the frame.
        if (IsZoomed(msg->hwnd)) {
            auto* params = reinterpret_cast<NCCALCSIZE_PARAMS*>(msg->lParam);
            const int x = frameThickness(msg->hwnd, false), y = frameThickness(msg->hwnd, true);
            params->rgrc[0].left += x; params->rgrc[0].right -= x;
            params->rgrc[0].top += y; params->rgrc[0].bottom -= y;
        }
        *result = 0;
        return true;
    }
    if (msg->message == WM_NCHITTEST) {
        POINT pt{GET_X_LPARAM(msg->lParam), GET_Y_LPARAM(msg->lParam)};
        RECT wr; GetWindowRect(msg->hwnd, &wr);
        if (!IsZoomed(msg->hwnd)) {
            const int bx = frameThickness(msg->hwnd, false), by = frameThickness(msg->hwnd, true);
            const bool left = pt.x < wr.left + bx, right = pt.x >= wr.right - bx;
            const bool top = pt.y < wr.top + by, bottom = pt.y >= wr.bottom - by;
            if (top && left) { *result = HTTOPLEFT; return true; }
            if (top && right) { *result = HTTOPRIGHT; return true; }
            if (bottom && left) { *result = HTBOTTOMLEFT; return true; }
            if (bottom && right) { *result = HTBOTTOMRIGHT; return true; }
            if (left) { *result = HTLEFT; return true; }
            if (right) { *result = HTRIGHT; return true; }
            if (top) { *result = HTTOP; return true; }
            if (bottom) { *result = HTBOTTOM; return true; }
        }
        ScreenToClient(msg->hwnd, &pt);
        const qreal ratio = window->devicePixelRatioF();
        const QPoint logical(qRound(pt.x / ratio), qRound(pt.y / ratio));
        *result = isCaption(logical) ? HTCAPTION : HTCLIENT;
        return true;
    }
#else
    Q_UNUSED(window); Q_UNUSED(message); Q_UNUSED(result); Q_UNUSED(isCaption);
#endif
    return false;
}

} // namespace triscord
