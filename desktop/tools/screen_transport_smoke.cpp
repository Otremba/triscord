#include "screen_encoder.h"
#include "video_peer.h"
#include <QApplication>
#include <QWidget>
#include <QPainter>
#include <QTimer>
#include <QEventLoop>
#include <thread>
#include <chrono>
#include <cstdio>
#include <cmath>
#include <windows.h>

using namespace triscord;
class Scene final : public QWidget {
public:
    QColor color{210, 35, 50};
protected:
    void paintEvent(QPaintEvent*) override { QPainter painter(this); painter.fillRect(rect(), color); }
};
int main(int argc, char** argv) {
    QApplication app(argc, argv); app.setQuitOnLastWindowClosed(false);
    Scene scene;
    scene.setWindowTitle("Triscord — teste local de tela por WebRTC");
    scene.setAttribute(Qt::WA_ShowWithoutActivating); scene.resize(1280, 720); scene.show();
    const CaptureSource source{CaptureSource::Kind::Window, quintptr(scene.winId()), GetCurrentProcessId(), "controlled-screen-rtc-window"};
    std::thread worker;
    QTimer::singleShot(250, &app, [&] {
        worker = std::thread([&] {
            int phase = 0, matches = 0, frames = 0, plis = 0;
            try {
                const VideoConfig config{{640, 360}, 30, 1000000};
                ScreenEncoder screen(source, config);
                rtc::Configuration rtcConfig; // Local ICE, no cloud or third-party TURN.
                VideoPeer sender(rtcConfig), receiver(rtcConfig);
                auto decoder = std::make_unique<VideoDecoder>(config);
                VideoRtpClock clock;
                QEventLoop events; // Adopted media thread's queued RTC callbacks.
                QColor expected{210, 35, 50};
                std::exception_ptr error;
                bool waitIdr = false;
                QObject::connect(&sender, &VideoPeer::localDescription, &receiver, &VideoPeer::applyDescription);
                QObject::connect(&receiver, &VideoPeer::localDescription, &sender, &VideoPeer::applyDescription);
                QObject::connect(&sender, &VideoPeer::localCandidate, &receiver, &VideoPeer::addCandidate);
                QObject::connect(&receiver, &VideoPeer::localCandidate, &sender, &VideoPeer::addCandidate);
                QObject::connect(&sender, &VideoPeer::keyframeRequested, &sender, [&] { ++plis; screen.requestKeyframe(); });
                QObject::connect(&receiver, &VideoPeer::recoveryNeeded, &receiver, [&] {
                    decoder = std::make_unique<VideoDecoder>(config); clock = {}; waitIdr = true;
                });
                QObject::connect(&receiver, &VideoPeer::videoReceived, &receiver, [&](const QByteArray& bytes, uint32_t stamp, bool keyframe) {
                    try {
                        if (phase == 3 || (waitIdr && !keyframe)) return;
                        waitIdr = false;
                        const auto time = clock.accept(stamp); if (!time) return;
                        if (!decoder->submit({bytes, *time, 10000000 / config.fps, keyframe})) throw std::runtime_error("Screen network decoder busy");
                        for (const auto& image : decoder->poll()) {
                            ++frames;
                            const double r = expected.red(), g = expected.green(), b = expected.blue();
                            const int y = int(16 + .182586 * r + .614231 * g + .062007 * b);
                            const int u = int(128 - .100644 * r - .338572 * g + .439216 * b);
                            const int v = int(128 + .439216 * r - .398942 * g - .040274 * b);
                            int matching = 0;
                            for (auto point : {QPoint(160, 90), QPoint(480, 90), QPoint(160, 270), QPoint(480, 270), QPoint(320, 180)}) {
                                const int uv = 640 * 360 + point.y() / 2 * 640 + (point.x() & ~1);
                                if (std::abs(int(uint8_t(image.nv12[point.y() * 640 + point.x()])) - y) <= 12 &&
                                    std::abs(int(uint8_t(image.nv12[uv])) - u) <= 12 && std::abs(int(uint8_t(image.nv12[uv + 1])) - v) <= 12) ++matching;
                            }
                            if (matching < 3 || ++matches < 3) continue;
                            matches = 0;
                            if (phase == 0) {
                                phase = 1; expected = QColor(20, 60, 210);
                                QMetaObject::invokeMethod(&app, [&] { scene.color = expected; scene.resize(920, 640); scene.update(); }, Qt::BlockingQueuedConnection);
                                decoder = std::make_unique<VideoDecoder>(config); clock = {}; waitIdr = true;
                                if (!receiver.requestKeyframe()) throw std::runtime_error("Screen receiver PLI failed");
                            } else if (phase == 1) {
                                if (!plis) throw std::runtime_error("Screen PLI was not delivered");
                                phase = 2; expected = QColor(35, 210, 50);
                                QMetaObject::invokeMethod(&app, [&] { scene.color = expected; scene.update(); }, Qt::BlockingQueuedConnection);
                            } else phase = 3;
                        }
                    } catch (...) { error = std::current_exception(); }
                });
                sender.offer();
                QElapsedTimer deadline; deadline.start();
                while (deadline.elapsed() < 15000 && phase != 3) {
                    events.processEvents(QEventLoop::AllEvents, 2);
                    if (error) std::rethrow_exception(error);
                    if (sender.connected() && receiver.connected()) {
                        auto result = screen.tick();
                        for (const auto& frame : result.encoded) sender.sendVideo(frame);
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(15)); // Development only.
                }
                if (phase != 3) throw std::runtime_error("Screen WebRTC test timed out");
                std::printf("PASS: own window WGC -> GPU NV12 -> hardware H264 -> ICE/DTLS-SRTP -> decoded BT.709 images; resize and RTCP PLI/decoder recovery (frames=%d PLI=%d)\n", frames, plis);
                QMetaObject::invokeMethod(&app, [&] { app.exit(0); }, Qt::QueuedConnection);
            } catch (const std::exception& error) {
                std::fprintf(stderr, "%s (phase=%d frames=%d PLI=%d)\n", error.what(), phase, frames, plis);
                QMetaObject::invokeMethod(&app, [&] { app.exit(1); }, Qt::QueuedConnection);
            }
        });
    });
    const int result = app.exec(); if (worker.joinable()) worker.join(); return result;
}
