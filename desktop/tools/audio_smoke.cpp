#include "voice_devices.h"
#include <QCoreApplication>
#include <QThread>
#include <iostream>

// Local hardware check only. Microphone remains suspended/muted, output is
// silence, and no samples are stored or sent to a server.
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    QThread media;
    auto* devices = new triscord::VoiceDevices;
    int phase = 0;
    devices->moveToThread(&media);
    QObject::connect(&media, &QThread::finished, devices, &QObject::deleteLater);
    QObject::connect(devices, &triscord::VoiceDevices::error, &app, [&](const QString& message) {
        if (phase == 2) {
            phase = 3;
            QMetaObject::invokeMethod(devices, [devices] { devices->setDevices({}, {}); });
            return; // The unavailable explicit microphone is an expected failure.
        }
        std::cerr << message.toStdString() << '\n'; app.exit(5);
    });
    QObject::connect(devices, &triscord::VoiceDevices::runningChanged, &app, [&](bool ready) {
        if (!ready) return;
        if (phase == 3) {
            phase = 4;
            QTimer::singleShot(100, &app, [&] {
                std::cout << "PASS: muted native audio, deafen/resume, unavailable-device rejection and default-device recovery on media thread\n";
                app.exit(0);
            });
            return;
        }
        if (phase != 0) return;
        phase = 1;
        QTimer::singleShot(300, &app, [&] {
            QMetaObject::invokeMethod(devices, [devices] { devices->setDeafened(true); });
            QTimer::singleShot(100, &app, [&] {
                QMetaObject::invokeMethod(devices, [devices] { devices->setDeafened(false); });
                QTimer::singleShot(100, &app, [&] {
                    phase = 2;
                    QMetaObject::invokeMethod(devices, [devices] { devices->setDevices("triscord-test-unavailable", {}); });
                });
            });
        });
    });
    QObject::connect(&media, &QThread::started, devices, [devices] { devices->start(); });
    QTimer::singleShot(5000, &app, [&] { std::cerr << "Audio device check timed out\n"; app.exit(4); });
    media.start();
    const int result = app.exec();
    QMetaObject::invokeMethod(devices, &triscord::VoiceDevices::stop, Qt::BlockingQueuedConnection);
    media.quit();
    media.wait();
    return result;
}
