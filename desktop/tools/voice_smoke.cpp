#include "voice_service.h"
#include <QCoreApplication>
#include <QTimer>
#include <QUrl>
#include <QUuid>
#include <iostream>
#include <cmath>
#include <vector>

using namespace triscord;
struct VoiceEndpoint {
    Signaling signaling;
    VoiceService call{&signaling, nullptr, VoiceCall::AudioMode::Injected};
    VoiceEncoder encoder;
    struct Received { int frames = 0; double energy = 0; };
    std::map<QString, Received> received;
};
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    if (argc < 2 || argc > 3) return 2;
    const QUrl url(QString::fromLocal8Bit(argv[1]));
    if (url.host() != "127.0.0.1" && url.host() != "localhost") return 3;
    const int count = argc == 3 ? QString::fromLocal8Bit(argv[2]).toInt() : 2;
    if (count < 2 || count > 10) return 3;
    const auto room = "voice-test-" + QUuid::createUuid().toString(QUuid::WithoutBraces);
    std::vector<std::unique_ptr<VoiceEndpoint>> clients;
    bool reconnectStarted = false;
    bool awaitingRejoin = false;
    for (int i = 0; i < count; ++i) clients.push_back(std::make_unique<VoiceEndpoint>());
    for (int i = 0; i < count; ++i) {
        auto* client = clients[i].get();
        QObject::connect(&client->signaling, &Signaling::connected, &app, [&, client, i] {
            const auto id = QString("native_voice_%1").arg(i);
            client->signaling.sendEvent("join-room", {{"roomId", room}, {"userData", QJsonObject{
                {"userId", id}, {"username", id}, {"isMuted", true}}}});
        });
        QObject::connect(&client->signaling, &Signaling::eventReceived, &app,
            [&, i](const QString& name, const QJsonArray&) {
                if (name == "room-joined" && i + 1 < count && !clients[i + 1]->signaling.ready())
                    clients[i + 1]->signaling.connectTo(url);
                if (name == "room-joined" && i == count - 1 && awaitingRejoin) {
                    for (auto& endpoint : clients) endpoint->received.clear();
                    awaitingRejoin = false;
                }
            });
        QObject::connect(&client->call, &VoiceService::remoteAudio, &app,
            [client](const QString& peer, const VoiceFrame& pcm) {
                auto& received = client->received[peer];
                ++received.frames;
                for (float sample : pcm) received.energy += sample * sample;
            });
    }
    QTimer generator;
    generator.setTimerType(Qt::PreciseTimer);
    generator.setInterval(20);
    int frameCount = 0;
    QObject::connect(&generator, &QTimer::timeout, &app, [&] {
        VoiceFrame frame{};
        for (int i = 0; i < VoiceSamples; ++i)
            frame[i] = 0.2f * std::sin(2 * 3.141592653589793 * 440 * (frameCount * VoiceSamples + i) / VoiceRate);
        ++frameCount;
        bool complete = !awaitingRejoin;
        for (auto& client : clients) {
            client->call.sendOpus(client->encoder.encode(frame));
            if (client->received.size() != size_t(count - 1)) complete = false;
            for (const auto& [peer, received] : client->received)
                if (received.frames < 10 || received.energy < 1) complete = false;
        }
        if (complete) {
            if (count == 3 && !reconnectStarted) {
                reconnectStarted = true;
                awaitingRejoin = true;
                clients.back()->signaling.disconnectFromServer();
                QTimer::singleShot(250, &app, [&] { clients.back()->signaling.connectTo(url); });
                return;
            }
            generator.stop();
            for (auto& client : clients) { client->call.leave(); client->signaling.disconnectFromServer(); }
            std::cout << "PASS: " << count << " native clients received decodable encrypted Opus from every other participant through actual Socket.IO signaling\n";
            if (reconnectStarted) std::cout << "PASS: voice resumed in all directions after a client disconnected and rejoined with a new session\n";
            app.exit(0);
        }
    });
    QTimer::singleShot(25000, &app, [&] { std::cerr << "Voice mesh test timed out\n"; app.exit(4); });
    generator.start();
    clients[0]->signaling.connectTo(url);
    return app.exec();
}
