#include "system_audio.h"
#include "voice_processing.h"
#include <QGuiApplication>
#include <QMediaDevices>
#include <QAudioSink>
#include <QTimer>
#include <QThread>
#include <cmath>
#include <cstdio>
using namespace triscord;
int main(int argc, char** argv) {
    QGuiApplication app(argc, argv);
    if (argc != 2) return 2;
    const bool captureMode = QString::fromLocal8Bit(argv[1]) == "--capture";
    if (!captureMode && QString::fromLocal8Bit(argv[1]) != "--tone") return 2;
    const auto device = QMediaDevices::defaultAudioOutput(); if (device.isNull()) return 2;
    const auto format = device.preferredFormat(); QAudioSink sink(device, format);
    auto* writer = sink.start(); if (!writer) return 2;
    QTimer playback; playback.setInterval(10); qint64 sample = 0;
    QObject::connect(&playback, &QTimer::timeout, &app, [&] {
        const int count = format.sampleRate() / 50;
        if (sink.bytesFree() < format.bytesForFrames(count)) return;
        std::vector<float> pcm(count);
        for (auto& value : pcm) value = float(.03 * std::sin(2 * 3.141592653589793 * (captureMode ? 997 : 613) * sample++ / format.sampleRate()));
        writer->write(encodeMono(pcm, format));
    }); playback.start();
    QThread mediaThread; auto* capture = new SystemAudio;
    capture->moveToThread(&mediaThread); QObject::connect(&mediaThread, &QThread::finished, capture, &QObject::deleteLater);
    mediaThread.start();
    VoiceDecoder decoder; int frames = 0; double external = 0, self = 0;
    if (captureMode) {
        QObject::connect(capture, &SystemAudio::error, &app, [&](const QString& message) { std::fprintf(stderr,"%s\n",message.toUtf8().constData()); app.exit(3); });
        QObject::connect(capture, &SystemAudio::captured, &app, [&](const QByteArray& packet) {
            const auto pcm = decoder.decode(packet); ++frames;
            for (auto frequency : {613,997}) {
                double re=0, im=0;
                for(int n=0;n<VoiceSamples;++n) { const double phase=2*3.141592653589793*frequency*n/VoiceRate; re+=pcm[n]*std::cos(phase); im+=pcm[n]*std::sin(phase); }
                const double energy=(re*re+im*im)/(VoiceSamples*VoiceSamples);
                (frequency==613 ? external : self) += energy;
            }
        });
        bool started = false; QMetaObject::invokeMethod(capture, [&] { started = capture->start(); }, Qt::BlockingQueuedConnection);
        if (!started) { std::fprintf(stderr,"%s\n",capture->failureReason().toUtf8().constData()); mediaThread.quit(); mediaThread.wait(); return 3; }
    }
    QTimer::singleShot(captureMode ? 5000 : 7000, &app, [&] {
        QMetaObject::invokeMethod(capture, &SystemAudio::stop, Qt::BlockingQueuedConnection); playback.stop(); sink.stop();
        if (!captureMode) { app.quit(); return; }
        std::printf("Loopback frames=%d external-energy=%.6f own-energy=%.6f\n",frames,external/std::max(frames,1),self/std::max(frames,1));
        if (frames < 30 || external/std::max(frames,1) < .00001 || self > external*.08) { app.exit(4); return; }
        std::puts("PASS: external application audio captured; same-process audio excluded from Opus output"); app.quit();
    }); const auto result = app.exec();
    QMetaObject::invokeMethod(capture, &SystemAudio::stop, Qt::BlockingQueuedConnection);
    mediaThread.quit(); mediaThread.wait(); return result;
}
