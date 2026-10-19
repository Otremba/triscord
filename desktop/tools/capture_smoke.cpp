#include "capture_service.h"
#include <QApplication>
#include <QWidget>
#include <QPainter>
#include <windows.h>
#include <iostream>

// Captures only this executable's controlled test window. No monitor capture,
// image files, resource monitoring, cloud account or media upload.
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
    scene.setWindowTitle("Triscord — teste local de captura");
    scene.setAttribute(Qt::WA_ShowWithoutActivating);
    scene.resize(640, 360); scene.show();
    triscord::CaptureService capture;
    const triscord::CaptureSource source{triscord::CaptureSource::Kind::Window,
        static_cast<quintptr>(scene.winId()), GetCurrentProcessId(), "controlled-test-window"};
    int phase = 0;
    int frames = 0;
    QSize lastSize;
    QColor lastColor;
    QSize firstSize;
    QObject::connect(&capture, &triscord::CaptureService::message, &app, [&](const QString& message) {
        if (phase != 6) { std::cerr << message.toStdString() << '\n'; app.exit(5); }
    });
    QObject::connect(&capture, &triscord::CaptureService::previewReady, &app, [&](const triscord::CapturePreview& frame) {
        if (frame.image.isNull() || frame.image.width() > 640 || frame.image.height() > 360 || frame.time100ns <= 0) {
            std::cerr << "Invalid WGC preview frame\n"; app.exit(6); return;
        }
        ++frames; lastSize = frame.sourceSize;
        const std::array<QPoint, 5> points{QPoint(1, 1), QPoint(3, 1), QPoint(1, 3), QPoint(3, 3), QPoint(2, 2)};
        int reds = 0, greens = 0, blues = 0;
        for (const auto& point : points) {
            const auto color = frame.image.pixelColor(frame.image.width() * point.x() / 4, frame.image.height() * point.y() / 4);
            if (color.red() > color.blue() + 100 && color.red() > color.green() + 100) ++reds;
            if (color.blue() > color.red() + 100 && color.blue() > color.green() + 100) ++blues;
            if (color.green() > color.blue() + 100 && color.green() > color.red() + 100) ++greens;
            lastColor = color;
        }
        if (phase == 0 && reds >= 3) {
            firstSize = frame.sourceSize; phase = 1;
            scene.color = QColor(20, 60, 210); scene.resize(920, 540); scene.update();
        } else if (phase == 1 && blues >= 3 && frame.sourceSize.width() > firstSize.width() + 200) {
            phase = 2; scene.showMinimized();
        } else if (phase == 3 && greens >= 3) {
            phase = 4; capture.stop();
        } else if (phase == 5 && greens >= 3) {
            phase = 6; scene.close();
        }
    });
    QObject::connect(&capture, &triscord::CaptureService::pausedChanged, &app, [&](bool paused) {
        if (phase == 2 && paused) {
            QTimer::singleShot(200, &app, [&] {
                phase = 3; scene.color = QColor(35, 210, 50); scene.showNormal(); scene.update();
            });
        }
    });
    QObject::connect(&capture, &triscord::CaptureService::activeChanged, &app, [&](bool active) {
        if (active) return;
        if (phase == 4) { phase = 5; capture.start(source); }
        else if (phase == 6) {
            std::cout << "PASS: real WGC frames, GPU-scaled colors, resize, minimize/resume, stop/restart and source closure\n";
            app.exit(0);
        }
    });
    QTimer::singleShot(200, &app, [&] { capture.start(source); });
    QTimer::singleShot(12000, &app, [&] {
        std::cerr << "Capture test timed out at phase " << phase << ", frames=" << frames
            << ", last size=" << lastSize.width() << 'x' << lastSize.height()
            << ", last RGB=" << lastColor.red() << ',' << lastColor.green() << ',' << lastColor.blue() << '\n'; app.exit(4);
    });
    return app.exec();
}
