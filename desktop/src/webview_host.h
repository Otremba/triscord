#pragma once
#include <QByteArray>
#include <QObject>
#include <QJsonObject>
#include <QString>
#include <QVector>

class QWindow;
struct ICoreWebView2;
struct ICoreWebView2Controller;
struct ICoreWebView2Environment;
struct ICoreWebView2SharedBuffer;

namespace triscord {

// Hosts the web interface (desktop/web/dist) in a WebView2 controller attached to a native QWindow.
// See desktop/ARQUITETURA_WEBVIEW2.md. Security rules applied here, not in JavaScript:
//   - assets are served only from https://app.triscord/ (virtual host mapped to `assetsDir`, CORS denied);
//   - any navigation outside that origin and every new window are refused;
//   - every permission request (camera, microphone, notifications, ...) is denied: the C++ core owns media;
//   - each web message is accepted only when its source is the app origin; the JSON is handed to the core
//     as untrusted input (the core validates it);
//   - WebView2Loader.dll is loaded only from the application directory;
//   - a crashed renderer is reloaded and reported (rendererRestarted) so the core resends a snapshot.
// Must live on the GUI (STA) thread; callbacks are asynchronous and never block.
class WebViewHost final : public QObject {
    Q_OBJECT
public:
    WebViewHost(QWindow* window, QString assetsDir, QString userDataDir, bool devTools = false, QObject* parent = nullptr);
    ~WebViewHost() override;

    // Starts environment + controller creation. Emits ready() or failed(reason).
    void start();
    // The main window maximizes by geometry to preserve fullscreen restoration; the native state stays Normal.
    void setFrameMaximized(bool maximized) { frameMaximized_ = maximized; updateWindowFrame(); }
    // Query string of the first page (before start()), e.g. "popout=call" for the call popout window. Letters,
    // digits and '=' / '&' only: it stays inside the app origin.
    void setStartQuery(const QString& query) { startQuery_ = query; }
    // Core -> UI. `json` must be a complete JSON value (protocol.ts CoreMessage).
    bool postJson(const QByteArray& json);
    bool isReady() const { return webview_ != nullptr; }
    // Writes a PNG of what the WebView renders (CapturePreview: from inside the browser, so GPU-composited
    // content is included). Emits captured(ok). Used by tests and diagnostics.
    void capturePng(const QString& path);
    // Development/test builds only (the host refuses it when devTools is off): runs `script` in the page and
    // emits scriptResult with the JSON result. Used by end-to-end tests to click real UI elements.
    void runScript(const QString& script);

    // Video path B (ARQUITETURA_WEBVIEW2.md): a bounded pool of shared buffers mapped read-only into the
    // renderer. postVideoFrame copies one frame into a free buffer and posts it with `meta` (plus "index");
    // it returns false and drops the frame when every buffer is still held by the UI. The UI hands a buffer
    // back with the "videoAck" command (releaseVideoBuffer). Never queues: late frames are dropped.
    bool createVideoBuffers(int count, qsizetype bytes);
    bool postVideoFrame(const uchar* data, qsizetype bytes, QJsonObject meta);
    void releaseVideoBuffer(int index);
    int videoBuffersInFlight() const;

signals:
    void ready();
    void failed(const QString& reason);
    void messageReceived(const QByteArray& json);   // UI -> core, origin already checked
    void rendererRestarted();
    void captured(bool ok);
    void scriptResult(const QString& json);

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    void onController(ICoreWebView2Controller* controller);
    void updateWindowFrame();
    void resizeToWindow();

    QWindow* window_;
    QString assetsDir_, userDataDir_;
    bool devTools_;
    bool visible_ = false;
    bool frameMaximized_ = false;
    QString startQuery_;
    struct VideoBuffer { ICoreWebView2SharedBuffer* buffer = nullptr; uchar* memory = nullptr; qsizetype bytes = 0; bool inFlight = false; qint64 postedAt = 0; };
    QVector<VideoBuffer> videoBuffers_;
    void* loader_ = nullptr;
    ICoreWebView2Environment* environment_ = nullptr;
    ICoreWebView2Controller* controller_ = nullptr;
    ICoreWebView2* webview_ = nullptr;
};

} // namespace triscord
