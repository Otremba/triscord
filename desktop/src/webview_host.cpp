#include "webview_host.h"

#include <QCoreApplication>
#include <QDir>
#include <QDateTime>
#include <QEvent>
#include <QJsonDocument>
#include <QRegularExpression>
#include <cstring>
#include <QWindow>
#include <functional>
#include <utility>

#include <windows.h>
#include <dwmapi.h>
#include <objbase.h>
#include <shlwapi.h>
#include "WebView2.h"

namespace triscord {
namespace {

constexpr wchar_t kHost[] = L"app.triscord";
constexpr wchar_t kOrigin[] = L"https://app.triscord/";

// MIDL_INTERFACE carries no uuid under MinGW, so the IIDs come from the strings in the official
// WebView2.h (SDK 1.0.4258.31) and are parsed once.
IID iid(const wchar_t* text) { IID value{}; IIDFromString(text, &value); return value; }
const IID kIID_ICoreWebView2_3 = iid(L"{A0D6DF20-3B92-416D-AA0C-437A9C727857}");
const IID kIID_ICoreWebView2_17 = iid(L"{702e75d4-fd44-434d-9d70-1a68a6b1192a}");
const IID kIID_ICoreWebView2Environment12 = iid(L"{f503db9b-739f-48dd-b151-fdfcf253f54e}");

// Minimal COM callback object (no WRL/WIL, which are MSVC-specific).
template <class Interface, class... Args>
class Callback final : public Interface {
public:
    Callback(const wchar_t* interfaceId, std::function<HRESULT(Args...)> fn) : iid_(iid(interfaceId)), fn_(std::move(fn)) {}
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** object) override {
        if (!object) return E_POINTER;
        if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, iid_)) { *object = static_cast<Interface*>(this); AddRef(); return S_OK; }
        *object = nullptr;
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
    ULONG STDMETHODCALLTYPE Release() override { const auto left = InterlockedDecrement(&refs_); if (!left) delete this; return left; }
    HRESULT STDMETHODCALLTYPE Invoke(Args... args) override { return fn_ ? fn_(args...) : S_OK; }
private:
    IID iid_;
    std::function<HRESULT(Args...)> fn_;
    LONG refs_ = 1;
};

// Registers an event handler and drops our creation reference (the WebView keeps its own).
template <class Target, class Method, class Handler>
void subscribe(Target* target, Method method, Handler* handler) {
    EventRegistrationToken token{};
    (target->*method)(handler, &token);
    handler->Release();
}

template <class T> void release(T*& pointer) { if (pointer) { pointer->Release(); pointer = nullptr; } }

QString takeString(LPWSTR value) {
    const auto text = value ? QString::fromWCharArray(value) : QString();
    if (value) CoTaskMemFree(value);
    return text;
}

bool fromApp(const QString& uri) { return uri.startsWith(QString::fromWCharArray(kOrigin)); }

using CreateEnvironmentFn = HRESULT(STDAPICALLTYPE*)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions*,
                                                     ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler*);

} // namespace

WebViewHost::WebViewHost(QWindow* window, QString assetsDir, QString userDataDir, bool devTools, QObject* parent)
    : QObject(parent), window_(window), assetsDir_(std::move(assetsDir)), userDataDir_(std::move(userDataDir)), devTools_(devTools) {
    window_->installEventFilter(this);
    connect(window_, &QWindow::windowStateChanged, this, [this] { updateWindowFrame(); });
}

WebViewHost::~WebViewHost() {
    for (auto& video : videoBuffers_) { if (video.buffer) { video.buffer->Close(); video.buffer->Release(); } }
    if (controller_) controller_->Close();
    release(webview_);
    release(controller_);
    release(environment_);
    if (loader_) FreeLibrary(static_cast<HMODULE>(loader_));
}

void WebViewHost::updateWindowFrame() {
    // Discord's live Windows host explicitly requests DWMWCP_ROUND (attribute 33 = 2).
    // Qt's frameless QWindow otherwise leaves the policy at DEFAULT and produces square corners.
    // Frameless Qt windows can maximize without the usual native frame styles. Explicitly disable
    // rounding in maximized/fullscreen states, and restore the policy when returning to a window.
    const bool square = frameMaximized_ || (window_->windowStates() & (Qt::WindowMaximized | Qt::WindowFullScreen));
    const int corners = square ? 1 : 2;
    DwmSetWindowAttribute(reinterpret_cast<HWND>(window_->winId()), 33, &corners, sizeof(corners));
    const int border = square ? 0 : 1;
    const MARGINS frame{border, border, border, border};
    DwmExtendFrameIntoClientArea(reinterpret_cast<HWND>(window_->winId()), &frame);
}

void WebViewHost::start() {
    updateWindowFrame();
    // Loader only from our own directory (never the search path or the working directory).
    const auto loaderPath = QDir(QCoreApplication::applicationDirPath()).filePath("WebView2Loader.dll");
    loader_ = LoadLibraryExW(reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(loaderPath).utf16()), nullptr,
                             LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!loader_) { emit failed("WebView2Loader.dll ausente ao lado do executável"); return; }
    auto create = reinterpret_cast<CreateEnvironmentFn>(GetProcAddress(static_cast<HMODULE>(loader_), "CreateCoreWebView2EnvironmentWithOptions"));
    if (!create) { emit failed("WebView2Loader.dll sem CreateCoreWebView2EnvironmentWithOptions"); return; }
    QDir().mkpath(userDataDir_);

    auto* handler = new Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler, HRESULT, ICoreWebView2Environment*>(
        L"{4e8a3389-c9d8-4bd2-b6b5-124fee6cc14d}", [this](HRESULT result, ICoreWebView2Environment* environment) -> HRESULT {
            if (FAILED(result) || !environment) {
                emit failed(QString("Runtime WebView2 indisponível (HRESULT 0x%1)").arg(quint32(result), 8, 16, QChar('0')));
                return S_OK;
            }
            environment_ = environment;
            environment_->AddRef();
            auto* controllerHandler = new Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler, HRESULT, ICoreWebView2Controller*>(
                L"{6c4819f3-c9b7-4260-8127-c9f5bde7f68c}", [this](HRESULT result, ICoreWebView2Controller* controller) -> HRESULT {
                    if (FAILED(result) || !controller) {
                        emit failed(QString("Falha ao criar o WebView2 (HRESULT 0x%1)").arg(quint32(result), 8, 16, QChar('0')));
                        return S_OK;
                    }
                    onController(controller);
                    return S_OK;
                });
            const auto hr = environment_->CreateCoreWebView2Controller(reinterpret_cast<HWND>(window_->winId()), controllerHandler);
            controllerHandler->Release();
            if (FAILED(hr)) emit failed("CreateCoreWebView2Controller recusou a janela");
            return S_OK;
        });
    const auto hr = create(nullptr, reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(userDataDir_).utf16()), nullptr, handler);
    handler->Release();
    if (FAILED(hr)) emit failed(QString("CreateCoreWebView2EnvironmentWithOptions falhou (HRESULT 0x%1)").arg(quint32(hr), 8, 16, QChar('0')));
}

void WebViewHost::onController(ICoreWebView2Controller* controller) {
    controller_ = controller;
    controller_->AddRef();
    controller_->get_CoreWebView2(&webview_);
    if (!webview_) { emit failed("Controller sem CoreWebView2"); return; }

    ICoreWebView2Settings* settings = nullptr;
    if (SUCCEEDED(webview_->get_Settings(&settings)) && settings) {
        settings->put_IsWebMessageEnabled(TRUE);
        settings->put_AreHostObjectsAllowed(FALSE);           // no COM objects exposed to JavaScript
        settings->put_AreDevToolsEnabled(devTools_ ? TRUE : FALSE);
        settings->put_AreDefaultContextMenusEnabled(devTools_ ? TRUE : FALSE);
        settings->put_AreDefaultScriptDialogsEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        settings->put_IsZoomControlEnabled(FALSE);
        settings->Release();
    }

    // Assets: https://app.triscord/ -> assetsDir, with cross-origin access denied.
    ICoreWebView2_3* webview3 = nullptr;
    if (FAILED(webview_->QueryInterface(kIID_ICoreWebView2_3, reinterpret_cast<void**>(&webview3))) || !webview3) {
        emit failed("Runtime WebView2 sem SetVirtualHostNameToFolderMapping (versão antiga)");
        return;
    }
    webview3->SetVirtualHostNameToFolderMapping(kHost, reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(assetsDir_).utf16()),
                                               COREWEBVIEW2_HOST_RESOURCE_ACCESS_KIND_DENY_CORS);
    webview3->Release();

    subscribe(webview_, &ICoreWebView2::add_NavigationStarting, new Callback<ICoreWebView2NavigationStartingEventHandler, ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs*>(
        L"{9adbe429-f36d-432b-9ddc-f8881fbd76e3}", [](ICoreWebView2*, ICoreWebView2NavigationStartingEventArgs* args) -> HRESULT {
            LPWSTR uri = nullptr;
            args->get_Uri(&uri);
            if (!fromApp(takeString(uri))) args->put_Cancel(TRUE);   // links never leave the app origin
            return S_OK;
        }));
    subscribe(webview_, &ICoreWebView2::add_NewWindowRequested, new Callback<ICoreWebView2NewWindowRequestedEventHandler, ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*>(
        L"{d4c185fe-c81c-4989-97af-2d3fa7ab5651}", [](ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
            args->put_Handled(TRUE);                                    // no popups
            return S_OK;
        }));
    subscribe(webview_, &ICoreWebView2::add_PermissionRequested, new Callback<ICoreWebView2PermissionRequestedEventHandler, ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*>(
        L"{15e1c6a3-c72a-4df3-91d7-d097fbec6bfd}", [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
            args->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);       // media and devices belong to the C++ core
            return S_OK;
        }));
    subscribe(webview_, &ICoreWebView2::add_WebMessageReceived, new Callback<ICoreWebView2WebMessageReceivedEventHandler, ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs*>(
        L"{57213f19-00e6-49fa-8e07-898ea01ecbd2}", [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
            LPWSTR source = nullptr, json = nullptr;
            args->get_Source(&source);
            if (!fromApp(takeString(source))) return S_OK;              // only the app document may talk to the core
            if (SUCCEEDED(args->get_WebMessageAsJson(&json))) {
                const auto text = takeString(json);
                if (text.size() <= 64 * 1024) emit messageReceived(text.toUtf8());   // bounded input
            }
            return S_OK;
        }));
    subscribe(webview_, &ICoreWebView2::add_ProcessFailed, new Callback<ICoreWebView2ProcessFailedEventHandler, ICoreWebView2*, ICoreWebView2ProcessFailedEventArgs*>(
        L"{79e0aea4-990b-42d9-aa1d-0fcc2e5bc7f1}", [this](ICoreWebView2* webview, ICoreWebView2ProcessFailedEventArgs* args) -> HRESULT {
            COREWEBVIEW2_PROCESS_FAILED_KIND kind{};
            args->get_ProcessFailedKind(&kind);
            if (kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED ||
                kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE) {
                for (auto& video : videoBuffers_) video.inFlight = false;   // the dead renderer will never ack
                webview->Reload();
                emit rendererRestarted();
            }
            return S_OK;
        }));

    resizeToWindow();
    // A window that started hidden (a logon start in the tray) keeps its page hidden until the first expose.
    visible_ = window_->isVisible();
    controller_->put_IsVisible(visible_ ? TRUE : FALSE);
    QString page = QStringLiteral("https://app.triscord/index.html");
    static const QRegularExpression safeQuery(QStringLiteral("^[A-Za-z0-9=&]{1,64}$"));
    if (safeQuery.match(startQuery_).hasMatch()) page += '?' + startQuery_;
    webview_->Navigate(reinterpret_cast<LPCWSTR>(page.utf16()));
    emit ready();
}

bool WebViewHost::postJson(const QByteArray& json) {
    if (!webview_) return false;
    const auto text = QString::fromUtf8(json);
    return SUCCEEDED(webview_->PostWebMessageAsJson(reinterpret_cast<LPCWSTR>(text.utf16())));
}

void WebViewHost::capturePng(const QString& path) {
    if (!webview_) { emit captured(false); return; }
    IStream* stream = nullptr;
    if (FAILED(SHCreateStreamOnFileEx(reinterpret_cast<LPCWSTR>(QDir::toNativeSeparators(path).utf16()),
                                      STGM_CREATE | STGM_WRITE, FILE_ATTRIBUTE_NORMAL, TRUE, nullptr, &stream))) {
        emit captured(false);
        return;
    }
    auto* handler = new Callback<ICoreWebView2CapturePreviewCompletedHandler, HRESULT>(
        L"{697e05e9-3d8f-45fa-96f4-8ffe1ededaf5}", [this, stream](HRESULT result) -> HRESULT {
            stream->Release();
            emit captured(SUCCEEDED(result));
            return S_OK;
        });
    if (FAILED(webview_->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, stream, handler))) {
        stream->Release();
        emit captured(false);
    }
    handler->Release();
}

void WebViewHost::runScript(const QString& script) {
    if (!webview_ || !devTools_) { emit scriptResult("null"); return; }
    auto* handler = new Callback<ICoreWebView2ExecuteScriptCompletedHandler, HRESULT, LPCWSTR>(
        L"{49511172-cc67-4bca-9923-137112f4c4cc}", [this](HRESULT result, LPCWSTR json) -> HRESULT {
            emit scriptResult(SUCCEEDED(result) && json ? QString::fromWCharArray(json) : QString("null"));
            return S_OK;
        });
    webview_->ExecuteScript(reinterpret_cast<LPCWSTR>(script.utf16()), handler);
    handler->Release();
}

bool WebViewHost::createVideoBuffers(int count, qsizetype bytes) {
    if (!environment_ || count <= 0 || count > 8 || bytes <= 0 || bytes > 64 * 1024 * 1024) return false;
    ICoreWebView2Environment12* environment12 = nullptr;
    if (FAILED(environment_->QueryInterface(kIID_ICoreWebView2Environment12, reinterpret_cast<void**>(&environment12))) || !environment12)
        return false;
    for (int i = 0; i < count; ++i) {
        VideoBuffer video;
        BYTE* memory = nullptr;
        if (FAILED(environment12->CreateSharedBuffer(static_cast<UINT64>(bytes), &video.buffer)) || !video.buffer ||
            FAILED(video.buffer->get_Buffer(&memory)) || !memory) {
            if (video.buffer) video.buffer->Release();
            environment12->Release();
            return false;
        }
        video.memory = memory;
        video.bytes = bytes;
        videoBuffers_.append(video);
    }
    environment12->Release();
    return true;
}

bool WebViewHost::postVideoFrame(const uchar* data, qsizetype bytes, QJsonObject meta) {
    if (!webview_) return false;
    // A buffer whose ack never came (event lost while the page loaded, renderer stalled) is reclaimed after
    // one second, so a lost message can never freeze the pool. A late ack for it is harmless.
    const auto now = QDateTime::currentMSecsSinceEpoch();
    for (auto& video : videoBuffers_)
        if (video.inFlight && now - video.postedAt > 1000) video.inFlight = false;
    int index = -1;
    for (int i = 0; i < videoBuffers_.size(); ++i)
        if (!videoBuffers_[i].inFlight && videoBuffers_[i].bytes >= bytes) { index = i; break; }
    if (index < 0) return false;                                      // every buffer still held by the UI: drop
    ICoreWebView2_17* webview17 = nullptr;
    if (FAILED(webview_->QueryInterface(kIID_ICoreWebView2_17, reinterpret_cast<void**>(&webview17))) || !webview17) return false;
    auto& video = videoBuffers_[index];
    std::memcpy(video.memory, data, static_cast<size_t>(bytes));      // the one copy into the shared buffer
    meta.insert("index", index);
    const auto json = QString::fromUtf8(QJsonDocument(meta).toJson(QJsonDocument::Compact));
    const bool ok = SUCCEEDED(webview17->PostSharedBufferToScript(video.buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                                                                  reinterpret_cast<LPCWSTR>(json.utf16())));
    webview17->Release();
    video.inFlight = ok;
    video.postedAt = now;
    return ok;
}

void WebViewHost::releaseVideoBuffer(int index) {
    if (index >= 0 && index < videoBuffers_.size()) videoBuffers_[index].inFlight = false;
}

int WebViewHost::videoBuffersInFlight() const {
    int count = 0;
    for (const auto& video : videoBuffers_) count += video.inFlight ? 1 : 0;
    return count;
}

void WebViewHost::resizeToWindow() {
    if (!controller_) return;
    RECT bounds{};
    GetClientRect(reinterpret_cast<HWND>(window_->winId()), &bounds);
    controller_->put_Bounds(bounds);
}

bool WebViewHost::eventFilter(QObject* watched, QEvent* event) {
    if (watched == window_) {
        switch (event->type()) {
        case QEvent::WindowStateChange: updateWindowFrame(); break;
        case QEvent::Resize: resizeToWindow(); break;
        case QEvent::Expose: {
            // Only forward real visibility changes: re-applying the same state on every expose could feed a
            // repaint loop between Qt and the WebView.
            const bool exposed = window_->isExposed();
            if (controller_ && exposed != visible_) { visible_ = exposed; controller_->put_IsVisible(exposed ? TRUE : FALSE); }
            break;
        }
        case QEvent::Move: if (controller_) controller_->NotifyParentWindowPositionChanged(); break;
        default: break;
        }
    }
    return QObject::eventFilter(watched, event);
}

} // namespace triscord
