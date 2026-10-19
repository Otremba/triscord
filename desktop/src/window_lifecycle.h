#pragma once
#include <QObject>
#include <QSettings>
#include <QString>
#include <QStringList>
#include <memory>

class QLocalServer;

namespace triscord {

// Passed by the login item so a start at Windows logon can stay in the tray ("Abrir minimizado").
inline constexpr const char* kStartupArgument = "--startup";
bool launchedAtLogin(const QStringList& arguments);

// Window behaviour the user chooses in Configurações › Configurações do Windows (Discord's "Minimizar para a bandeja"
// and "Abrir minimizado"). Kept in the same QSettings as every other preference.
struct WindowPrefs {
    bool closeToTray = true;      // the close button hides the window; the call and the voice keep running
    bool startMinimized = false;  // a start at logon (kStartupArgument) opens in the tray instead of the window
    static WindowPrefs load(const QSettings& settings);
    static void save(QSettings& settings, const WindowPrefs& prefs);
};

// "Abrir o Triscord ao iniciar o Windows": a value under HKCU\Software\Microsoft\Windows\CurrentVersion\Run. The
// registry is the source of truth (the user can switch it off in Task Manager), so it is read back, not mirrored.
class LoginItem {
public:
    explicit LoginItem(QSettings* store, QString valueName = QStringLiteral("Triscord"));
    static std::unique_ptr<QSettings> registryStore();
    static QString command(const QString& executable);   // "<path>" --startup
    // On only when the value runs this very executable (a moved or reinstalled copy counts as off).
    bool enabled(const QString& executable) const;
    bool setEnabled(bool on, const QString& executable);
private:
    QSettings* store_;
    QString name_;
};

// One running Triscord per Windows session and settings location. A second launch asks the first to come forward
// instead of starting another core (two cores would fight over the microphone, the global shortcut and the account).
// The primary is whoever created the session-local mutex first; they talk over a user-only local socket.
class SingleInstance final : public QObject {
    Q_OBJECT
public:
    explicit SingleInstance(const QString& key, QObject* parent = nullptr);
    ~SingleInstance() override;
    // The same TRISCORD_SETTINGS_PATH (end-to-end tests, each with its own account) shares a key; none uses the default.
    static QString keyFor(const QString& settingsPath);

    bool isPrimary() const { return primary_; }
    // Primary only, after the application object exists: starts listening for later launches.
    bool startListening();
    // Secondary only: asks the primary to show its window. Retries for `timeoutMs` (the primary may still be starting).
    bool notifyPrimary(int timeoutMs = 3000);

signals:
    void showRequested();

private:
    QString key_;
    void* mutex_ = nullptr;
    bool primary_ = false;
    QLocalServer* server_ = nullptr;
};

} // namespace triscord
