#include "camera_service.h"
#include <QGuiApplication>
#include <QTimer>
#include <cstdio>
int main(int argc, char** argv) {
    QGuiApplication app(argc, argv);
    triscord::CameraService capture; int frames = 0;
    QObject::connect(&capture, &triscord::CameraService::devicesReady, &app, [&](const QList<QCameraDevice>& devices) {
        std::printf("Native cameras: %lld\n", static_cast<long long>(devices.size()));
        if (!app.arguments().contains("--capture")) { app.quit(); return; }
        if (devices.isEmpty()) { std::puts("SKIP: no camera connected"); app.exit(2); return; }
        capture.start();
    });
    QObject::connect(&capture, &triscord::CameraService::message, &app, [&](const QString& message) {
        std::fprintf(stderr, "%s\n", qPrintable(message)); app.exit(1);
    });
    QObject::connect(&capture, &triscord::CameraService::frameReady, &app, [&](const QVideoFrame& frame) {
        if (frame.width() <= 0 || frame.height() <= 0) { app.exit(1); return; }
        if (++frames == 20) { capture.stop(); std::puts("PASS: 20 native camera frames delivered; capture stopped"); app.quit(); }
    });
    QTimer::singleShot(8000, &app, [&] { capture.stop(); app.exit(1); });
    capture.requestDevices(); return app.exec();
}
