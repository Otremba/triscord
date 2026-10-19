#pragma once
#include <QObject>
#include <QString>

namespace triscord {

// Windows notification without Qt Widgets (the WebView2 client links only Qt Gui): a notification-area icon
// created with Shell_NotifyIconW, whose balloon Windows 10/11 shows as a toast. Clicking the toast or the icon
// emits activated(). The icon is added on the first message and removed when the notifier is destroyed.
// TRISCORD_NOTIFY_FILE (tests) appends "title\tbody" lines to that file instead of showing anything.
class WinNotifier final : public QObject {
    Q_OBJECT
public:
    explicit WinNotifier(QObject* parent = nullptr);
    ~WinNotifier() override;
    void show(const QString& title, const QString& body);
    // Keeps the icon in the notification area ("Minimizar para a bandeja"): a left click emits activated(); a right click
    // opens a menu with "Abrir o Triscord" (activated) and "Sair do Triscord" (quitRequested). Returns false when
    // Windows refused the icon (no shell yet), so the caller keeps the window reachable instead of hiding it. Switching
    // it off removes the icon until the next notification needs it.
    bool setResident(bool resident);
    bool hasIcon() const { return added_; }

signals:
    void activated();
    void quitRequested();

private:
    void removeIcon();
    void showMenu(int x, int y);
    bool resident_ = false;
    static long long __stdcall windowProc(void* window, unsigned message, unsigned long long wParam, long long lParam);
    void ensureIcon();
    void* window_ = nullptr;   // message-only HWND
    bool added_ = false;
};

} // namespace triscord
