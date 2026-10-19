#include "screen_encoder.h"
#include <QApplication>
#include <QWidget>
#include <QPainter>
#include <QTimer>
#include <QElapsedTimer>
#include <windows.h>
#include <cstdio>
#include <cmath>
#include <thread>
#include <chrono>

using namespace triscord;
class Scene final : public QWidget {
public:
    QColor color{210, 35, 50};
protected:
    void paintEvent(QPaintEvent*) override { QPainter painter(this); painter.fillRect(rect(), color); }
};
int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setQuitOnLastWindowClosed(false);
    Scene scene;
    scene.setWindowTitle("Triscord — teste local de captura e vídeo");
    scene.setAttribute(Qt::WA_ShowWithoutActivating);
    scene.resize(1280, 720); scene.show();
    const CaptureSource source{CaptureSource::Kind::Window, quintptr(scene.winId()), GetCurrentProcessId(), "controlled-video-window"};
    std::thread worker;
    QTimer::singleShot(250, &app, [&] {
        worker = std::thread([&] {
            int phase = 0, matching = 0, received = 0, recovered = 0, idr = 0;
            try {
                const VideoConfig config{{640, 360}, 30, 1000000};
                auto screen = std::make_unique<ScreenEncoder>(source, config);
                auto decoder = std::make_unique<VideoDecoder>(config);
                std::unique_ptr<VideoDecoder> late;
                QColor expected{210, 35, 50};
                qint64 lastTime = -1;
                bool restart = false;
                auto checkImage = [&](const DecodedVideo& image, bool recovery) {
                    const int width = image.size.width(), height = image.size.height();
                    const double r = expected.red(), g = expected.green(), b = expected.blue();
                    const int y = int(16 + .182586 * r + .614231 * g + .062007 * b);
                    const int u = int(128 - .100644 * r - .338572 * g + .439216 * b);
                    const int v = int(128 + .439216 * r - .398942 * g - .040274 * b);
                    const std::array<QPoint, 5> points{QPoint(1, 1), QPoint(3, 1), QPoint(1, 3), QPoint(3, 3), QPoint(2, 2)};
                    int matches = 0;
                    for (const auto& point : points) {
                        const int x = width * point.x() / 4, row = height * point.y() / 4;
                        const int uv = width * height + row / 2 * width + (x & ~1);
                        if (std::abs(int(uint8_t(image.nv12[row * width + x])) - y) <= 12 &&
                            std::abs(int(uint8_t(image.nv12[uv])) - u) <= 12 && std::abs(int(uint8_t(image.nv12[uv + 1])) - v) <= 12) ++matches;
                    }
                    if (recovery) { if (matches >= 3) ++recovered; return; }
                    if (image.time100ns <= lastTime) throw std::runtime_error("Screen timestamps not increasing");
                    lastTime = image.time100ns; ++received;
                    if (matches < 3) return;
                    if (phase == 1 && std::abs(int(uint8_t(image.nv12[height / 2 * width + 2])) - 16) > 8)
                        return; // Old-size frames can still arrive while WGC recreates its pool.
                    if (++matching < 3) return;
                    matching = 0;
                    if (phase == 0) {
                        phase = 1; expected = QColor(20, 60, 210);
                        QMetaObject::invokeMethod(&app, [&] { scene.color = expected; scene.resize(920, 640); scene.update(); }, Qt::BlockingQueuedConnection);
                        if (!screen->requestKeyframe()) throw std::runtime_error("Screen IDR request failed");
                    } else if (phase == 1) {
                        phase = 2; expected = QColor(35, 210, 50);
                        QMetaObject::invokeMethod(&app, [&] { scene.color = expected; scene.update(); }, Qt::BlockingQueuedConnection);
                    } else if (phase == 2 && recovered >= 3) { phase = 3; restart = true; }
                    else if (phase == 4) phase = 5;
                };
                QElapsedTimer deadline; deadline.start();
                while (deadline.elapsed() < 15000 && phase != 5) {
                    auto result = screen->tick();
                    for (const auto& frame : result.encoded) {
                        if (frame.keyframe) ++idr;
                        if (phase == 1 && frame.keyframe && !late) late = std::make_unique<VideoDecoder>(config);
                        if (late) {
                            if (!late->submit(frame)) throw std::runtime_error("Late screen decoder busy");
                            for (const auto& image : late->poll()) checkImage(image, true);
                        }
                        if (!decoder->submit(frame)) throw std::runtime_error("Screen decoder busy");
                        for (const auto& image : decoder->poll()) checkImage(image, false);
                        if (restart || phase == 5) break;
                    }
                    if (restart) {
                        QMetaObject::invokeMethod(&app, [&] { scene.showMinimized(); }, Qt::BlockingQueuedConnection);
                        for (int n = 0; n < 5; ++n) {
                            if (screen->tick().preview) throw std::runtime_error("Minimized source still captured");
                            std::this_thread::sleep_for(std::chrono::milliseconds(50));
                        }
                        QMetaObject::invokeMethod(&app, [&] { scene.showNormal(); scene.update(); }, Qt::BlockingQueuedConnection);
                        QElapsedTimer resumed; resumed.start();
                        bool preview = false;
                        while (resumed.elapsed() < 3000 && !preview) {
                            preview = bool(screen->tick().preview);
                            std::this_thread::sleep_for(std::chrono::milliseconds(15));
                        }
                        if (!preview) throw std::runtime_error("Restored source did not resume");
                        screen.reset(); decoder.reset(); late.reset();
                        screen = std::make_unique<ScreenEncoder>(source, config);
                        decoder = std::make_unique<VideoDecoder>(config);
                        lastTime = -1; phase = 4; restart = false;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(15)); // Dev test only.
                }
                if (phase != 5) throw std::runtime_error("Screen encode test timed out");
                QMetaObject::invokeMethod(&app, [&] { scene.close(); }, Qt::BlockingQueuedConnection);
                bool rejected = false;
                try { screen->tick(); } catch (const std::runtime_error& error) {
                    if (std::string(error.what()) != "Screen source unavailable") throw;
                    rejected = true;
                }
                if (!rejected) throw std::runtime_error("Closed screen source was accepted");
                std::printf("PASS: real WGC -> GPU BGRA/NV12 scaling -> hardware H264 -> decoded BT.709 colors; resize/letterbox/timestamps/IDR/late receiver/minimize/resume/restart/closure (frames=%d IDR=%d)\n", received, idr);
                screen.reset(); decoder.reset(); late.reset();
                QMetaObject::invokeMethod(&app, [&] { app.exit(0); }, Qt::QueuedConnection);
            } catch (const std::exception& error) {
                std::fprintf(stderr, "%s (phase=%d decoded=%d late=%d)\n", error.what(), phase, received, recovered);
                QMetaObject::invokeMethod(&app, [&] { app.exit(1); }, Qt::QueuedConnection);
            }
        });
    });
    const int result = app.exec();
    if (worker.joinable()) worker.join();
    return result;
}
