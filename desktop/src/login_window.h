#pragma once
#include <QWidget>
#include <QString>

class QLabel;
class QPushButton;

namespace triscord {

class AuthSession;

// True when the login screen should be shown instead of the main window,
// i.e. there is no valid locally-cached session. Kept as a free function so
// the startup decision in main.cpp is unit-testable without driving the
// whole application.
bool shouldShowLogin(const AuthSession& session);

// The screen shown at startup when the user is signed out. Built from the
// measured structure of Discord's real login screen
// (out/claude-observations/LOGIN.md): a centred 784x412 card with a title,
// subtitle and a full-width primary button. Unlike Discord's screen this has
// no e-mail/password fields, no "Esqueceu sua senha?"/"Registre-se" links and
// no QR column — triscord has no equivalent auth methods, so none of that is
// reproduced; the only control inside the card is "Entrar com Google".
class LoginWindow final : public QWidget {
    Q_OBJECT
public:
    explicit LoginWindow(AuthSession* session, QWidget* parent = nullptr);

    // Shows `message` in the screen's status line, the same way
    // MainWindow::showNotice surfaces transient text elsewhere in the app.
    // Public so tests can exercise the failure-display path without driving
    // a real loopback OAuth round trip.
    void showStatus(const QString& message);

signals:
    // Emitted once the session has been persisted as signed-in (and, for a
    // newly-registered account, a nick has been chosen).
    void signedIn();

protected:
    void paintEvent(QPaintEvent* event) override;

private:
    void beginGoogleSignIn();

    AuthSession* session_;
    QWidget* card_ = nullptr;
    QLabel* status_ = nullptr;
    QPushButton* googleButton_ = nullptr;
};

} // namespace triscord
