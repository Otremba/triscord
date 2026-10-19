#pragma once
#include "capture_types.h"
#include <memory>
#include <functional>
struct ID3D11Device;
struct ID3D11DeviceContext;
struct ID3D11Texture2D;

namespace triscord {
// Windows Graphics Capture, with a GDI fallback (18/10: a friend's PC showed black thumbnails and a black share).
// GDI takes over when WGC cannot start, or when it delivers only black frames; the frames then go up to a D3D11
// texture, so the preview, converter and encoder are the same. Automatic tries WGC first; GdiOnly skips it.
class NativeCapture final {
public:
    enum class Backend { Automatic, GdiOnly };
    explicit NativeCapture(const CaptureSource& source, int fps = 15, Backend backend = Backend::Automatic);
    bool usingGdi() const;
    ~NativeCapture();
    // The callback runs while the WGC frame is leased, before preview readback.
    // It may enqueue a GPU copy, but must not retain/use the WGC texture later.
    using FrameConsumer = std::function<void(ID3D11Texture2D*, QSize, qint64)>;
    std::optional<CapturePreview> next(const FrameConsumer& consume = {});
    ID3D11Device* device() const;
    ID3D11DeviceContext* context() const;
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
