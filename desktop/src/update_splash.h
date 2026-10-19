#pragma once
#include <QElapsedTimer>
#include <QImage>
#include <QNetworkAccessManager>
#include <QPointer>
#include <QRasterWindow>
#include <QTimer>

class QNetworkReply;
class QFile;
namespace triscord {

// Discord's updater splash (desktop host app.asar, REA evidence ev_41fb5f21…, asar sha256 cbd26748…):
// splash/index.css, splashScreenPreload.js and bundle.js's splashScreen module. A frameless 300x350 window
// (LOADING_WINDOW_HEIGHT on Windows), centred, --account-grey #282b30; a 200x200 media box with the spinning logo
// (connecting.webp: 64 frames over 1050ms, the angles measured frame by frame, see update_splash.cpp), the status line
// (gg sans 16/500, white, tabular figures) pulled 30px up over it, and, while downloading/installing, a 180x8 bar
// (radius 4, white 10%) filled with #737f8d, 10px below. Status texts, as Discord's (English in every locale):
// "Checking for updates…", "Downloading update N of M…", "Installing update N of M…",
// "Update failed — retrying in N sec…", "Starting…".
class SplashWindow final : public QRasterWindow {
public:
    SplashWindow();
    void setStatus(const QString& text, int progress = -1);   // progress 0..100 shows the bar, -1 hides it
protected:
    void paintEvent(QPaintEvent*) override;
    void mousePressEvent(QMouseEvent*) override;   // the whole splash drags the window (-webkit-app-region: drag)
private:
    QString status_;
    int progress_ = -1;
    QImage glyph_;           // the triscord logo in white on transparent (the icon without its black square)
    QTimer frame_;           // repaints the spinning logo at the recorded frame rate
    QElapsedTimer clock_;
};

// The update check behind the splash. Releases of the WebView2 client live in the project's GitHub repository
// (the one the Electron client already updates from), tagged "desktop-v<major>.<minor>.<patch>", with the per-user
// installer "Triscord-Setup-<version>.exe" and its "Triscord-Setup-<version>.exe.sha256".
// Discord's flow, as recovered: check; on success with nothing new, "Starting…" and launch; on an update, download
// with progress, then install and restart. Failures launch the installed version so
// an unavailable update server does not prevent startup; a check times out after 10s.
// INFERRED (no Discord equivalent): GitHub answering 403/429 (rate limit) or 404 counts as "nothing new"; the
// installer runs silently (/S /UPDATE) and starts the new version itself.
class Updater final : public QObject {
    Q_OBJECT
public:
    Updater(SplashWindow* splash, QString currentVersion, QObject* parent = nullptr);
    void start();
signals:
    void launch();        // up to date (or no release information): open the app
    void installing();    // the installer was started: quit
private:
    void check();
    void failed(const QString& why);
    void download(const QUrl& installer, const QUrl& checksum, const QString& version);
    void verifyAndInstall();
    QNetworkAccessManager network_;
    QPointer<SplashWindow> splash_;
    QString current_, version_, expectedSha_;
    QTimer timeout_;
    QPointer<QNetworkReply> reply_;
    QFile* file_ = nullptr;
    QString path_;
};

// "1.2.3" > "1.2.0"; anything that is not three numbers compares as older.
bool versionNewer(const QString& candidate, const QString& current);
}
