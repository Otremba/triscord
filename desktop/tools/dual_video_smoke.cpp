#include "screen_service.h"
#include "camera_publisher.h"
#include <QCoreApplication>
#include <QTimer>
#include <QUuid>
#include <cstdio>
#include <cmath>
using namespace triscord;
namespace {
struct Source {
    VideoEncoder encoder{{{640,360},30,1000000}, EncoderPreference::SoftwareOnly};
    ScreenService call;
    int sent = 0, received = 0;
    Source(Signaling* signal, ScreenCall::MediaKind kind)
        : call(signal, nullptr, ScreenCall::SourceMode::Injected, {{640,360},30,1000000}, kind) {}
};
struct Client {
    Signaling signal;
    Source screen{&signal, ScreenCall::MediaKind::Screen};
    CameraPublisher camera{&signal, nullptr, ScreenCall::SourceMode::Injected};
    int cameraReceived = 0;
    int cameraPreviews = 0;
    int cameraReduced = 0, cameraFull = 0, previewFull = 0;
    bool joined = false;
};
int run(QCoreApplication& app, const QUrl& url) {
    if (url.host() != "127.0.0.1" || url.scheme() != "http") return 2;
    Client clients[2]; QTimer tick; tick.setInterval(33); bool checking = false, focusing = false;
    const auto room = "native-dual-" + QUuid::createUuid().toString(QUuid::WithoutBraces);
    for (int index = 0; index < 2; ++index) {
        auto* client = &clients[index];
        QObject::connect(&client->signal, &Signaling::connected, &app, [&, client, index] {
            const auto name = QString("dual-%1").arg(index);
            client->signal.sendEvent("join-room", {{"roomId", room}, {"userData", QJsonObject{{"userId", name}, {"username", name}}}});
        });
        QObject::connect(&client->signal, &Signaling::eventReceived, &app, [&, client](const QString& name, const QJsonArray&) {
            if (name == "room-joined") { client->joined = true; client->screen.call.startInjected(); }
        });
        QObject::connect(&client->camera, &CameraPublisher::roomChanged, &app, [client](bool ready) {
            if (ready) client->camera.start();
        });
        QObject::connect(&client->camera, &CameraPublisher::message, &app, [&](const QString& text) {
            std::fprintf(stderr, "Camera publisher: %s\n", text.toUtf8().constData()); app.exit(6);
        });
        QObject::connect(&client->camera, &CameraPublisher::image, &app, [&, client](const QString& id, const QImage& frame) {
            if (frame.isNull() || std::abs(qGray(frame.pixel(frame.width()/2, frame.height()/2)) - 168) > 8) {
                std::fprintf(stderr, "Wrong camera pixels\n"); app.exit(3); return;
            }
            if (id == "$local") {
                ++client->cameraPreviews;
                if (frame.size() == QSize(1280,720) && client == &clients[1] && focusing) ++client->previewFull;
                else if (frame.size() != QSize(640,360)) { std::fprintf(stderr,"Unexpected preview size\n"); app.exit(7); }
                return;
            }
            if (frame.size() == QSize(320,180)) ++client->cameraReduced;
            else if (frame.size() == QSize(1280,720) && focusing && client == &clients[0]) ++client->cameraFull;
            else { std::fprintf(stderr,"Unexpected camera render size\n"); app.exit(7); }
            ++client->cameraReceived;
        });
        for (auto* source : {&client->screen}) {
            const int expected = 74;
            QObject::connect(&source->call, &ScreenService::keyframeRequested, &app, [source] { source->encoder.requestKeyframe(); });
            QObject::connect(&source->call, &ScreenService::frameReady, &app, [&, source, expected](const QString&, const QImage& frame) {
                if (frame.isNull() || std::abs(qGray(frame.pixel(frame.width()/2, frame.height()/2)) - expected) > 8) {
                    std::fprintf(stderr,"Wrong video role or pixels\n"); app.exit(3); return;
                }
                ++source->received;
            });
        }
    }
    QObject::connect(&tick, &QTimer::timeout, &app, [&] {
        for (auto& client : clients) if (client.joined) {
            QImage cameraImage(320, 180, QImage::Format_RGB32); cameraImage.fill(QColor(168,168,168));
            client.camera.submitFrame(QVideoFrame(cameraImage));
            auto* source = &client.screen;
            for (const auto& frame : source->encoder.poll()) source->call.sendFrame(frame);
            if (source->encoder.ready()) {
                QByteArray bytes(640*360*3/2, char(128)); std::fill(bytes.begin(), bytes.begin()+640*360, char(80));
                if (source->encoder.submit(bytes, qint64(source->sent) * 333333)) ++source->sent;
            }
        }
        if (checking) return;
        if (!focusing) {
            for (const auto& client : clients) if (client.screen.received < 5 || client.cameraReduced < 5 || client.cameraPreviews < 3) return;
            focusing = true; clients[0].camera.setFocus(clients[1].signal.socketId()); clients[1].camera.setFocus("$local");
            return;
        }
        if (clients[0].cameraFull < 3 || clients[1].previewFull < 3) return;
        checking = true; clients[0].camera.stop();
        QTimer::singleShot(350, &app, [&] {
            const int stopped = clients[1].cameraReceived, stoppedPreview = clients[0].cameraPreviews, screen0 = clients[0].screen.received,
                screen1 = clients[1].screen.received, otherCamera = clients[0].cameraReceived;
            QTimer::singleShot(700, &app, [&, stopped, stoppedPreview, screen0, screen1, otherCamera] {
                tick.stop();
                if (clients[1].cameraReceived != stopped || clients[0].cameraPreviews != stoppedPreview || clients[0].screen.received <= screen0 ||
                    clients[1].screen.received <= screen1 || clients[0].cameraReceived <= otherCamera) {
                    std::fprintf(stderr,"Stopping one camera affected another media source\n"); app.exit(4); return;
                }
                std::puts("PASS: camera/screen roles and pixels verified; camera grid reduced to 320x180; focus renders 1280x720 remote/local; stopping one camera preserves both screens and the other camera"); app.quit();
            });
        });
    });
    QTimer::singleShot(20000, &app, [&] { std::fprintf(stderr,"Dual-video timeout\n"); app.exit(5); });
    tick.start(); for (auto& client : clients) client.signal.connectTo(url); return app.exec();
}
}
int main(int argc, char** argv) {
    QCoreApplication app(argc,argv);
    if (argc != 2) return 2;
    try { return run(app, QUrl(QString::fromLocal8Bit(argv[1]))); }
    catch (const std::exception& error) { std::fprintf(stderr,"%s\n",error.what()); return 1; }
}
