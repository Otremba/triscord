#include "capture_types.h"
#include <windows.h>
#include <dwmapi.h>

namespace triscord {
QSize previewSize(QSize source) {
    if (source.width() < 1 || source.height() < 1 || source.width() > 16384 || source.height() > 16384) return {};
    return source.boundedTo(source.scaled(640, 360, Qt::KeepAspectRatio)).expandedTo(QSize(1, 1));
}
QVector<CaptureSource> captureSources() {
    QVector<CaptureSource> result;
    EnumDisplayMonitors(nullptr, nullptr, [](HMONITOR monitor, HDC, LPRECT, LPARAM data) -> BOOL {
        auto& sources = *reinterpret_cast<QVector<CaptureSource>*>(data);
        MONITORINFOEXW info{}; info.cbSize = sizeof(info);
        if (GetMonitorInfoW(monitor, &info))
            sources.push_back({CaptureSource::Kind::Monitor, reinterpret_cast<quintptr>(monitor), 0,
                QString("Monitor — %1").arg(QString::fromWCharArray(info.szDevice))});
        return TRUE;
    }, reinterpret_cast<LPARAM>(&result));
    EnumWindows([](HWND window, LPARAM data) -> BOOL {
        if (window == GetShellWindow() || window == GetDesktopWindow()) return TRUE;
        if (!IsWindowVisible(window) || IsIconic(window) || (GetWindowLongPtrW(window, GWL_EXSTYLE) & WS_EX_TOOLWINDOW)) return TRUE;
        DWORD process = 0; GetWindowThreadProcessId(window, &process);
        if (!process || process == GetCurrentProcessId()) return TRUE;
        DWORD cloaked = 0;
        if (SUCCEEDED(DwmGetWindowAttribute(window, DWMWA_CLOAKED, &cloaked, sizeof(cloaked))) && cloaked) return TRUE;
        wchar_t title[512]{};
        if (!GetWindowTextW(window, title, 512)) return TRUE;
        auto& sources = *reinterpret_cast<QVector<CaptureSource>*>(data);
        sources.push_back({CaptureSource::Kind::Window, reinterpret_cast<quintptr>(window), process,
            "Janela — " + QString::fromWCharArray(title)});
        return TRUE;
    }, reinterpret_cast<LPARAM>(&result));
    return result;
}
}
