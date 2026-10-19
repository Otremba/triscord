#include "capture_native.h"
#include "capture_gpu.h"
#include "wgc_abi.h"
#include <roapi.h>
#include <dxgi.h>
#include <d3d10.h>
#include <stdexcept>
#include <QtGlobal>
#include <cstdio>
#include <windows.h>
#include <bit>
#include <QElapsedTimer>

using Microsoft::WRL::ComPtr;
namespace triscord {
namespace {
void check(HRESULT hr) {
    if (FAILED(hr)) {
        char text[64]; std::snprintf(text, sizeof text, "Windows capture failed (0x%08lx)", static_cast<unsigned long>(hr));
        throw std::runtime_error(text);
    }
}
class Apartment {
public:
    Apartment() { check(RoInitialize(RO_INIT_MULTITHREADED)); }
    ~Apartment() { RoUninitialize(); }
};
class String {
public:
    explicit String(const wchar_t* text) { check(WindowsCreateString(text, UINT32(wcslen(text)), &value)); }
    ~String() { WindowsDeleteString(value); }
    HSTRING value = nullptr;
};
void close(IUnknown* object) {
    if (!object) return;
    ComPtr<wgc::Closable> closable;
    if (SUCCEEDED(object->QueryInterface(wgc::ClosableId, reinterpret_cast<void**>(closable.GetAddressOf())))) closable->Close();
}
struct FrameLease {
    ComPtr<wgc::Frame> frame;
    ~FrameLease() { close(frame.Get()); }
};
struct ContextLock {
    ID3D10Multithread* protection;
    explicit ContextLock(ID3D10Multithread* value) : protection(value) { protection->Enter(); }
    ~ContextLock() { protection->Leave(); }
};
}
struct NativeCapture::State {
    Apartment apartment;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D10Multithread> protection;
    ComPtr<IInspectable> runtimeDevice;
    ComPtr<wgc::Item> item;
    ComPtr<wgc::Pool> pool;
    ComPtr<wgc::Session> session;
    std::unique_ptr<CaptureGpuPreview> preview;
    QSize size;
    // GDI fallback.
    CaptureSource source;
    int fps = 15, blackFrames = 0, blackLimit = 45;
    bool gdi = false;
    QElapsedTimer firstFrame;
    bool delivered = false;
    QImage stalledProbe;
    ComPtr<ID3D11Texture2D> upload;
    LARGE_INTEGER frequency{}, last{};
    void stopWgc() { close(session.Get()); close(pool.Get()); session.Reset(); pool.Reset(); item.Reset(); }
    ~State() {
        stopWgc();
        if (context) { context->ClearState(); context->Flush(); }
    }
};
namespace {
// Every pixel black (a failing capture), as opposed to a dark picture with any detail.
bool allBlack(const QImage& image) {
    if (image.isNull()) return true;
    const auto rgb = image.convertToFormat(QImage::Format_RGB32);
    for (int y = 0; y < rgb.height(); ++y) {
        const auto* line = reinterpret_cast<const quint32*>(rgb.constScanLine(y));
        for (int x = 0; x < rgb.width(); ++x) if (line[x] & 0x00ffffffu) return false;
    }
    return true;
}
// One BGRA frame of a monitor (BitBlt of the desktop) or a window (PrintWindow, full DWM content).
QImage gdiGrab(const CaptureSource& source) {
    RECT rect{};
    HWND window = nullptr;
    if (source.kind == CaptureSource::Kind::Window) {
        window = reinterpret_cast<HWND>(source.handle);
        if (!IsWindow(window) || IsIconic(window) || !GetWindowRect(window, &rect)) throw std::runtime_error("Window unavailable");
    } else {
        MONITORINFO info{}; info.cbSize = sizeof(info);
        if (!GetMonitorInfoW(reinterpret_cast<HMONITOR>(source.handle), &info)) throw std::runtime_error("Monitor unavailable");
        rect = info.rcMonitor;
    }
    const int width = rect.right - rect.left, height = rect.bottom - rect.top;
    if (width < 1 || height < 1 || width > 16384 || height > 16384) throw std::runtime_error("Invalid capture size");
    HDC screen = GetDC(nullptr);
    HDC memory = CreateCompatibleDC(screen);
    BITMAPINFO info{}; info.bmiHeader.biSize = sizeof(info.bmiHeader); info.bmiHeader.biWidth = width; info.bmiHeader.biHeight = -height;
    info.bmiHeader.biPlanes = 1; info.bmiHeader.biBitCount = 32; info.bmiHeader.biCompression = BI_RGB;
    void* bits = nullptr;
    HBITMAP bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
    QImage image;
    if (bitmap && bits) {
        auto* old = SelectObject(memory, bitmap);
        const bool ok = window ? PrintWindow(window, memory, 2 /* PW_RENDERFULLCONTENT */)
                               : BitBlt(memory, 0, 0, width, height, screen, rect.left, rect.top, SRCCOPY | CAPTUREBLT);
        GdiFlush();
        if (ok) image = QImage(static_cast<const uchar*>(bits), width, height, width * 4, QImage::Format_RGB32).copy();
        SelectObject(memory, old);
    }
    if (bitmap) DeleteObject(bitmap);
    DeleteDC(memory); ReleaseDC(nullptr, screen);
    if (image.isNull()) throw std::runtime_error("GDI capture failed");
    return image;
}
bool usableGdi(const CaptureSource& source) {
    // A successful PrintWindow call can still return only black (notably GPU-rendered windows).
    // Never abandon a working WGC session for that, or expand the selected window to a desktop capture.
    try { return !allBlack(gdiGrab(source)); }
    catch (const std::exception&) { return false; }
}
}
NativeCapture::NativeCapture(const CaptureSource& source, int fps, Backend backend) : state_(std::make_unique<State>()) {
    auto& state = *state_;
    if (!source.handle || fps < 1 || fps > 60) throw std::runtime_error("Invalid capture source/rate");
    state.source = source; state.fps = fps; state.blackLimit = fps <= 5 ? 1 : 45;
    QueryPerformanceFrequency(&state.frequency);
    // The device first: the encoder and the preview need it whichever way frames are captured. WARP when the GPU
    // has no D3D11 device (very old drivers).
    D3D_FEATURE_LEVEL feature;
    if (FAILED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &state.device, &feature, &state.context)))
        check(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            nullptr, 0, D3D11_SDK_VERSION, &state.device, &feature, &state.context));
    check(state.device.As(&state.protection));
    state.protection->SetMultithreadProtected(TRUE);
    state.preview = std::make_unique<CaptureGpuPreview>(state.device.Get(), state.context.Get());
    if (source.kind == CaptureSource::Kind::Window) {
        DWORD process = 0;
        auto window = reinterpret_cast<HWND>(source.handle);
        GetWindowThreadProcessId(window, &process);
        if (!IsWindow(window) || IsIconic(window) || process != source.processId) throw std::runtime_error("Window unavailable");
    }
    // TRISCORD_CAPTURE_BACKEND=gdi: tests exercise the fallback on machines where WGC works.
    if (backend == Backend::GdiOnly || qEnvironmentVariable("TRISCORD_CAPTURE_BACKEND") == "gdi") { state.gdi = true; return; }
    try {
        String itemName(L"Windows.Graphics.Capture.GraphicsCaptureItem");
        ComPtr<wgc::ItemInterop> factory;
        check(RoGetActivationFactory(itemName.value, wgc::InteropId, reinterpret_cast<void**>(factory.GetAddressOf())));
        if (source.kind == CaptureSource::Kind::Window)
            check(factory->CreateForWindow(reinterpret_cast<HWND>(source.handle), wgc::ItemId, reinterpret_cast<void**>(state.item.GetAddressOf())));
        else
            check(factory->CreateForMonitor(reinterpret_cast<HMONITOR>(source.handle), wgc::ItemId, reinterpret_cast<void**>(state.item.GetAddressOf())));
        wgc::Size size{}; check(state.item->get_Size(&size)); state.size = QSize(size.width, size.height);
        if (previewSize(state.size).isEmpty()) throw std::runtime_error("Invalid capture size");
        ComPtr<IDXGIDevice> dxgi; check(state.device.As(&dxgi));
        using Bridge = HRESULT (WINAPI*)(IDXGIDevice*, IInspectable**);
        auto bridge = std::bit_cast<Bridge>(GetProcAddress(GetModuleHandleW(L"d3d11.dll"), "CreateDirect3D11DeviceFromDXGIDevice"));
        if (!bridge) throw std::runtime_error("Capture requires Windows 10 1903 or newer");
        ComPtr<IInspectable> inspectable;
        check(bridge(dxgi.Get(), &inspectable));
        check(inspectable->QueryInterface(wgc::DeviceId, reinterpret_cast<void**>(state.runtimeDevice.GetAddressOf())));
        String poolName(L"Windows.Graphics.Capture.Direct3D11CaptureFramePool");
        ComPtr<wgc::PoolFactory> poolFactory;
        check(RoGetActivationFactory(poolName.value, wgc::PoolFactoryId, reinterpret_cast<void**>(poolFactory.GetAddressOf())));
        check(poolFactory->CreateFreeThreaded(state.runtimeDevice.Get(), wgc::Bgra8, 2, size, &state.pool));
        check(state.pool->CreateCaptureSession(state.item.Get(), &state.session));
        ComPtr<wgc::SessionRate> rate;
        if (SUCCEEDED(state.session->QueryInterface(wgc::SessionRateId, reinterpret_cast<void**>(rate.GetAddressOf()))))
            rate->put_MinUpdateInterval({10000000 / fps}); // Optional OS pacing; older Windows retains its default.
        // No yellow border around the shared screen/window (18/10: "incomoda muito"); Discord shows none either.
        // Older Windows lacks the interface or refuses: the capture then keeps the border.
        ComPtr<wgc::SessionBorder> border;
        if (SUCCEEDED(state.session->QueryInterface(wgc::SessionBorderId, reinterpret_cast<void**>(border.GetAddressOf()))))
            border->put_IsBorderRequired(qEnvironmentVariable("TRISCORD_CAPTURE_BORDER") == "1");   // 1: tests compare
        check(state.session->StartCapture());
        state.firstFrame.start();
    } catch (const std::exception& error) {
        std::printf("capture: WGC unavailable (%s), using GDI\n", error.what()); std::fflush(stdout);
        state.stopWgc(); state.gdi = true;
    }
}
NativeCapture::~NativeCapture() = default;
bool NativeCapture::usingGdi() const { return state_->gdi; }
ID3D11Device* NativeCapture::device() const { return state_->device.Get(); }
ID3D11DeviceContext* NativeCapture::context() const { return state_->context.Get(); }
std::optional<CapturePreview> NativeCapture::next(const FrameConsumer& consume) {
    auto& state = *state_;
    if (!state.gdi) {
      try {
        FrameLease latest;
        for (int i = 0; i < 2; ++i) {
            ComPtr<wgc::Frame> candidate;
            check(state.pool->TryGetNextFrame(&candidate));
            if (!candidate) break;
            close(latest.frame.Get()); latest.frame = std::move(candidate);
        }
        if (!latest.frame) {
            if (!state.delivered && state.firstFrame.isValid() && state.firstFrame.elapsed() >= 2000) {
                if (usableGdi(state.source)) {
                    state.stopWgc(); state.gdi = true;
                    std::printf("capture: no first WGC frame, valid GDI fallback selected\n"); std::fflush(stdout);
                    return next(consume);
                }
                // WGC can recover when an application finishes loading. Don't get stuck in an equally black GDI.
                state.firstFrame.restart();
            }
            if (state.delivered && state.firstFrame.elapsed() >= 2000) {
                // Static content legitimately produces no WGC frames. Switch only
                // when independent captures of the selected source show movement.
                // Compare GDI with GDI, not with WGC (their borders/colors can differ).
                try {
                    const auto probe = gdiGrab(state.source);
                    if (!allBlack(probe)) {
                        const auto small = probe.scaled(64, 36, Qt::IgnoreAspectRatio, Qt::SmoothTransformation)
                            .convertToFormat(QImage::Format_RGB32);
                        if (!state.stalledProbe.isNull() && small != state.stalledProbe) {
                            state.stopWgc(); state.gdi = true;
                            std::printf("capture: source changed while WGC stopped delivering, using GDI\n"); std::fflush(stdout);
                            return next(consume);
                        }
                        state.stalledProbe = small;
                    } else state.stalledProbe = {};
                } catch (const std::exception&) { state.stalledProbe = {}; }
                state.firstFrame.restart();
            }
            return {};
        }
        wgc::Size content{}; wgc::Time time{};
        check(latest.frame->get_ContentSize(&content));
        check(latest.frame->get_SystemRelativeTime(&time));
        const QSize size(content.width, content.height);
        if (size.isEmpty()) return {};
        if (previewSize(size).isEmpty()) throw std::runtime_error("Invalid capture size");
        if (size != state.size) {
            close(latest.frame.Get()); latest.frame.Reset();
            check(state.pool->Recreate(state.runtimeDevice.Get(), wgc::Bgra8, 2, content));
            state.size = size; return {};
        }
        ComPtr<IInspectable> surface; check(latest.frame->get_Surface(&surface));
        ComPtr<wgc::SurfaceAccess> access;
        check(surface->QueryInterface(wgc::SurfaceAccessId, reinterpret_cast<void**>(access.GetAddressOf())));
        ComPtr<ID3D11Texture2D> texture;
        check(access->GetInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.GetAddressOf())));
        // Protect the complete draw/copy sequence, not just individual D3D calls,
        // when MF encoder threads also access this device's immediate context.
        ContextLock lock(state.protection.Get());
        // Black alone does not prove failure: loading screens and dark scenes can legitimately be black.
        auto image = state.preview->render(texture.Get(), size);
        if (allBlack(image)) {
            if (++state.blackFrames >= state.blackLimit) {
                state.blackFrames = 0;
                if (usableGdi(state.source)) {
                    close(latest.frame.Get()); latest.frame.Reset();
                    state.stopWgc(); state.gdi = true;
                    std::printf("capture: black WGC frames, valid GDI fallback selected\n"); std::fflush(stdout);
                }
            }
        } else state.blackFrames = 0;
        if (!state.gdi) {
            state.delivered = true;
            state.firstFrame.restart(); state.stalledProbe = {};
            if (consume) consume(texture.Get(), size, time.duration);
            // Map in preview rendering completes queued graphics copies before this
            // WGC lease is closed. The large frame never crosses into CPU memory.
            return CapturePreview{std::move(image), size, time.duration, 0};
        }
      } catch (const std::exception& error) {
        std::printf("capture: WGC stalled or failed (%s), using GDI\n", error.what()); std::fflush(stdout);
        state.stopWgc(); state.gdi = true;
      }
    }
    // GDI: paced to the frame rate, uploaded to a BGRA texture of the same device.
    LARGE_INTEGER now{}; QueryPerformanceCounter(&now);
    if (state.last.QuadPart && (now.QuadPart - state.last.QuadPart) * state.fps < state.frequency.QuadPart) return {};
    state.last = now;
    const auto image = gdiGrab(state.source);
    const QSize size = image.size();
    if (previewSize(size).isEmpty()) throw std::runtime_error("Invalid capture size");
    const qint64 time = qint64(double(now.QuadPart) * 10000000.0 / double(state.frequency.QuadPart));
    ContextLock lock(state.protection.Get());
    D3D11_TEXTURE2D_DESC desc{};
    if (state.upload) state.upload->GetDesc(&desc);
    if (!state.upload || desc.Width != UINT(size.width()) || desc.Height != UINT(size.height())) {
        desc = {}; desc.Width = size.width(); desc.Height = size.height(); desc.MipLevels = 1; desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM; desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
        state.upload.Reset();
        check(state.device->CreateTexture2D(&desc, nullptr, &state.upload));
    }
    state.context->UpdateSubresource(state.upload.Get(), 0, nullptr, image.constBits(), UINT(image.bytesPerLine()), 0);
    if (consume) consume(state.upload.Get(), size, time);
    return CapturePreview{state.preview->render(state.upload.Get(), size), size, time, 0};
}
}
