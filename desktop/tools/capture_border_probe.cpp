// Dev tool: does a monitor capture draw Windows' yellow border? Captures the first monitor for 3 s and meanwhile
// counts yellow pixels along its outer 4 px with GDI (18/10: the border bothered the user). Prints counts only.
#include "capture_native.h"
#include <QCoreApplication>
#include <QThread>
#include <cstdio>
#include <windows.h>

using namespace triscord;
static int yellowEdge(const RECT& r) {
    const int w = r.right - r.left, h = r.bottom - r.top;
    HDC screen = GetDC(nullptr), memory = CreateCompatibleDC(screen);
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(info.bmiHeader); info.bmiHeader.biWidth = w; info.bmiHeader.biHeight = -h;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32;
    void* bits = nullptr; HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    auto* old = SelectObject(memory, bitmap);
    BitBlt(memory, 0, 0, w, h, screen, r.left, r.top, SRCCOPY | CAPTUREBLT); GdiFlush();
    int count = 0; const auto* px = static_cast<const unsigned char*>(bits);
    for (int y = 0; y < h; ++y) for (int x = 0; x < w; ++x) {
        if (x > 3 && x < w - 4 && y > 3 && y < h - 4) continue;
        const auto* p = px + (y * w + x) * 4;   // BGRA
        if (p[2] > 200 && p[1] > 150 && p[0] < 90) ++count;
    }
    SelectObject(memory, old); DeleteObject(bitmap); DeleteDC(memory); ReleaseDC(nullptr, screen);
    return count;
}
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    HMONITOR monitor = MonitorFromPoint({0, 0}, MONITOR_DEFAULTTOPRIMARY);
    MONITORINFO mi{}; mi.cbSize = sizeof(mi); GetMonitorInfoW(monitor, &mi);
    const int before = yellowEdge(mi.rcMonitor);
    CaptureSource source; source.kind = CaptureSource::Kind::Monitor; source.handle = reinterpret_cast<quintptr>(monitor);
    NativeCapture capture(source, 30);
    int frames = 0, during = 0;
    for (int i = 0; i < 60; ++i) { if (capture.next()) ++frames; QThread::msleep(50); if (i == 40) during = yellowEdge(mi.rcMonitor); }
    std::printf("yellow edge pixels: before %d, during capture %d (frames %d, gdi %d)\n", before, during, frames, int(capture.usingGdi()));
    return 0;
}
