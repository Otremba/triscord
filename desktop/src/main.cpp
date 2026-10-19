#include "main_window.h"
#include "login_window.h"
#include "auth_session.h"
#include "bundled_fonts.h"
#include "dark_theme.h"
#include <QApplication>
#include <QIcon>
#include <QCommandLineParser>
#include <QSettings>
#include <QPointer>
#include <functional>

int main(int argc, char** argv) {
    // End-to-end tests (tests/e2e/) run several clients side by side: each gets its own INI settings
    // directory so neither touches the user's real preferences. Unset in normal use.
    if (const auto settingsPath = qEnvironmentVariable("TRISCORD_SETTINGS_PATH"); !settingsPath.isEmpty()) {
        QSettings::setDefaultFormat(QSettings::IniFormat);
        QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsPath);
    }
    QApplication app(argc, argv);
    triscord::loadBundledFonts();
    triscord::applyDarkTheme();
    app.setWindowIcon(QIcon(":/triscord/icon.png"));
    app.setOrganizationName("Triscord");
    app.setApplicationName("TriscordNativePreview");
    app.setApplicationVersion("0.9.22");
    app.setApplicationDisplayName("Triscord");
    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addVersionOption();
    parser.process(app);

    // Signing in is required to use the app (Discord has no guest entry
    // point either): the login screen is shown first whenever there is no
    // valid locally-cached session, and MainWindow (which owns its own
    // AuthSession, loaded from the same persisted QSettings keys) is only
    // ever constructed once a session has been established.
    auto* session = new triscord::AuthSession(&app);

    static QPointer<triscord::MainWindow> window;
    static QPointer<triscord::LoginWindow> login;
    static std::function<void()> showLoginScreen;

    auto showMainWindow = [&] {
        if (login) { login->close(); login->deleteLater(); }
        // End-to-end tests run two clients on one machine: synthetic audio keeps them off the user's real
        // microphone and speakers (no feedback, nothing captured). Normal launches use the devices.
        const auto audioMode = qEnvironmentVariable("TRISCORD_AUDIO_MODE") == "injected"
            ? triscord::VoiceCall::AudioMode::Injected : triscord::VoiceCall::AudioMode::Devices;
        window = new triscord::MainWindow(nullptr, audioMode);
        QObject::connect(window.data(), &triscord::MainWindow::loggedOut, &app, [] { showLoginScreen(); });
        window->show();
    };
    showLoginScreen = [&] {
        if (window) { window->close(); window->deleteLater(); }
        login = new triscord::LoginWindow(session);
        QObject::connect(login.data(), &triscord::LoginWindow::signedIn, &app, [showMainWindow] { showMainWindow(); });
        login->show();
    };

    if (triscord::shouldShowLogin(*session)) showLoginScreen(); else showMainWindow();

    return app.exec();
}
