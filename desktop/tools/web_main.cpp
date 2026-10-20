// triscord-web: the real native core (auth, hub, signaling, voice) driving the web interface in WebView2.
// Development build of the new client (desktop/ARQUITETURA_WEBVIEW2.md); the Qt Widgets client stays the
// shipped one until this reaches functional parity.
//   triscord-web [--assets <desktop/web/dist>] [--devtools] [--quit-after <s>]
//                [--capture <png> --capture-after <ms>] [--script <file.js> --script-after <ms>]
// The same environment hooks as the Qt client apply (TRISCORD_SETTINGS_PATH, TRISCORD_AUTH_SERVER,
// TRISCORD_HUB_SERVER, TRISCORD_AUDIO_MODE=injected), so tests/e2e can run it against the local backend;
// TRISCORD_VIDEO_SOURCE=synthetic replaces the physical camera with generated frames (same encoder path).
#include "auth_session.h"
#include "camera_publisher.h"
#include "screen_service.h"
#include "video_overlays.h"
#include "core_session.h"
#include "group_connection.h"
#include "hub_api.h"
#include "signaling.h"
#include "voice_service.h"
#include "webview_host.h"
#include "win_notifier.h"
#include "window_lifecycle.h"
#include "bundled_fonts.h"
#include "update_splash.h"
#include "log_filter.h"
#include "error_report_log.h"
#include "system_info.h"
#include <exception>

#include <share.h>
#include <io.h>
#include <fcntl.h>
#include <QClipboard>
#include <QCommandLineParser>
#include <QDir>
#include <QEventLoop>
#include <QCoreApplication>
#include <QCursor>
#include <QDateTime>
#include <QEvent>
#include <QFile>
#include <QGuiApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QScreen>
#include <QSessionManager>
#include <QSet>
#include <QSettings>
#include <QStandardPaths>
#include <QTimer>
#include <QWindow>
#include <functional>
#include <utility>
#include <memory>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

using namespace triscord;

// Runs `onClose` when the watched window gets a close request (its own close button, Alt+F4, the app closing it).
class CloseWatcher final : public QObject {
public:
    std::function<void()> onClose;
protected:
    bool eventFilter(QObject* watched, QEvent* event) override {
        if (event->type() == QEvent::Close && onClose) onClose();
        return QObject::eventFilter(watched, event);
    }
};

// The main window's close request (its button, Alt+F4, the title bar): hides to the tray when `hideInstead` says so;
// otherwise it is a real close and `closing` ends the application (the window is a plain QWindow, so the last-window rule
// is switched off: a hidden window must not end the process, nor the popout's own close).
class CloseGuard final : public QObject {
public:
    std::function<bool()> hideInstead;
    std::function<void()> closing;
protected:
    bool eventFilter(QObject* watched, QEvent* event) override {
        if (event->type() != QEvent::Close) return QObject::eventFilter(watched, event);
        if (hideInstead && hideInstead()) { event->ignore(); return true; }
        if (closing) closing();
        return false;
    }
};

// Commands the page sends many times a minute (video layout and acks): they buried the useful lines (20/10).
static bool quietCommand(const QString& name) {
    static const QSet<QString> quiet{"videoStats", "videoSurface", "videoStageOccluders", "videoOccluders", "videoIdle", "videoAck",
                                     "keepCameraPreview", "window"};
    return quiet.contains(name);
}
// A command's name, plus the setting key for setSetting (never its value: device ids, volumes).
static QString commandLabel(const QJsonObject& incoming) {
    const auto command = incoming.value("command").toObject();
    const auto name = command.value("name").toString();
    return name == "setSetting" ? name + " " + command.value("key").toString().left(40) : name;
}

static void log(const QString& text) { std::printf("%s\n", text.toUtf8().constData()); std::fflush(stdout); }

// The log file's writer: every line of stdout/stderr arrives through a pipe and is written with the time in front,
// so two people's logs can be lined up, minus FFmpeg's chatter (log_filter.h).
namespace {
std::mutex logMutex;
std::condition_variable logDone;
bool logFinished = false;

void pumpLog(int readFd, FILE* out) {
    std::string pending;
    bool ffmpegBlock = false;
    auto write = [&](std::string line) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        if (dropLogLine(line, ffmpegBlock)) return;
        SYSTEMTIME now; GetLocalTime(&now);
        std::fprintf(out, "%02d:%02d:%02d.%03d %s\n", now.wHour, now.wMinute, now.wSecond, now.wMilliseconds, line.c_str());
        std::fflush(out);
    };
    char buffer[4096];
    for (int n; (n = _read(readFd, buffer, sizeof buffer)) > 0;) {
        pending.append(buffer, size_t(n));
        size_t start = 0;
        for (size_t end; (end = pending.find('\n', start)) != std::string::npos; start = end + 1) write(pending.substr(start, end - start));
        pending.erase(0, start);
        if (pending.size() > 65536) { write(pending); pending.clear(); }
    }
    if (!pending.empty()) write(pending);
    std::fclose(out);
    { std::lock_guard lock(logMutex); logFinished = true; }
    logDone.notify_all();
}

// At exit: closing the pipe's write ends ends the reader, which gets a moment to write what is left.
void finishLog() {
    std::fflush(stdout); std::fflush(stderr);
    _close(_fileno(stdout)); _close(_fileno(stderr));
    std::unique_lock lock(logMutex);
    logDone.wait_for(lock, std::chrono::seconds(1), [] { return logFinished; });
}

// A GUI app without a console hands qWarning/qCritical to the debugger, not to stderr: before 19/10 the log of a failed
// screen share held the generic notice but not "screen: start failed: <reason>". Debug messages stay out.
void logQtMessage(QtMsgType type, const QMessageLogContext& context, const QString& text) {
    if (type == QtDebugMsg) return;
    // Qt Multimedia asks for a single-threaded apartment on media threads that joined the multithreaded one on purpose
    // (com_apartment.h); its "Failed to initialize COM library" is expected there and only looked like a bug.
    if (text.startsWith(QLatin1String("Failed to initialize COM library"))) return;
    const bool named = context.category && std::strcmp(context.category, "default") != 0;
    std::fprintf(stderr, "%s%s%s%s\n", type == QtInfoMsg ? "" : type == QtWarningMsg ? "warning: " : "error: ",
                 named ? context.category : "", named ? ": " : "", text.toUtf8().constData());
    std::fflush(stderr);
    if (type == QtFatalMsg) std::abort();
}
}

// A crash leaves its code and where it happened (module + offset) instead of a log that just stops (20/10). The
// writer thread still runs while the filter does, so a short wait gets the line into the file.
static LONG WINAPI logCrash(EXCEPTION_POINTERS* info) {
    const auto* record = info->ExceptionRecord;
    HMODULE module = nullptr;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       static_cast<LPCWSTR>(record->ExceptionAddress), &module);
    wchar_t path[MAX_PATH] = L"unknown";
    if (module) GetModuleFileNameW(module, path, MAX_PATH);
    const wchar_t* file = wcsrchr(path, L'\\'); file = file ? file + 1 : path;
    char name[MAX_PATH * 3] = {};
    WideCharToMultiByte(CP_UTF8, 0, file, -1, name, sizeof name, nullptr, nullptr);
    std::fprintf(stderr, "crash: exception 0x%08lX at %s+0x%llX\n", static_cast<unsigned long>(record->ExceptionCode), name,
                 static_cast<unsigned long long>(static_cast<const char*>(record->ExceptionAddress) - reinterpret_cast<const char*>(module)));
    std::fflush(stderr);
    Sleep(300);
    return EXCEPTION_CONTINUE_SEARCH;
}
static void logTerminate() {
    const char* what = "unknown";
    try { if (const auto error = std::current_exception()) std::rethrow_exception(error); }
    catch (const std::exception& error) { what = error.what(); }
    catch (...) {}
    std::fprintf(stderr, "crash: uncaught exception: %s\n", what);
    std::fflush(stderr);
    Sleep(300);
    std::abort();
}

// The last line of a run that ended normally; error reports treat a log without it as an unclean exit.
static void logClosed() { std::printf("%s\n", kLogClosedLine); std::fflush(stdout); }

// A launched app (no console, stdout not redirected) writes its log to %LOCALAPPDATA%\Triscord\logs\triscord.log,
// keeping the previous run as triscord.previous.log: capture, connection (relay/direct) and update lines that a user
// can send when something fails (18/10: a black share could not be reproduced here). It holds command names,
// connection paths and notices only, never tokens, passwords or message text. A run with its own settings
// (TRISCORD_SETTINGS_PATH, tests) keeps its log there, so it never rotates away the installed app's log. Returns the
// log's folder (error reports read it), empty when the run writes no log file.
static QString logToFile() {
    const auto out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (GetConsoleWindow() || (out && out != INVALID_HANDLE_VALUE && GetFileType(out) != FILE_TYPE_UNKNOWN)) return {};
    const auto settings = qEnvironmentVariable("TRISCORD_SETTINGS_PATH");
    const auto base = qEnvironmentVariable("LOCALAPPDATA");
    if (settings.isEmpty() && base.isEmpty()) return {};
    const QDir dir(settings.isEmpty() ? base + "/Triscord/logs" : QDir(settings).absoluteFilePath("logs"));
    if (!dir.mkpath(".")) return {};
    const auto current = dir.filePath("triscord.log"), previous = dir.filePath("triscord.previous.log");
    QFile::remove(previous); QFile::rename(current, previous);
    const auto path = QDir::toNativeSeparators(current).toStdWString();
    // Shared (_SH_DENYNO): the user can open or copy the log while Triscord runs. stdout/stderr get valid descriptors
    // first (NUL), then the pipe to the writer.
    FILE* file = nullptr;
    if (_wfreopen_s(&file, L"NUL", L"w", stdout) != 0) return {};
    _wfreopen_s(&file, L"NUL", L"w", stderr);
    FILE* shared = _wfsopen(path.c_str(), L"w", _SH_DENYNO);
    if (!shared) return {};
    int ends[2];
    if (_pipe(ends, 65536, _O_BINARY | _O_NOINHERIT) != 0) {
        // No pipe: the file directly, as before (no times, FFmpeg included).
        _dup2(_fileno(shared), _fileno(stdout)); _dup2(_fileno(shared), _fileno(stderr));
    } else {
        _dup2(ends[1], _fileno(stdout)); _dup2(ends[1], _fileno(stderr)); _close(ends[1]);
        std::thread(pumpLog, ends[0], shared).detach();
        std::atexit(finishLog);
    }
    std::atexit(logClosed);   // registered last, so it runs before finishLog closes the pipe
    qInstallMessageHandler(logQtMessage);
    std::printf("Triscord %s, %s\n", TRISCORD_VERSION, QDateTime::currentDateTime().toString(Qt::ISODate).toUtf8().constData());
    std::fflush(stdout);
    return dir.absolutePath();
}

int main(int argc, char** argv) {
    if (const auto settingsPath = qEnvironmentVariable("TRISCORD_SETTINGS_PATH"); !settingsPath.isEmpty()) {
        QSettings::setDefaultFormat(QSettings::IniFormat);
        QSettings::setPath(QSettings::IniFormat, QSettings::UserScope, settingsPath);
    }
    // One Triscord per Windows session: a second launch (shortcut, login item, a notification's app) brings the first
    // one forward and exits. Before the log is opened, which a second launch would otherwise rotate under the first.
    SingleInstance instance(SingleInstance::keyFor(qEnvironmentVariable("TRISCORD_SETTINGS_PATH")));
    if (!instance.isPrimary()) {
        QCoreApplication guest(argc, argv);   // the local socket needs an application object
        instance.notifyPrimary();
        return 0;
    }
    const auto logDirectory = logToFile();
    SetUnhandledExceptionFilter(logCrash);
    std::set_terminate(logTerminate);
    QGuiApplication app(argc, argv);
    instance.startListening();
    logSystemInfo();
    // Tests check the crash line on a real access violation; only with their own settings.
    if (!qEnvironmentVariable("TRISCORD_SETTINGS_PATH").isEmpty() && qEnvironmentVariable("TRISCORD_CRASH_TEST") == "1")
        QTimer::singleShot(4000, [] { volatile int* nowhere = nullptr; *nowhere = 1; });
    app.setOrganizationName("Triscord");
    app.setApplicationName("TriscordNativePreview");   // same settings as the Qt client: same account/session
    // No applicationDisplayName: Qt would append " - Triscord" to every window title (the call popout is titled with the
    // channel only, as Discord's). The taskbar/process name comes from the VERSIONINFO resource.
    app.setApplicationVersion(QStringLiteral(TRISCORD_VERSION));
    loadBundledFonts();
    QCommandLineParser parser;
    parser.setApplicationDescription("Triscord (C++/WebView2)");
    parser.addHelpOption();
    parser.addOption({"startup", "started by the Windows login item"});
#ifdef TRISCORD_WEB_DEVTOOLS
    parser.addOption({"assets", "web interface directory (default: <exe dir>/web)", "dir"});
    parser.addOption({"devtools", "development mode: DevTools, scripts"});
    parser.addOption({"quit-after", "quit after N seconds", "seconds"});
    parser.addOption({"capture", "write a PNG of the page", "file"});
    parser.addOption({"capture-after", "milliseconds after the first snapshot", "ms", "2000"});
    parser.addOption({"script", "run this JavaScript file in the page (with --devtools)", "file"});
    parser.addOption({"script-after", "milliseconds after the first snapshot", "ms", "1500"});
    parser.addOption({"probe-interval", "repeat the probe every N milliseconds (devtools only)", "ms"});
    parser.addOption({"probe", "JavaScript file whose JSON result is logged as 'probe: ...' (with --devtools)", "file"});
    parser.addOption({"probe-after", "milliseconds after the first snapshot", "ms", "8000"});
    parser.addOption({"popout-script", "run this JavaScript file in the call popout page each time it opens (with --devtools)", "file"});
    parser.addOption({"popout-script-after", "milliseconds after the popout opens", "ms", "2500"});
    parser.addOption({"popout-probe", "JavaScript file run in the popout page, result logged as 'popout script: ...' (with --devtools)", "file"});
    parser.addOption({"popout-probe-after", "milliseconds after the popout opens", "ms", "6000"});
#endif
    parser.process(app);
    const auto optionSet = [&](const QString& name) {
#ifdef TRISCORD_WEB_DEVTOOLS
        return parser.isSet(name);
#else
        Q_UNUSED(name); return false;
#endif
    };
    const auto assets = optionSet("assets") ? parser.value("assets") : QDir(QCoreApplication::applicationDirPath()).filePath("web");

    // Like Discord, look for an update before opening (update_splash.h). The distributed build always does; the
    // development build (E2E, DevTools) only with TRISCORD_FORCE_UPDATE_CHECK=1. TRISCORD_SKIP_UPDATE=1 skips it.
#ifdef TRISCORD_WEB_DEVTOOLS
    const bool checkUpdates = qEnvironmentVariable("TRISCORD_FORCE_UPDATE_CHECK") == "1";
#else
    const bool checkUpdates = qEnvironmentVariable("TRISCORD_SKIP_UPDATE") != "1";
#endif
    std::unique_ptr<SplashWindow> splash;
    if (checkUpdates) {
        splash = std::make_unique<SplashWindow>();
        splash->show();
        Updater updater(splash.get(), QStringLiteral(TRISCORD_VERSION));
        QEventLoop wait;
        bool installing = false;
        QObject::connect(&updater, &Updater::launch, &wait, &QEventLoop::quit);
        QObject::connect(&updater, &Updater::installing, &wait, [&] { installing = true; wait.quit(); });
        updater.start();
        wait.exec();
        if (installing) return 0;   // the installer starts the new version
    }

    AuthSession auth;
    Signaling signaling;
    const auto audioMode = qEnvironmentVariable("TRISCORD_AUDIO_MODE") == "injected" ? VoiceCall::AudioMode::Injected : VoiceCall::AudioMode::Devices;
    VoiceService voice(&signaling, nullptr, audioMode);
    HubApi hub;
    const bool syntheticVideo = qEnvironmentVariable("TRISCORD_VIDEO_SOURCE") == "synthetic";
    ScreenService screen(&signaling);
    CameraPublisher camera(&signaling, nullptr, syntheticVideo ? ScreenCall::SourceMode::Injected : ScreenCall::SourceMode::External);
    auto hubUrl = qEnvironmentVariable("TRISCORD_HUB_SERVER", QString::fromUtf8(groupConnection::server));
    CoreSession core(&signaling, &voice, &auth, &hub, hubUrl, QString::fromUtf8(groupConnection::invite),
                     CoreSession::Media{&screen, &camera, syntheticVideo});
    // Tests point the error reports at a log folder of their own (their output goes to a pipe, not to a log file).
    core.setLogDirectory(qEnvironmentVariable("TRISCORD_REPORT_LOG_DIR", logDirectory));

    QWindow window;
    window.setTitle("Triscord");
    // Like Discord, no system frame: the page draws the 32px title bar with the window buttons; dragging it moves the
    // window and the page's 4px edges resize it (window move / resize-* -> startSystemMove / startSystemResize).
    window.setFlags(Qt::Window | Qt::FramelessWindowHint);
    window.resize(1264, 892);
    // Tray ("Minimizar para a bandeja", "Abrir minimizado"): the notifier owns the notification-area icon. Tests (their own
    // TRISCORD_SETTINGS_PATH) keep the old behaviour, a close ends the process, unless TRISCORD_TRAY=1 asks for the tray.
    WinNotifier notifier;
    const bool trayAllowed = qEnvironmentVariable("TRISCORD_SETTINGS_PATH").isEmpty() || qEnvironmentVariable("TRISCORD_TRAY") == "1";
    bool trayActive = false;
    auto applyTray = [&] {
        const auto prefs = WindowPrefs::load(QSettings());
        // The icon is also what opens a window that started hidden, so "Abrir minimizado" alone keeps it.
        trayActive = trayAllowed && (prefs.closeToTray || prefs.startMinimized) && notifier.setResident(true);
        if (!trayActive) notifier.setResident(false);
    };
    applyTray();
    // Without a working tray icon a hidden window could not be reached again: show it then.
    const bool startHidden = trayActive && launchedAtLogin(app.arguments()) && WindowPrefs::load(QSettings()).startMinimized;
    app.setQuitOnLastWindowClosed(false);   // see CloseGuard
    if (!startHidden) window.show();
    splash.reset();   // Discord closes the splash once the main window is up
    const auto testSettings = qEnvironmentVariable("TRISCORD_SETTINGS_PATH");
    const auto userData = testSettings.isEmpty()
        ? QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/webview2"
        : QDir(testSettings).absoluteFilePath("webview2"); // each test account owns its browser processes/cache
    WebViewHost host(&window, assets, userData, optionSet("devtools"));
    VideoOverlays overlays(&window);
    QObject::connect(&core, &CoreSession::videoFrame, &overlays, &VideoOverlays::setFrame);
    QObject::connect(&core, &CoreSession::videoRemoved, &overlays, &VideoOverlays::remove);
    // Janela destacada (popout) state, filled further below; `fromPopout` marks commands of the popout page while the
    // core handles them, so their window actions and video rectangles go to the popout window.
    std::unique_ptr<QWindow> popout;
    std::unique_ptr<WebViewHost> popoutHost;
    std::unique_ptr<VideoOverlays> popoutOverlays;
    bool fromPopout = false;
    // "Tela cheia" of the popout window (Discord offers it there: module 540462 canFullscreen, guestWindow), restored
    // to its previous state like the main window's.
    Qt::WindowStates popoutBefore = Qt::WindowNoState;
    QRect popoutBeforeGeometry;
    auto exitPopoutFullscreen = [&] {
        if (!popout || !(popout->windowStates() & Qt::WindowFullScreen)) return;
        if (popoutBefore & Qt::WindowMaximized) popout->showMaximized();
        else { popout->showNormal(); if (popoutBeforeGeometry.isValid()) popout->setGeometry(popoutBeforeGeometry); }
    };
    QObject::connect(&core, &CoreSession::videoSurface, &overlays, [&](const QString& id, const QRect& rect, double scale) {
        if (fromPopout) { if (popoutOverlays) popoutOverlays->setSurface(id, rect, scale); }
        else overlays.setSurface(id, rect, scale);
    });
    QObject::connect(&core, &CoreSession::videoIdle, &overlays, [&](bool idle) {
        if (fromPopout) { if (popoutOverlays) popoutOverlays->setIdle(idle); }
        else overlays.setIdle(idle);
    });
    QObject::connect(&core, &CoreSession::videoRole, &overlays, [&](const QString& id, const QString& role) {
        if (fromPopout) { if (popoutOverlays) popoutOverlays->setRole(id, role); }
        else overlays.setRole(id, role);
    });
    QObject::connect(&core, &CoreSession::videoStageOccluders, &overlays, [&](const QVector<QRect>& rects) {
        if (fromPopout) { if (popoutOverlays) popoutOverlays->setStageOccluders(rects); }
        else overlays.setStageOccluders(rects);
    });
    QObject::connect(&core, &CoreSession::videoOccluders, &overlays, [&](const QVector<QRect>& rects) {
        if (fromPopout) { if (popoutOverlays) popoutOverlays->setOccluders(rects); }
        else overlays.setOccluders(rects);
    });
    QObject::connect(&core, &CoreSession::videoFrame, &window, [&](const QString& id, const QImage& image) { if (popoutOverlays) popoutOverlays->setFrame(id, image); });
    QObject::connect(&core, &CoreSession::videoRemoved, &window, [&](const QString& id) { if (popoutOverlays) popoutOverlays->remove(id); });
    QObject::connect(&core, &CoreSession::videoLabel, &window, [&](const QString& id, const QString& label) { if (popoutOverlays) popoutOverlays->setLabel(id, label); });
    QObject::connect(&core, &CoreSession::videoLive, &window, [&](const QString& id, bool live, int fps, int height) { if (popoutOverlays) popoutOverlays->setLive(id, live, fps, height); });
    QObject::connect(&core, &CoreSession::videoLabel, &overlays, &VideoOverlays::setLabel);
    QObject::connect(&core, &CoreSession::videoLive, &overlays, &VideoOverlays::setLive);
    // Deltas, events and late answers go to every page (a page ignores answers to requests it did not make).
    auto postAll = [&](const QJsonObject& message) {
        const auto json = QJsonDocument(message).toJson(QJsonDocument::Compact);
        host.postJson(json);
        if (popoutHost) popoutHost->postJson(json);
    };
    QObject::connect(&core, &CoreSession::event, &host, postAll);
    // Right click on a native video window -> the page opens the participant menu at that point.
    auto videoMenuEvent = [](const QString& streamId, const QPoint& point) {
        return QJsonDocument(QJsonObject{{"v", 1}, {"type", "event"}, {"name", "videoContextMenu"}, {"streamId", streamId},
                                         {"x", point.x()}, {"y", point.y()}}).toJson(QJsonDocument::Compact);
    };
    auto videoClickEvent = [](const QString& streamId) {
        return QJsonDocument(QJsonObject{{"v", 1}, {"type", "event"}, {"name", "videoClick"}, {"streamId", streamId}}).toJson(QJsonDocument::Compact);
    };
    QObject::connect(&overlays, &VideoOverlays::clicked, &host, [&](const QString& id) {
        if (optionSet("devtools")) log("video click " + id);
        host.postJson(videoClickEvent(id));
    });
    QObject::connect(&overlays, &VideoOverlays::contextMenuRequested, &host, [&](const QString& id, const QPoint& point) {
        if (optionSet("devtools")) log(QString("video context menu %1 at %2,%3").arg(id).arg(point.x()).arg(point.y()));
        host.postJson(videoMenuEvent(id, point));
    });
    QObject::connect(&overlays, &VideoOverlays::pointerActivity, &host, [&] {
        host.postJson(QJsonDocument(QJsonObject{{"v",1},{"type","event"},{"name","callActivity"}}).toJson(QJsonDocument::Compact));
    });
    QTimer overlayLog;   // diagnostics for tests: which video windows are visible and how many frames they drew
    QObject::connect(&overlayLog, &QTimer::timeout, [&] {
        log(QString("overlays visible=%1 occluded=%2").arg(overlays.visibleStreams().size()).arg(overlays.occludedStreams().size()));
        for (const auto& id : overlays.visibleStreams()) {
            log(QString("overlay %1 painted=%2 ms=%3 role=%4").arg(id).arg(overlays.paintedFrames(id)).arg(QDateTime::currentMSecsSinceEpoch()).arg(overlays.role(id)));
            if (!overlays.badgeText(id, false).isEmpty())
                log(QString("overlay %1 badges=%2 hover=%3 hovered=%4").arg(id, overlays.badgeText(id, false), overlays.badgeText(id, true)).arg(overlays.hovered(id) ? 1 : 0));
        }
        if (popoutOverlays) {
            log(QString("popout overlays visible=%1").arg(popoutOverlays->visibleStreams().size()));
            for (const auto& id : popoutOverlays->visibleStreams()) log(QString("popout overlay %1 painted=%2").arg(id).arg(popoutOverlays->paintedFrames(id)));
        }
    });
    if (optionSet("devtools")) overlayLog.start(3000);

    bool first = true;
    QObject::connect(&core, &CoreSession::delta, &host, postAll);
    QRect normalGeometry;        // the main window's size before "maximize" (frameless window, see windowAction)
    bool mainMaximized = false;
    Qt::WindowStates beforeFullscreen = Qt::WindowNoState;
    QRect beforeFullscreenGeometry;
    auto exitFullscreen = [&] {
        if (!(window.windowStates() & Qt::WindowFullScreen)) return;
        // Frameless main window: maximize is our own geometry (see "maximize"), so the geometry alone restores it.
        window.showNormal(); if (beforeFullscreenGeometry.isValid()) window.setGeometry(beforeFullscreenGeometry);
    };
    QObject::connect(&overlays, &VideoOverlays::escapePressed, &window, [&] {
        if (core.session().value("callFullscreen").toBool()) exitFullscreen();
    });
    QObject::connect(&window, &QWindow::windowStateChanged, &core, [&](Qt::WindowState) {
        const bool fullscreen = window.windowStates() & Qt::WindowFullScreen;
        core.setCallFullscreenState(fullscreen);
        if (optionSet("devtools")) log(QString("window fullscreen=%1 maximized=%2 geometry=%3,%4 %5x%6").arg(fullscreen ? 1 : 0).arg(mainMaximized ? 1 : 0).arg(window.geometry().x()).arg(window.geometry().y()).arg(window.geometry().width()).arg(window.geometry().height()));
    });
    QObject::connect(&core, &CoreSession::windowAction, &window, [&](const QString& action) {
        if (fromPopout) {   // the popout page's title bar buttons and its "Tela cheia"
            if (!popout) return;
            if (action == "enterCallFullscreen") {
                if (!(popout->windowStates() & Qt::WindowFullScreen)) {
                    popoutBefore = popout->windowStates(); popoutBeforeGeometry = popout->geometry(); popout->showFullScreen();
                }
            } else if (action == "exitCallFullscreen") exitPopoutFullscreen();
            else if (action == "move") popout->startSystemMove();
            else if (action.startsWith("resize-")) {
                const auto edge = action.mid(7);
                Qt::Edges edges;
                if (edge.contains('n')) edges |= Qt::TopEdge;
                if (edge.contains('s')) edges |= Qt::BottomEdge;
                if (edge.contains('e')) edges |= Qt::RightEdge;
                if (edge.contains('w')) edges |= Qt::LeftEdge;
                popout->startSystemResize(edges);
            }
            else if (action == "minimize") popout->showMinimized();
            else if (action == "maximize") popout->windowStates() & Qt::WindowMaximized ? popout->showNormal() : popout->showMaximized();
            else if (action == "close") core.closeCallPopout();
            return;
        }
        if (action == "enterCallFullscreen") {
            if (!(window.windowStates() & Qt::WindowFullScreen)) {
                beforeFullscreen = window.windowStates(); beforeFullscreenGeometry = window.geometry(); window.showFullScreen();
            }
        } else if (action == "exitCallFullscreen") exitFullscreen();
        else if (action == "move") {
            if (mainMaximized) {   // dragging a maximized window restores its size under the cursor, as Windows does
                mainMaximized = false;
                host.setFrameMaximized(false);
                const auto cursor = QCursor::pos();
                window.setGeometry(QRect(QPoint(cursor.x() - normalGeometry.width() / 2, cursor.y() - 16), normalGeometry.size()));
            }
            window.startSystemMove();
        }
        else if (action.startsWith("resize-")) {
            const auto edge = action.mid(7);
            Qt::Edges edges;
            if (edge.contains('n')) edges |= Qt::TopEdge;
            if (edge.contains('s')) edges |= Qt::BottomEdge;
            if (edge.contains('e')) edges |= Qt::RightEdge;
            if (edge.contains('w')) edges |= Qt::LeftEdge;
            mainMaximized = false;   // resized by hand: no longer the maximized geometry
            host.setFrameMaximized(false);
            window.startSystemResize(edges);
        }
        else if (action == "minimize") window.showMinimized();
        else if (action == "maximize") {
            // Frameless window: Windows re-maximizes it on its own after a fullscreen round trip (observed in the call
            // view test), so "maximized" is our geometry: the screen's work area (taskbar visible) and back.
            if (mainMaximized) { window.setGeometry(normalGeometry); mainMaximized = false; }
            else { normalGeometry = window.geometry(); window.setGeometry(window.screen()->availableGeometry()); mainMaximized = true; }
            host.setFrameMaximized(mainMaximized);
        }
        else if (action == "close") window.close();
    });
    QObject::connect(&core, &CoreSession::soundDecoded, [&](const QString& kind, const QString& id, qint64 samples, double peak) {
        if (optionSet("devtools")) log(QString("audio decoded kind=%1 id=%2 samples=%3 peak=%4").arg(kind, id).arg(samples).arg(peak));
    });
    QObject::connect(&core, &CoreSession::notice, [](const QString& text) { log("notice: " + text); });
    // Notifications: the core decides (NotificationPolicy); the host shows a Windows notification and/or flashes the
    // taskbar button, as the user chose in Configurações › Notificações. Clicking the notification brings the window.
    core.setWindowActive(window.isActive());
    QObject::connect(&window, &QWindow::activeChanged, &core, [&] { core.setWindowActive(window.isActive()); });
    QObject::connect(&core, &CoreSession::notify, &window, [&](const QString& title, const QString& body, bool toast, bool flash) {
        if (toast) notifier.show(title, body);
        if (flash) {
            window.alert(0);
            if (const auto path = qEnvironmentVariable("TRISCORD_NOTIFY_FILE"); !path.isEmpty()) {
                QFile file(path);
                if (file.open(QIODevice::Append | QIODevice::Text)) file.write("alert\n");
            }
        }
    });
    // Brings the main window back from the tray or the taskbar: the tray icon, the toast, a second launch.
    auto showMain = [&] {
        if (!window.isVisible()) window.show();
        if (window.windowStates() & Qt::WindowMinimized) window.showNormal();
        window.raise(); window.requestActivate();
    };
    QObject::connect(&notifier, &WinNotifier::activated, &window, showMain);
    QObject::connect(&instance, &SingleInstance::showRequested, &window, showMain);
    QObject::connect(&core, &CoreSession::windowSettingsChanged, &window, applyTray);
    bool quitting = false;   // set when the application really ends (tray menu, Windows logoff or shutdown)
    QObject::connect(&notifier, &WinNotifier::quitRequested, &app, [&] { quitting = true; QCoreApplication::quit(); });
    QObject::connect(&app, &QGuiApplication::commitDataRequest, &app, [&](QSessionManager&) { quitting = true; });
    QObject::connect(&app, &QCoreApplication::aboutToQuit, &app, [&] { quitting = true; });
    // Tests set TRISCORD_CLIPBOARD_FILE so a run never replaces the user's clipboard.
    QObject::connect(&core, &CoreSession::copyText, [](const QString& text) {
        if (const auto path = qEnvironmentVariable("TRISCORD_CLIPBOARD_FILE"); !path.isEmpty()) {
            QFile file(path);
            if (file.open(QIODevice::WriteOnly | QIODevice::Truncate)) file.write(text.toUtf8());
        } else {
            QGuiApplication::clipboard()->setText(text);
        }
        log("copied");
    });
    QObject::connect(&host, &WebViewHost::failed, [](const QString& reason) { log("failed: " + reason); QCoreApplication::exit(1); });
    QObject::connect(&host, &WebViewHost::captured, [](bool ok) { log(ok ? "captured: ok" : "captured: failed"); });
    QObject::connect(&host, &WebViewHost::scriptResult, [](const QString& json) { log("script: " + json); });
    QObject::connect(&host, &WebViewHost::rendererRestarted, [&] { core.closeCameraPreview(); log("renderer restarted"); });
    QObject::connect(&host, &WebViewHost::messageReceived, [&](const QByteArray& json) {
        const auto incoming = QJsonDocument::fromJson(json).object();
        const auto name = incoming.value("command").toObject().value("name").toString();
        // Never log chat text, private profile notes, upload chunks or other command payloads.
        if (!quietCommand(name)) log("ui -> core: " + commandLabel(incoming));
        const auto result = core.handleMessage(incoming);   // empty: answered later through CoreSession::reply
        if (optionSet("devtools") && name == "setStreamHidden" && result.value("ok").toBool())
            log(QString("video hidden=%1").arg(incoming.value("command").toObject().value("hidden").toBool() ? 1 : 0));
        if (name == "requestSnapshot" && result.value("ok").toBool()) {
            host.postJson(QJsonDocument(core.snapshotMessage()).toJson(QJsonDocument::Compact));
            if (first) {
                first = false;
                if (optionSet("capture"))
                    QTimer::singleShot(parser.value("capture-after").toInt(), &host, [&] {
                        host.capturePng(parser.value("capture"));
                        // Native video windows are outside the WebView capture: save them next to it, with their rect.
                        const auto shots = overlays.snapshots();
                        for (auto it = shots.cbegin(); it != shots.cend(); ++it) {
                            const auto& [rect, image] = it.value();
                            const auto file = parser.value("capture") + QString(".overlay-%1-%2-%3.png").arg(rect.x()).arg(rect.y()).arg(QString(it.key()).replace(':', '_').replace('$', ""));
                            image.save(file);
                            log("overlay captured " + file);
                        }
                    });
                auto schedule = [&](const char* option, const char* after) {
                    if (!optionSet(option)) return;
                    QFile file(parser.value(option));
                    const auto script = file.open(QIODevice::ReadOnly) ? QString::fromUtf8(file.readAll()) : QString();
                    const auto run = [&host, script] { host.runScript(script); };
                    QTimer::singleShot(parser.value(after).toInt(), &host, run);
                    if (QString::fromLatin1(option) == "probe" && optionSet("devtools") && optionSet("probe-interval")) {
                        auto* repeat = new QTimer(&host);
                        repeat->setInterval(std::clamp(parser.value("probe-interval").toInt(),1000,60000));
                        QObject::connect(repeat,&QTimer::timeout,&host,run);
                        QTimer::singleShot(parser.value(after).toInt(),repeat,[repeat] { repeat->start(); });
                    }
                };
                schedule("script", "script-after");
                schedule("probe", "probe-after");
            }
        }
        if (!result.isEmpty()) host.postJson(QJsonDocument(result).toJson(QJsonDocument::Compact));
    });
    QObject::connect(&core, &CoreSession::reply, &host, postAll);

    // Janela destacada da chamada (Discord "Nova Janela" / "Voltar para o Discord": CHANNEL_CALL_POPOUT, default
    // 854x480, module 540462; ARQUITETURA_WEBVIEW2.md Fase 10). A second window with its own WebView2 (same user data,
    // hence the same browser process) showing the page in popout mode (?popout=call) and its own native video windows.
    // Closing it (its buttons, the system close, leaving the call, the main window closing) brings the call back.
    CloseWatcher popoutClose, mainClose;
    popoutClose.onClose = [&] { core.closeCameraPreview(); core.closeCallPopout(); };
    mainClose.onClose = [&] { core.closeCameraPreview(); core.closeCallPopout(); };
    window.installEventFilter(&mainClose);
    // Installed last, so it sees the close first: hiding to the tray keeps the call popout and everything else running.
    CloseGuard closeGuard;
    closeGuard.hideInstead = [&] {
        if (quitting || !trayActive || !WindowPrefs::load(QSettings()).closeToTray) return false;
        exitFullscreen();
        window.hide();
        // Once, like Discord: say where the app went, or the window just seems to have vanished.
        QSettings stored;
        if (!stored.value("trayHintShown", false).toBool()) {
            stored.setValue("trayHintShown", true);
            notifier.show("O Triscord continua em execução", "Ele está na bandeja do sistema. Clique no ícone para abrir ou use o menu para sair.");
        }
        log("window hidden to the tray");
        return true;
    };
    closeGuard.closing = [&] {
        quitting = true;
        QMetaObject::invokeMethod(&app, &QCoreApplication::quit, Qt::QueuedConnection);
    };
    window.installEventFilter(&closeGuard);
    QObject::connect(&core, &CoreSession::callPopout, &window, [&](bool open, bool onTop) {
        if (!open) {
            if (!popout) return;
            popout->hide();
            log("popout closed");
            // Deleted on the next turn: this may run inside the popout page's own message callback.
            QTimer::singleShot(0, [o = popoutOverlays.release(), h = popoutHost.release(), w = popout.release()] { delete o; delete h; delete w; });
            return;
        }
        if (!popout) {
            popout = std::make_unique<QWindow>();
            // Observed popout (17/10): no system frame, Discord's own 24px bar with only the window buttons, and the
            // window titled with the channel's name. The page draws the bar and the resize edges (window move/resize-*).
            popout->setFlags(Qt::Window | Qt::FramelessWindowHint);
            QString channelName = QStringLiteral("Triscord");
            for (const auto& category : core.session().value("categories").toArray())
                for (const auto& channel : category.toObject().value("channels").toArray())
                    if (channel.toObject().value("id") == core.session().value("connectedChannelId")) channelName = channel.toObject().value("name").toString();
            popout->setTitle(channelName);
            popout->resize(854, 480);
            popout->installEventFilter(&popoutClose);
            popoutOverlays = std::make_unique<VideoOverlays>(popout.get());
            for (const auto& value : core.session().value("streams").toArray()) {   // labels and badges of streams already running
                const auto stream = value.toObject();
                popoutOverlays->setLabel(stream.value("id").toString(), stream.value("title").toString());
                const bool own = stream.value("kind").toString() == "screen" && stream.value("id").toString().endsWith("$local");
                popoutOverlays->setLive(stream.value("id").toString(), stream.value("kind").toString() == "screen",
                                        own ? QSettings().value("shareFps", 30).toInt() : 0, own ? QSettings().value("shareResolution", 720).toInt() : 0);
            }
            QObject::connect(popoutOverlays.get(), &VideoOverlays::escapePressed, &window, [&] { exitPopoutFullscreen(); });
            QObject::connect(popoutOverlays.get(), &VideoOverlays::clicked, &window, [&, videoClickEvent](const QString& id) {
                if (popoutHost) popoutHost->postJson(videoClickEvent(id));
            });
            QObject::connect(popoutOverlays.get(), &VideoOverlays::contextMenuRequested, &window, [&, videoMenuEvent](const QString& id, const QPoint& point) {
                if (popoutHost) popoutHost->postJson(videoMenuEvent(id, point));
            });
            QObject::connect(popout.get(), &QWindow::windowStateChanged, &window, [&](Qt::WindowState) {
                if (!popout) return;
                const bool fullscreen = popout->windowStates() & Qt::WindowFullScreen;
                core.setCallPopoutFullscreenState(fullscreen);
                log(QString("popout fullscreen=%1").arg(fullscreen ? 1 : 0));
            });
            QObject::connect(popoutOverlays.get(), &VideoOverlays::pointerActivity, &window, [&] {
                if (popoutHost) popoutHost->postJson(QJsonDocument(QJsonObject{{"v", 1}, {"type", "event"}, {"name", "callActivity"}}).toJson(QJsonDocument::Compact));
            });
            popoutHost = std::make_unique<WebViewHost>(popout.get(), assets, userData, optionSet("devtools"));
            popoutHost->setStartQuery("popout=call");
            QObject::connect(popoutHost.get(), &WebViewHost::failed, [](const QString& reason) { log("popout failed: " + reason); });
            QObject::connect(popoutHost.get(), &WebViewHost::rendererRestarted, [&] { core.closeCameraPreview(); });
            QObject::connect(popoutHost.get(), &WebViewHost::scriptResult, [](const QString& json) { log("popout script: " + json); });
            // Tests: scripts in the popout page (the host refuses them without --devtools), timed from its opening.
            for (const auto& [option, after] : {std::pair{"popout-script", "popout-script-after"}, std::pair{"popout-probe", "popout-probe-after"}}) {
                if (!optionSet(option)) continue;
                QFile file(parser.value(option));
                const auto script = file.open(QIODevice::ReadOnly) ? QString::fromUtf8(file.readAll()) : QString();
                QTimer::singleShot(parser.value(after).toInt(), popoutHost.get(), [&popoutHost, script] { if (popoutHost) popoutHost->runScript(script); });
            }
            QObject::connect(popoutHost.get(), &WebViewHost::messageReceived, &window, [&](const QByteArray& json) {
                if (!popoutHost) return;
                const auto incoming = QJsonDocument::fromJson(json).object();
                const auto name = incoming.value("command").toObject().value("name").toString();
                if (!quietCommand(name)) log("popout ui -> core: " + commandLabel(incoming));
                fromPopout = true;
                const auto result = core.handleMessage(incoming);
                fromPopout = false;
                if (!popoutHost) return;
                if (name == "requestSnapshot" && result.value("ok").toBool()) popoutHost->postJson(QJsonDocument(core.snapshotMessage()).toJson(QJsonDocument::Compact));
                if (!result.isEmpty()) popoutHost->postJson(QJsonDocument(result).toJson(QJsonDocument::Compact));
            });
            popout->show();
            popoutHost->start();
            log("popout opened");
        }
        popout->setFlag(Qt::WindowStaysOnTopHint, onTop);
        log(QString("popout onTop=%1").arg(onTop ? 1 : 0));
    });

    log(auth.isValid() ? "signed in" : "signed out: login screen");
    host.start();
    core.start();
    if (optionSet("quit-after")) QTimer::singleShot(parser.value("quit-after").toInt() * 1000, &app, &QCoreApplication::quit);
    return app.exec();
}
