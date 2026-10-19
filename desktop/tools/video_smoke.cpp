#include "video_codec.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QThread>
#include <cstdio>
#include <stdexcept>
#include <algorithm>
#include <d3d11.h>
#include <wrl/client.h>

using namespace triscord;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void run(EncoderPreference preference, bool gpu = false, QSize size = {640, 360}, int fps = 30, int bitrate = 1000000) {
    VideoConfig config{size, fps, bitrate};
    Microsoft::WRL::ComPtr<ID3D11Device> device;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context;
    if (gpu) require(SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
        &device, nullptr, &context)), "D3D11 video device unavailable");
    VideoEncoder encoder(config, preference, device.Get());
    require(!gpu || encoder.acceptsTextures(), "Encoder rejected GPU surfaces");
    VideoDecoder decoder(config);
    std::unique_ptr<VideoDecoder> lateDecoder;
    int lateDecoded = 0;
    QByteArray nv12(config.nv12Bytes(), char(128));
    const int pixels = config.size.width() * config.size.height();
    int sent = 0, encoded = 0, decoded = 0, keyframes = 0;
    qint64 lastDecoded = -1;
    bool forced = false, forcedObserved = false;
    auto receive = [&] {
        for (const auto& frame : decoder.poll()) {
            require(frame.time100ns > lastDecoded, "Decoded timestamps are not increasing");
            require(frame.time100ns % (10000000 / config.fps) == 0, "Decoded timestamp changed");
            const int index = int(frame.time100ns / (10000000 / config.fps));
            const int expected = 48 + index % 4 * 40;
            // Four changing gray levels prove actual image reconstruction, not
            // merely a nonempty bitstream. Ignore macroblock border padding.
            const int center = pixels / 2 + config.size.width() / 2;
            require(std::abs(int(uint8_t(frame.nv12[center])) - expected) <= 8, "Decoded luminance differs from input");
            require(std::abs(int(uint8_t(frame.nv12[pixels + pixels / 4])) - 128) <= 8, "Decoded chroma differs from input");
            lastDecoded = frame.time100ns; ++decoded;
        }
    };
    auto consume = [&] {
        for (const auto& frame : encoder.poll()) {
            require(frame.duration100ns == 10000000 / config.fps, "Encoded duration changed");
            require(frame.annexB.startsWith(QByteArray::fromHex("00000001")) || frame.annexB.startsWith(QByteArray::fromHex("000001")), "H264 is not Annex B");
            if (frame.keyframe) { ++keyframes; if (frame.time100ns >= 8 * (10000000 / config.fps)) forcedObserved = true; }
            if (!lateDecoder && frame.keyframe && frame.time100ns >= 8 * (10000000 / config.fps))
                lateDecoder = std::make_unique<VideoDecoder>(config);
            if (lateDecoder) {
                require(lateDecoder->submit(frame), "Late receiver stalled");
                for (const auto& image : lateDecoder->poll()) {
                    const int index = int(image.time100ns / (10000000 / config.fps));
                    require(std::abs(int(uint8_t(image.nv12[pixels / 2 + config.size.width() / 2])) - (48 + index % 4 * 40)) <= 8,
                        "Late receiver did not recover image");
                    ++lateDecoded;
                }
            }
            if (!decoder.submit(frame)) { receive(); require(decoder.submit(frame), "Decoder remained busy"); }
            ++encoded; receive();
        }
    };
    QElapsedTimer deadline; deadline.start();
    while (deadline.elapsed() < 10000 && decoded < 29) {
        consume();
        if (sent < 30) {
            if (sent == 8 && !forced) { require(encoder.requestKeyframe(), "Keyframe request unsupported"); forced = true; }
            std::fill(nv12.begin(), nv12.begin() + pixels, char(48 + sent % 4 * 40));
            bool accepted = false;
            const qint64 time = qint64(sent) * (10000000 / config.fps);
            if (gpu) {
                // Synthetic CPU upload validates MF surface input. Real capture
                // needs a BGRA->NV12 video processor; this is not that path.
                D3D11_TEXTURE2D_DESC desc{};
                desc.Width = UINT(config.size.width()); desc.Height = UINT(config.size.height());
                desc.MipLevels = desc.ArraySize = 1; desc.Format = DXGI_FORMAT_NV12;
                desc.SampleDesc.Count = 1; desc.Usage = D3D11_USAGE_DEFAULT;
                desc.BindFlags = D3D11_BIND_RENDER_TARGET;
                D3D11_SUBRESOURCE_DATA data{nv12.constData(), UINT(config.size.width()), UINT(nv12.size())};
                Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
                require(SUCCEEDED(device->CreateTexture2D(&desc, &data, &texture)), "Synthetic NV12 texture creation failed");
                // Each accepted texture is immutable; MF owns its lifetime.
                accepted = encoder.submitTexture(texture.Get(), time);
            } else accepted = encoder.submit(nv12, time);
            if (accepted) ++sent;
        }
        QThread::msleep(1); // Development-only deadline; no application timer.
    }
    consume(); receive();
    std::printf("%s%s counts: sent=%d encoded=%d decoded=%d IDR=%d\n", encoder.hardware() ? "hardware" : "software", gpu ? "/GPU texture" : "/CPU input", sent, encoded, decoded, keyframes);
    require(sent == 30 && encoded >= 29 && decoded >= 29, "Encode/decode stalled");
    require(keyframes >= 2 && forcedObserved, "Forced IDR not observed");
    require(lateDecoded >= 15, "Late receiver failed to recover from forced IDR");
    bool rejected = false;
    try { encoder.submit(QByteArray(8, 0), 100000000); } catch (const std::invalid_argument&) { rejected = true; }
    require(rejected, "Short NV12 frame accepted");
    rejected = false;
    try { encoder.submit(nv12, 0); } catch (const std::invalid_argument&) { rejected = true; }
    require(rejected, "Old timestamp accepted");
    std::printf("%s %dx%d: sent=%d encoded=%d decoded=%d IDR=%d late=%d; colors/timestamps/recovery/bounds passed\n",
        encoder.hardware() ? "hardware" : "software", size.width(), size.height(), sent, encoded, decoded, keyframes, lateDecoded);
}
}
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    try {
        require(!VideoConfig{{1921, 1080}, 30, 1000000}.valid(), "Odd dimensions accepted");
        require(!VideoConfig{{1920, 1082}, 30, 1000000}.valid(), "Oversized dimensions accepted");
        require(!VideoConfig{{640, 360}, 0, 1000000}.valid(), "Zero fps accepted");
        run(EncoderPreference::SoftwareOnly);
        if (!app.arguments().contains("--software-only")) {
            run(EncoderPreference::HardwarePreferred);
            run(EncoderPreference::HardwareOnly, true);
            if (app.arguments().contains("--fullhd60")) run(EncoderPreference::HardwareOnly, true, {1920, 1080}, 60, 8000000);
        }
        run(EncoderPreference::SoftwareOnly, false, {638, 358}); // Padding, release, and stream restart.
        return 0;
    } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
