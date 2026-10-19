// Phase-0 gate for desktop/ARQUITETURA_WEBVIEW2.md: a native Qt window hosting the web interface through
// WebView2 built with MinGW. Answers requestSnapshot with a session built in C++ and logs every command.
//   triscord-web-spike --assets <desktop/web/dist> [--devtools] [--quit-after <s>] [--capture <png>]
//                      [--video base|a|b] [--fps 30|60]
// Video experiment (synthetic 1920x1080 BGRA frames, same memory layout as the core's QImage frames):
//   base: frames generated, not shown (cost of producing them)
//   a:    native child window drawn over the tile rect the UI reports (videoSurface)
//   b:    frames copied into WebView2 shared buffers (pool of 3, ack/drop) and drawn on a canvas
//   b-scaled: like b, but the core first scales the frame down to the tile's size (fewer bytes per frame)
#include "webview_host.h"

#include <QCommandLineParser>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QPainter>
#include <QRasterWindow>
#include <QStandardPaths>
#include <QTimer>
#include <QWindow>
#include <cstdio>

using triscord::WebViewHost;

namespace {

constexpr int kWidth = 1920, kHeight = 1080;

// Path A: draws the latest frame scaled into its own native window, placed over the tile.
class OverlayWindow final : public QRasterWindow {
public:
    explicit OverlayWindow(QWindow* parent) : QRasterWindow(parent) {}
    void setFrame(const QImage* frame) { frame_ = frame; update(); }
    int painted = 0;
protected:
    void paintEvent(QPaintEvent*) override {
        if (!frame_) return;
        QPainter painter(this);
        painter.drawImage(QRect(QPoint(), size()), *frame_);
        ++painted;
    }
private:
    const QImage* frame_ = nullptr;
};

QJsonObject snapshot(int revision, const QString& video) {
    QJsonObject session{
        {"connection", "connected"},
        {"account", QJsonObject{{"id", "1"}, {"displayName", "camargo"}, {"username", "camargo"}, {"status", "online"}}},
        {"servers", QJsonArray{QJsonObject{{"id", ""}, {"name", "Triscord"}, {"owned", false}},
                               QJsonObject{{"id", "srv1"}, {"name", "Servidor de camargo"}, {"owned", true}}}},
        {"selectedServerId", "srv1"},
        {"categories", QJsonArray{QJsonObject{{"id", "voice"}, {"name", "Canais de Voz"},
            {"channels", QJsonArray{QJsonObject{{"id", "geral"}, {"name", "Geral"}, {"kind", "voice"}, {"users", QJsonArray{}}}}}}}},
        {"selectedChannelId", "geral"},
        {"muted", false}, {"deafened", false}};
    if (video == "a" || video.startsWith("b"))
        session.insert("streams", QJsonArray{QJsonObject{{"id", "test"}, {"title", "Teste 1080p"}, {"width", kWidth}, {"height", kHeight},
                                                         {"path", video == "a" ? "native-overlay" : "shared-buffer"}}});
    return {{"v", 1}, {"type", "snapshot"}, {"revision", revision}, {"session", session}};
}

void log(const char* format, auto... args) { std::printf(format, args...); std::printf("\n"); std::fflush(stdout); }

} // namespace

int main(int argc, char** argv) {
    QGuiApplication app(argc, argv);
    QCommandLineParser parser;
    parser.addOption({"assets", "desktop/web/dist directory", "dir"});
    parser.addOption({"devtools", "enable WebView2 developer tools"});
    parser.addOption({"quit-after", "quit after N seconds", "seconds"});
    parser.addOption({"capture", "after the first snapshot, write a PNG of the page (CapturePreview)", "file"});
    parser.addOption({"video", "video experiment: base, a or b", "mode"});
    parser.addOption({"fps", "frames per second for --video", "fps", "30"});
    parser.process(app);
    const auto assets = parser.value("assets");
    if (assets.isEmpty()) { std::fprintf(stderr, "--assets is required\n"); return 2; }
    const auto video = parser.value("video");
    const int fps = qBound(1, parser.value("fps").toInt(), 120);

    QWindow window;
    window.setTitle("Triscord (WebView2)");
    window.resize(1264, 892);
    window.show();

    const auto userData = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/webview2-spike";
    WebViewHost host(&window, assets, userData, parser.isSet("devtools"));
    int revision = 0;

    // Synthetic source: a full-frame colour sweep plus a moving bar, rewritten every tick.
    QImage frame(kWidth, kHeight, QImage::Format_ARGB32);
    OverlayWindow* overlay = video == "a" ? new OverlayWindow(&window) : nullptr;
    QSize tile;      // device-pixel size of the video tile, reported by the UI (videoSurface)
    QImage scaled;
    int generated = 0, posted = 0, droppedAtHost = 0, acks = 0;
    QTimer source;
    source.setTimerType(Qt::PreciseTimer);
    QObject::connect(&source, &QTimer::timeout, [&] {
        frame.fill(QColor::fromHsv((generated * 3) % 360, 160, 120));
        QPainter(&frame).fillRect((generated * 16) % kWidth, 0, 120, kHeight, Qt::white);
        ++generated;
        if (video == "a" && overlay) overlay->setFrame(&frame);
        if (video.startsWith("b")) {
            const QImage& out = video == "b-scaled" && tile.isValid() ? (scaled = frame.scaled(tile, Qt::IgnoreAspectRatio, Qt::FastTransformation)) : frame;
            if (host.postVideoFrame(out.constBits(), out.sizeInBytes(),
                                    {{"stream", "test"}, {"seq", generated}, {"width", out.width()}, {"height", out.height()}, {"format", "BGRA"}}))
                ++posted;
            else
                ++droppedAtHost;
        }
    });
    QTimer report;
    QObject::connect(&report, &QTimer::timeout, [&] {
        log("video %s @%dfps: generated=%d posted=%d droppedAtHost=%d acks=%d overlayPainted=%d",
            video.toUtf8().constData(), fps, generated, posted, droppedAtHost, acks, overlay ? overlay->painted : 0);
    });

    QObject::connect(&host, &WebViewHost::ready, [&] {
        log("ready");
        if (video.startsWith("b") && !host.createVideoBuffers(3, qsizetype(kWidth) * kHeight * 4)) log("failed: shared buffers unavailable");

    });
    QObject::connect(&host, &WebViewHost::failed, [](const QString& reason) {
        log("failed: %s", reason.toUtf8().constData()); QCoreApplication::exit(1);
    });
    QObject::connect(&host, &WebViewHost::captured, [](bool ok) { log("captured: %s", ok ? "ok" : "failed"); });
    QObject::connect(&host, &WebViewHost::rendererRestarted, [] { log("renderer restarted"); });
    QObject::connect(&host, &WebViewHost::messageReceived, [&](const QByteArray& json) {
        const auto message = QJsonDocument::fromJson(json).object();   // untrusted: shape checked before use
        if (message.value("type").toString() != "command" || !message.value("command").isObject()) return;
        const auto command = message.value("command").toObject();
        const auto name = command.value("name").toString();
        if (name == "videoAck") { host.releaseVideoBuffer(command.value("index").toInt(-1)); ++acks; return; }
        log("ui -> core: %s", json.constData());
        if (name == "requestSnapshot") {
            host.postJson(QJsonDocument(snapshot(revision++, video)).toJson(QJsonDocument::Compact));
            // Video starts only once the page is listening (it just asked for its snapshot).
            if (!video.isEmpty() && !source.isActive()) { source.start(1000 / fps); report.start(5000); }
            if (parser.isSet("capture") && revision == 1)
                QTimer::singleShot(1500, &host, [&] { host.capturePng(parser.value("capture")); });
        } else if (name == "videoSurface") {
            const auto rect = command.value("rect").toObject();
            const double scale = command.value("scale").toDouble(1.0);
            tile = QSize(qBound(1, int(rect.value("width").toInt() * scale), kWidth), qBound(1, int(rect.value("height").toInt() * scale), kHeight));
            if (!overlay) return;
            overlay->setGeometry(rect.value("x").toInt(), rect.value("y").toInt(), rect.value("width").toInt(), rect.value("height").toInt());
            overlay->show();
            overlay->raise();
        }
    });
    host.start();
    if (parser.isSet("quit-after")) QTimer::singleShot(parser.value("quit-after").toInt() * 1000, &app, &QCoreApplication::quit);
    return app.exec();
}
