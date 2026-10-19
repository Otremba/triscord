#include "video_peer.h"
#include <QCoreApplication>
#include <QTimer>
#include <QPoint>
#include <cstdio>
#include <cmath>

using namespace triscord;
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    try {
        const VideoConfig config{{640, 360}, 30, 1000000};
        rtc::Configuration rtcConfig; // Loopback only, no STUN/TURN/cloud service.
        VideoPeer a(rtcConfig), b(rtcConfig);
        VideoEncoder encodeA(config, EncoderPreference::SoftwareOnly), encodeB(config, EncoderPreference::SoftwareOnly);
        auto decodeA = std::make_unique<VideoDecoder>(config), decodeB = std::make_unique<VideoDecoder>(config);
        VideoRtpClock clockA, clockB;
        int receivedA = 0, receivedB = 0, sentA = 0, sentB = 0, pli = 0, recovered = 0;
        bool asked = false, waitIdr = false, sawLarge = false, done = false;
        QTimer generator;
        auto fail = [&](const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); generator.stop(); app.exit(1); };
        auto receive = [&](const QByteArray& bytes, uint32_t stamp, bool key, bool toA) {
            if (done) return;
            try {
                if (!toA && waitIdr) {
                    if (!key) return;
                    waitIdr = false;
                }
                auto& clock = toA ? clockA : clockB;
                auto& decoder = toA ? decodeA : decodeB;
                const auto time = clock.accept(stamp);
                if (!time) return;
                EncodedVideo frame{bytes, *time, 10000000 / config.fps, key};
                if (!decoder->submit(frame)) throw std::runtime_error("Network decoder remained busy");
                const auto frames = decoder->poll();
                const int index = int(std::lround(double(stamp) / 3000));
                for (const auto& image : frames) {
                    // Low-latency software decoder returns this sample directly.
                    // Four block interiors prove FU-A reconstruction and images.
                    for (auto point : {QPoint(100, 100), QPoint(300, 100), QPoint(100, 200), QPoint(300, 200)}) {
                        const int expected = (toA ? 155 : 65) + ((point.x() / 8 + point.y() / 8 + index / 4) % 2) * 40;
                        if (std::abs(int(uint8_t(image.nv12[point.y() * config.size.width() + point.x()])) - expected) > 10)
                            throw std::runtime_error("Network image differs from sender");
                    }
                    if (toA) ++receivedA; else { ++receivedB; if (asked && !waitIdr) ++recovered; }
                }
                if (receivedA >= 8 && receivedB >= 8 && !asked) {
                    asked = waitIdr = true; decodeB = std::make_unique<VideoDecoder>(config); clockB = {};
                    if (!b.requestKeyframe()) throw std::runtime_error("Network PLI not sent");
                }
                if (receivedA >= 20 && receivedB >= 20 && recovered >= 5 && pli && sawLarge) {
                    done = true;
                    generator.stop();
                    std::printf("PASS: 2 native peers received decoded H264 both ways over ICE/DTLS-SRTP; FU-A image reconstruction, RTCP PLI/IDR and decoder rejoin (A=%d B=%d PLI=%d)\n", receivedA, receivedB, pli);
                    app.exit(0);
                }
            } catch (const std::exception& error) { fail(error); }
        };
        QObject::connect(&a, &VideoPeer::localDescription, &b, &VideoPeer::applyDescription);
        QObject::connect(&b, &VideoPeer::localDescription, &a, &VideoPeer::applyDescription);
        QObject::connect(&a, &VideoPeer::localCandidate, &b, &VideoPeer::addCandidate);
        QObject::connect(&b, &VideoPeer::localCandidate, &a, &VideoPeer::addCandidate);
        QObject::connect(&a, &VideoPeer::videoReceived, &app, [&](const QByteArray& bytes, uint32_t stamp, bool key) { receive(bytes, stamp, key, true); });
        QObject::connect(&b, &VideoPeer::videoReceived, &app, [&](const QByteArray& bytes, uint32_t stamp, bool key) { receive(bytes, stamp, key, false); });
        QObject::connect(&a, &VideoPeer::keyframeRequested, &app, [&] { ++pli; encodeA.requestKeyframe(); });
        QObject::connect(&b, &VideoPeer::keyframeRequested, &app, [&] { encodeB.requestKeyframe(); });
        QObject::connect(&a, &VideoPeer::recoveryNeeded, &app, [&] { decodeA = std::make_unique<VideoDecoder>(config); clockA = {}; });
        QObject::connect(&b, &VideoPeer::recoveryNeeded, &app, [&] { decodeB = std::make_unique<VideoDecoder>(config); clockB = {}; });
        auto tick = [&](VideoEncoder& encoder, VideoPeer& peer, int& sent, int base) {
            for (const auto& frame : encoder.poll()) { sawLarge |= frame.annexB.size() > 1500; peer.sendVideo(frame); }
            if (!encoder.ready()) return;
            QByteArray input(config.nv12Bytes(), char(128));
            for (int y = 0; y < config.size.height(); ++y) for (int x = 0; x < config.size.width(); ++x)
                input[y * config.size.width() + x] = char(base + ((x / 8 + y / 8 + sent / 4) % 2) * 40);
            if (encoder.submit(input, qint64(sent) * (10000000 / config.fps))) ++sent;
        };
        QObject::connect(&generator, &QTimer::timeout, &app, [&] {
            try { if (a.connected() && b.connected()) { tick(encodeA, a, sentA, 65); tick(encodeB, b, sentB, 155); } }
            catch (const std::exception& error) { fail(error); }
        });
        generator.start(33); a.offer();
        QTimer::singleShot(15000, &app, [&] {
            std::fprintf(stderr, "Video transport timeout: A=%d B=%d PLI=%d\n", receivedA, receivedB, pli); app.exit(1);
        });
        return app.exec();
    } catch (const std::exception& error) { std::fprintf(stderr, "%s\n", error.what()); return 1; }
}
