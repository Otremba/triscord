#include "screen_service.h"
#include "voice_service.h"
#include <QCoreApplication>
#include <QTimer>
#include <QUuid>
#include <cmath>
#include <cstdio>
using namespace triscord;
struct Endpoint {
    Signaling socket;
    VideoEncoder video{{{640,360},30,1000000}, EncoderPreference::SoftwareOnly};
    ScreenService screen{&socket, nullptr, ScreenCall::SourceMode::Injected, {{640,360},30,1000000}};
    VoiceService voice{&socket, nullptr, VoiceCall::AudioMode::Injected};
    VoiceEncoder audio;
    VoiceEncoder screenSound{true};
    std::map<QString, int> images, voices;
    std::map<QString, int> screenSounds;
    int sent = 0;
    bool joined = false;
};
int run(QCoreApplication& app, int argc, char** argv) {
    const bool cloud = argc == 3 && QString::fromLocal8Bit(argv[1]) == "--cloudflare";
    if (argc != 2 && !cloud) return 2;
    const QUrl url(QString::fromLocal8Bit(argv[cloud ? 2 : 1]));
    const bool local = url.host() == "127.0.0.1" || url.host() == "localhost";
    if ((!cloud && !local) || (cloud && (url.scheme() != "https" || !url.host().endsWith(".workers.dev") ||
        !url.userInfo().isEmpty() || url.hasQuery() || url.hasFragment() || qEnvironmentVariable("TRISCORD_TEST_INVITE").size() < 16))) {
        std::fprintf(stderr, "Expected localhost, or explicit --cloudflare HTTPS workers.dev URL and a private test invitation\n"); return 3;
    }
    const QString room = cloud ? "native-validation" : "native-screen-test-" + QUuid::createUuid().toString(QUuid::WithoutBraces);
    const QString profile = cloud ? QUuid::createUuid().toString(QUuid::WithoutBraces) : QString{};
    std::vector<std::unique_ptr<Endpoint>> clients;
    for (int n = 0; n < 3; ++n) clients.push_back(std::make_unique<Endpoint>());
    QTimer generator; generator.setInterval(33);
    bool reconnect = false, awaiting = false, stopping = false;
    bool pauseTested = false, pauseChecking = false, audioMuteTested = false;
    bool roomMuteTested = false, roomMuteChecking = false;
    int afterStopFrames = 0;
    QString stoppedId;
    for (int n = 0; n < 3; ++n) {
        auto* client = clients[size_t(n)].get();
        QObject::connect(&client->screen, &ScreenService::keyframeRequested, &app, [client] { client->video.requestKeyframe(); });
        QObject::connect(&client->socket, &Signaling::connected, &app, [&, client, n] {
            const auto name = QString("native-screen-%1").arg(n);
            client->socket.sendEvent("join-room", {{"roomId", room}, {"roomName", "Validação nativa"},
                {"userData", QJsonObject{{"userId", name + profile}, {"username", name}, {"isMuted", true}}}});
        });
        QObject::connect(&client->socket, &Signaling::eventReceived, &app, [&, client, n](const QString& event, const QJsonArray& args) {
            if (roomMuteChecking && n == 1 && event == "user-state-updated" &&
                args.first().toObject().value("socketId").toString() == client->socket.socketId() &&
                args.first().toObject().value("state").toObject().value("isServerMuted").toBool()) {
                // Development adversarial source: keep transmitting despite the
                // owner's restriction, to verify receiver-side enforcement.
                emit client->socket.eventReceived("user-state-updated", QJsonArray{QJsonObject{
                    {"socketId", client->socket.socketId()}, {"state", QJsonObject{{"isServerMuted", false}}}}});
            }
            if (event == "room-joined") {
                client->joined = true; client->screen.startInjected();
                if (n < 2 && !clients[size_t(n + 1)]->socket.ready()) clients[size_t(n + 1)]->socket.connectTo(url, qEnvironmentVariable("TRISCORD_TEST_INVITE"));
                if (n == 2 && awaiting) { for (auto& endpoint : clients) { endpoint->images.clear(); endpoint->voices.clear(); endpoint->screenSounds.clear(); } awaiting = false; }
            }
            if (stopping && event == "user-state-updated" && args.first().toObject().value("socketId").toString() == stoppedId &&
                args.first().toObject().value("state").toObject().contains("isScreenSharing") &&
                !args.first().toObject().value("state").toObject().value("isScreenSharing").toBool() && n == 0) {
                QTimer::singleShot(300, &app, [&] {
                    afterStopFrames = 0;
                    QTimer::singleShot(600, &app, [&] {
                        generator.stop();
                        if (afterStopFrames) { std::fprintf(stderr, "Frames delivered after share stop\n"); app.exit(5); return; }
                        std::printf("PASS: 3 room clients exchanged screen images, call voice and separate screen audio simultaneously; real Socket.IO, typed signaling, rejoin and stopped-stream cleanup\n"); app.exit(0);
                    });
                });
            }
        });
        QObject::connect(&client->screen, &ScreenService::frameReady, &app, [&, client](const QString& id, const QImage& image) {
            if (id == "$local") return;
            if (image.isNull() || image.width() > 1280 || image.height() > 720 || std::abs(qGray(image.pixel(image.width()/2,image.height()/2)) - 94) > 8) {
                std::fprintf(stderr, "Invalid room video image\n"); app.exit(6); return;
            }
            ++client->images[id]; if (stopping && id == stoppedId) ++afterStopFrames;
        });
        QObject::connect(&client->voice, &VoiceService::remoteAudio, &app, [client](const QString& id, const VoiceFrame& pcm) {
            double energy = 0; for (auto sample : pcm) energy += sample * sample;
            if (energy > .1) ++client->voices[id];
        });
        QObject::connect(&client->screen, &ScreenService::screenAudio, &app, [&, client](const QString& id, const VoiceFrame& pcm) {
            double energy = 0; for (auto sample : pcm) energy += sample * sample;
            if (energy > .1) ++client->screenSounds[id];
            if (stopping && id == stoppedId) ++afterStopFrames;
        });
        QObject::connect(&client->screen, &ScreenService::message, &app, [](const QString& message) { std::fprintf(stderr, "%s\n", message.toUtf8().constData()); });
    }
    QObject::connect(&generator, &QTimer::timeout, &app, [&] {
        bool complete = !awaiting && !stopping;
        for (auto& client : clients) {
            if (!client->joined) { complete = false; continue; }
            for (const auto& frame : client->video.poll()) client->screen.sendFrame(frame);
            if (client->video.ready()) {
                QByteArray input(640*360*3/2,char(128)); std::fill(input.begin(), input.begin()+640*360,char(97));
                if (client->video.submit(input, qint64(client->sent)*333333)) ++client->sent;
            }
            VoiceFrame pcm{}; for (int i = 0; i < VoiceSamples; ++i) pcm[i] = .2f * std::sin(2*3.141592653589793*440*i/VoiceRate);
            client->voice.sendOpus(client->audio.encode(pcm));
            client->screen.sendAudio(client->screenSound.encode(pcm));
            if (client->images.size() != 2 || client->voices.size() != 2 || client->screenSounds.size() != 2) complete = false;
            for (const auto& [id, count] : client->images) { (void)id; if (count < 5) complete = false; }
            for (const auto& [id, count] : client->voices) { (void)id; if (count < 5) complete = false; }
            for (const auto& [id, count] : client->screenSounds) { (void)id; if (count < 5) complete = false; }
        }
        if (!complete || pauseChecking) return;
        if (!pauseTested) {
            pauseChecking = true;
            const auto id = clients[1]->socket.socketId();
            clients[0]->screen.setVideoDisabled(id, true);
            QTimer::singleShot(250, &app, [&, id] {
                const int frames = clients[0]->images[id], voice = clients[0]->voices[id], audio = clients[0]->screenSounds[id];
                const auto other = clients[2]->socket.socketId(); const int otherFrames = clients[0]->images[other];
                QTimer::singleShot(700, &app, [&, id, other, frames, voice, audio, otherFrames] {
                    if (clients[0]->images[id] != frames || clients[0]->voices[id] <= voice ||
                        clients[0]->screenSounds[id] <= audio || clients[0]->images[other] <= otherFrames) {
                        std::fprintf(stderr, "Video pause affected call/stream audio or other video\n"); app.exit(7); return;
                    }
                    clients[0]->images[id] = 0; clients[0]->screen.setVideoDisabled(id, false);
                    pauseTested = true; pauseChecking = false;
                    std::printf("PASS: local video pause stops frames while voice, screen audio and other streams continue; resume requested\n");
                });
            });
            return;
        }
        if (!audioMuteTested) {
            pauseChecking = true;
            const auto id = clients[1]->socket.socketId(); clients[0]->screen.setStreamMuted(id, true);
            QTimer::singleShot(250, &app, [&, id] {
                const int sound = clients[0]->screenSounds[id], voice = clients[0]->voices[id], video = clients[0]->images[id];
                const auto other = clients[2]->socket.socketId(); const int otherSound = clients[0]->screenSounds[other];
                QTimer::singleShot(700, &app, [&, id, other, sound, voice, video, otherSound] {
                    if (clients[0]->screenSounds[id] != sound || clients[0]->voices[id] <= voice ||
                        clients[0]->images[id] <= video || clients[0]->screenSounds[other] <= otherSound) {
                        std::fprintf(stderr, "Stream mute affected voice/video or another stream\n"); app.exit(8); return;
                    }
                    clients[0]->screenSounds[id] = 0; clients[0]->screen.setStreamMuted(id, false);
                    audioMuteTested = true; pauseChecking = false;
                    std::printf("PASS: stream audio mute is independent of voice, video and other streams; unmute requested\n");
                });
            });
            return;
        }
        if (!roomMuteTested) {
            pauseChecking = roomMuteChecking = true;
            const auto id = clients[1]->socket.socketId(); clients[0]->socket.sendEvent("force-mute-user", {{"socketId", id}});
            QTimer::singleShot(250, &app, [&, id] {
                const int voice = clients[0]->voices[id], video = clients[0]->images[id], sound = clients[0]->screenSounds[id];
                const auto other = clients[2]->socket.socketId(); const int otherVoice = clients[0]->voices[other];
                QTimer::singleShot(700, &app, [&, id, other, voice, video, sound, otherVoice] {
                    if (clients[0]->voices[id] != voice || clients[0]->images[id] <= video ||
                        clients[0]->screenSounds[id] <= sound || clients[0]->voices[other] <= otherVoice) {
                        std::fprintf(stderr, "Room voice restriction failed or affected unrelated media\n"); app.exit(9); return;
                    }
                    clients[0]->voices[id] = 0;
                    clients[0]->socket.sendEvent("force-mute-user", {{"socketId", id}, {"muted", false}});
                    roomMuteTested = true; roomMuteChecking = pauseChecking = false;
                    std::printf("PASS: receiver enforces room mute against a source ignoring it; video/screen audio/other voice continue\n");
                });
            });
            return;
        }
        if (!reconnect) {
            reconnect = awaiting = true; clients.back()->joined = false; clients.back()->socket.disconnectFromServer();
            QTimer::singleShot(250, &app, [&] { clients.back()->socket.connectTo(url, qEnvironmentVariable("TRISCORD_TEST_INVITE")); }); return;
        }
        stopping = true; stoppedId = clients.back()->socket.socketId(); clients.back()->screen.stop();
    });
    QTimer::singleShot(30000, &app, [&] {
        for (size_t n=0; n<clients.size(); ++n) std::fprintf(stderr,"client %zu images=%zu voice=%zu sent=%d\n",n,clients[n]->images.size(),clients[n]->voices.size(),clients[n]->sent);
        std::fprintf(stderr,"Screen room test timeout\n"); app.exit(4);
    });
    generator.start(); clients[0]->socket.connectTo(url, qEnvironmentVariable("TRISCORD_TEST_INVITE")); return app.exec();
}
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    try { return run(app, argc, argv); }
    catch (const std::exception& error) { std::fprintf(stderr,"%s\n",error.what()); return 1; }
}
