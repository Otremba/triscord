#include "win_notifier.h"

#include <QFile>
#include <QtGlobal>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <shellapi.h>
#include <windowsx.h>

namespace triscord {
namespace {
constexpr UINT kCallback = WM_APP + 41;
constexpr UINT kIconId = 1;
const wchar_t* kClass = L"TriscordNotifier";
constexpr UINT kMenuOpen = 1, kMenuQuit = 2;

// Explorer announces itself again after it restarts; the notification-area icons are gone by then and must be re-added.
UINT taskbarCreatedMessage() {
    static const UINT message = RegisterWindowMessageW(L"TaskbarCreated");
    return message;
}

void copy(wchar_t* target, size_t capacity, const QString& text) {
    const auto wide = text.left(int(capacity) - 1).toStdWString();
    wcsncpy_s(target, capacity, wide.c_str(), _TRUNCATE);
}
} // namespace

WinNotifier::WinNotifier(QObject* parent) : QObject(parent) {
    WNDCLASSEXW cls{};
    cls.cbSize = sizeof(cls);
    cls.lpfnWndProc = reinterpret_cast<WNDPROC>(&WinNotifier::windowProc);
    cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = kClass;
    RegisterClassExW(&cls);   // fails harmlessly when already registered
    window_ = CreateWindowExW(0, kClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, cls.hInstance, nullptr);
    if (window_) SetWindowLongPtrW(static_cast<HWND>(window_), GWLP_USERDATA, reinterpret_cast<LONG_PTR>(this));
}

WinNotifier::~WinNotifier() {
    removeIcon();
    if (window_) DestroyWindow(static_cast<HWND>(window_));
}

void WinNotifier::removeIcon() {
    if (!added_) return;
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data); data.hWnd = static_cast<HWND>(window_); data.uID = kIconId;
    Shell_NotifyIconW(NIM_DELETE, &data);
    added_ = false;
}

bool WinNotifier::setResident(bool resident) {
    resident_ = resident;
    if (resident) {
        // Tests (TRISCORD_NOTIFY_FILE) never put an icon in the user's notification area.
        if (!qEnvironmentVariable("TRISCORD_NOTIFY_FILE").isEmpty()) return false;
        ensureIcon();
        return added_;
    }
    removeIcon();
    return true;
}

void WinNotifier::showMenu(int x, int y) {
    const auto hwnd = static_cast<HWND>(window_);
    HMENU menu = CreatePopupMenu();
    if (!menu) return;
    AppendMenuW(menu, MF_STRING, kMenuOpen, L"Abrir o Triscord");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, kMenuQuit, L"Sair do Triscord");
    // The menu closes on a click elsewhere only when its owner is the foreground window.
    SetForegroundWindow(hwnd);
    const UINT chosen = static_cast<UINT>(TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_NONOTIFY, x, y, 0, hwnd, nullptr));
    PostMessageW(hwnd, WM_NULL, 0, 0);
    DestroyMenu(menu);
    if (chosen == kMenuOpen) emit activated();
    else if (chosen == kMenuQuit) emit quitRequested();
}

void WinNotifier::ensureIcon() {
    if (added_ || !window_) return;
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = static_cast<HWND>(window_);
    data.uID = kIconId;
    data.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE;
    data.uCallbackMessage = kCallback;
    // The executable's own icon when it has one (resource 1), else the generic application icon.
    data.hIcon = LoadIconW(GetModuleHandleW(nullptr), MAKEINTRESOURCEW(1));
    if (!data.hIcon) data.hIcon = LoadIconW(nullptr, IDI_APPLICATION);
    copy(data.szTip, ARRAYSIZE(data.szTip), "Triscord");
    added_ = Shell_NotifyIconW(NIM_ADD, &data);
    if (added_) { data.uVersion = NOTIFYICON_VERSION_4; Shell_NotifyIconW(NIM_SETVERSION, &data); }
}

void WinNotifier::show(const QString& title, const QString& body) {
    if (const auto path = qEnvironmentVariable("TRISCORD_NOTIFY_FILE"); !path.isEmpty()) {
        QFile file(path);
        if (file.open(QIODevice::Append | QIODevice::Text)) file.write((title + '\t' + body + '\n').toUtf8());
        return;
    }
    ensureIcon();
    if (!added_) return;
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = static_cast<HWND>(window_);
    data.uID = kIconId;
    data.uFlags = NIF_INFO;
    data.dwInfoFlags = NIIF_INFO;
    copy(data.szInfoTitle, ARRAYSIZE(data.szInfoTitle), title);
    copy(data.szInfo, ARRAYSIZE(data.szInfo), body.isEmpty() ? QStringLiteral(" ") : body);
    Shell_NotifyIconW(NIM_MODIFY, &data);
}

long long __stdcall WinNotifier::windowProc(void* window, unsigned message, unsigned long long wParam, long long lParam) {
    const auto hwnd = static_cast<HWND>(window);
    if (message == kCallback) {
        // NOTIFYICON_VERSION_4: the event is in LOWORD(lParam).
        const UINT event = LOWORD(lParam);
        auto* self = reinterpret_cast<WinNotifier*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        if (!self) return 0;
        if (event == NIN_BALLOONUSERCLICK || event == WM_LBUTTONUP || event == NIN_SELECT) emit self->activated();
        else if (event == WM_CONTEXTMENU && self->resident_) self->showMenu(GET_X_LPARAM(wParam), GET_Y_LPARAM(wParam));
        return 0;
    }
    if (message == taskbarCreatedMessage()) {
        if (auto* self = reinterpret_cast<WinNotifier*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA))) {
            self->added_ = false;
            if (self->resident_) self->ensureIcon();
        }
        return 0;
    }
    return DefWindowProcW(hwnd, message, wParam, lParam);
}

} // namespace triscord
