#include "camera_encoder.h"
#include "video_image.h"
#include <QGuiApplication>
#include <QElapsedTimer>
#include <QImage>
#include <future>
#include <thread>
#include <cstdio>
#include <stdexcept>
#include <cstring>
using namespace triscord;
namespace {
void require(bool value, const char* message) { if (!value) throw std::runtime_error(message); }
void run(EncoderPreference preference, bool nativeNv12) {
    VideoConfig config{{640,360},30,1000000};
    CameraEncoder encoder(config, preference); VideoDecoder decoder(config);
    std::unique_ptr<VideoDecoder> late;
    QImage source(320,180,QImage::Format_RGB32); source.fill(Qt::red);
    for (int y = 0; y < 180; ++y) for (int x = 160; x < 320; ++x) source.setPixelColor(x,y,Qt::green);
    int sent = 0, decoded = 0, lateFrames = 0; bool requested = false;
    qint64 lastTime = -1; QElapsedTimer deadline; deadline.start();
    while (decoded < 30 && deadline.elapsed() < 8000) {
        if (sent >= 15 && !requested) { require(encoder.requestKeyframe(), "Camera recovery request rejected"); requested = true; }
        // A continuously running source supplies a tail frame to codecs with
        // one-frame latency. Validate the first 30 outputs rather than requiring
        // an undrained codec to emit its last input after the source stops.
        if (sent < 31) {
            QVideoFrame frame(source);
            if (nativeNv12) {
                QVideoFrameFormat format(config.size, QVideoFrameFormat::Format_NV12);
                format.setColorSpace(QVideoFrameFormat::ColorSpace_BT709); format.setColorRange(QVideoFrameFormat::ColorRange_Video);
                frame = QVideoFrame(format); require(frame.map(QVideoFrame::WriteOnly), "Synthetic camera mapping failed");
                require(frame.planeCount() == 2, "Synthetic camera plane count differs");
                for (int plane = 0; plane < 2; ++plane) for (int row = 0; row < (plane == 0 ? 360 : 180); ++row)
                    std::memset(frame.bits(plane) + row * frame.bytesPerLine(plane), plane == 0 ? 97 : 128, 640);
                frame.unmap();
            }
            frame.setMirrored(true);
            if (!nativeNv12 && sent >= 15) frame.setRotation(QtVideo::Rotation::Clockwise90);
            if (encoder.submit(frame, qint64(sent) * 333333)) ++sent;
        }
        for (const auto& packet : encoder.poll()) {
            if (requested && packet.keyframe && !late)
                late = std::make_unique<VideoDecoder>(config);
            if (late) require(late->submit(packet), "Late camera decoder rejected input");
            require(decoder.submit(packet), "Camera decoder rejected input");
        }
        for (const auto& frame : decoder.poll()) {
            require(frame.time100ns > lastTime && frame.time100ns % 333333 == 0, "Camera timestamps changed"); lastTime = frame.time100ns;
            const auto image = videoImage(frame, config.size); require(image.size() == config.size, "Camera output size changed");
            if (nativeNv12) {
                require(std::abs(qGray(image.pixel(320,180)) - 94) <= 8, "Native NV12 camera pixels changed");
            } else if (frame.time100ns < 15 * 333333) {
                const auto left = image.pixelColor(160,180), right = image.pixelColor(480,180);
                require(left.red() > 200 && left.green() < 40 && right.green() > 200 && right.red() < 40, "Camera colors or remote mirroring incorrect");
            } else {
                const auto top = image.pixelColor(320,90), bottom = image.pixelColor(320,270);
                require(top.red() > 200 && top.green() < 40 && bottom.green() > 200 && bottom.red() < 40, "Camera rotation incorrect");
                require(qGray(image.pixel(20,180)) < 10 && qGray(image.pixel(620,180)) < 10, "Portrait camera stretched instead of letterboxed");
            }
            ++decoded;
        }
        if (late) lateFrames += int(late->poll().size());
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (sent < 30 || decoded < 30 || lateFrames == 0)
        std::fprintf(stderr, "Camera probe sent=%d decoded=%d late=%d requested=%d\n", sent, decoded, lateFrames, int(requested));
    require(sent >= 30 && decoded >= 30 && lateFrames > 0, "Camera encoding or late-viewer recovery incomplete");
    std::printf("PASS: camera input=%s sent=%d decoded=%d late=%d; pixels, geometry, timestamps and recovery; hardware=%s\n",
        nativeNv12 ? "NV12" : "RGB/rotation", sent, decoded, lateFrames, encoder.hardware() ? "yes" : "no");
}
}
int main(int argc, char** argv) {
    QGuiApplication app(argc,argv);
    const auto preference = app.arguments().contains("--hardware-only") ? EncoderPreference::HardwareOnly
        : app.arguments().contains("--software-only") ? EncoderPreference::SoftwareOnly : EncoderPreference::HardwarePreferred;
    const bool nativeNv12 = app.arguments().contains("--nv12");
    auto work = std::async(std::launch::async, [preference, nativeNv12] { run(preference, nativeNv12); });
    try { work.get(); return 0; }
    catch (const std::exception& error) { std::fprintf(stderr,"%s\n",error.what()); return 1; }
}
