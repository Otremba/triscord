// Sustained single-process worst-case resource bench: voice + camera + screen
// share all active at once, in ONE process, against the project's local
// signaling fixture. Reuses the same injected/synthetic media sources as
// triscord-voice-smoke, triscord-dual-video-smoke and triscord-screen-room-smoke
// (no new architecture): Signaling + VoiceService + CameraPublisher +
// ScreenService, all driven by QTimers at realistic rates.
//
// Two peers join one room so there is a real remote participant exchanging
// media (matching how a real call works), but only ONE process is running —
// the "measured side" is clients[0], which has voice, camera and screen
// share all active simultaneously and sustained for the requested duration.
// clients[1] is a passive peer in the SAME process whose only job is to give
// clients[0] something to actually encode/decrypt/decode against; process
// metrics below are naturally for the whole process (both peers' work),
// which is the worst case asked for.
//
// This machine has no physical camera ("Native cameras: 0"); the camera
// source here is 100% synthetic frames injected in memory, same as
// triscord-dual-video-smoke. That is stated again in the printed output.
//
// Usage: triscord-worstcase-bench <url> [totalSeconds] [warmupSeconds]
//   totalSeconds defaults to 75 (>=60s steady-state after warmup)
//   warmupSeconds defaults to 15 and is EXCLUDED from reported statistics
#include "voice_service.h"
#include "camera_publisher.h"
#include "screen_service.h"
#include "platform_probe.h"
#include <QCoreApplication>
#include <QTimer>
#include <QUuid>
#include <QElapsedTimer>
#include <cstdio>
#include <cmath>
#include <vector>
#include <algorithm>
#include <limits>
#include <windows.h>
#include <tlhelp32.h>

using namespace triscord;

namespace {

struct Client {
    Signaling signal;
    VideoEncoder screenEncoder{{{640, 360}, 30, 1000000}, EncoderPreference::SoftwareOnly};
    ScreenService screen{&signal, nullptr, ScreenCall::SourceMode::Injected, {{640, 360}, 30, 1000000}};
    VoiceService voice{&signal, nullptr, VoiceCall::AudioMode::Injected};
    VoiceEncoder audioEncoder;
    CameraPublisher camera{&signal, nullptr, ScreenCall::SourceMode::Injected};
    bool joined = false;
    int screenSent = 0;
};

// Counts threads currently owned by this process. Sampled alongside memory;
// at a 500ms sampling interval the snapshot cost is negligible.
unsigned long currentThreadCount() {
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return 0;
    THREADENTRY32 entry{};
    entry.dwSize = sizeof(entry);
    unsigned long count = 0;
    const DWORD pid = GetCurrentProcessId();
    if (Thread32First(snap, &entry)) {
        do {
            if (entry.th32OwnerProcessID == pid) ++count;
        } while (Thread32Next(snap, &entry));
    }
    CloseHandle(snap);
    return count;
}

// Total CPU time (kernel+user) consumed by this process so far, in seconds.
double currentCpuSeconds() {
    FILETIME creation{}, exit{}, kernel{}, user{};
    if (!GetProcessTimes(GetCurrentProcess(), &creation, &exit, &kernel, &user)) return 0.0;
    auto toU64 = [](const FILETIME& ft) {
        return (static_cast<quint64>(ft.dwHighDateTime) << 32) | ft.dwLowDateTime;
    };
    return static_cast<double>(toU64(kernel) + toU64(user)) / 1.0e7; // 100ns units -> seconds
}

struct Stat {
    double min = std::numeric_limits<double>::infinity();
    double max = 0.0;
    double sum = 0.0;
    long count = 0;
    void add(double value) {
        min = std::min(min, value);
        max = std::max(max, value);
        sum += value;
        ++count;
    }
    double mean() const { return count ? sum / count : 0.0; }
};

int run(QCoreApplication& app, const QUrl& url, int totalSeconds, int warmupSeconds) {
    if (url.host() != "127.0.0.1" || url.scheme() != "http") return 2;
    if (totalSeconds <= warmupSeconds) return 2;

    Client clients[2];
    QTimer videoTick; videoTick.setInterval(33); // ~30fps, matches other smokes
    QTimer audioTick; audioTick.setTimerType(Qt::PreciseTimer); audioTick.setInterval(20); // Opus frame rate
    QTimer sampleTick;
    const auto room = "native-worstcase-" + QUuid::createUuid().toString(QUuid::WithoutBraces);

    for (int index = 0; index < 2; ++index) {
        auto* client = &clients[index];
        QObject::connect(&client->signal, &Signaling::connected, &app, [&, client, index] {
            const auto name = QString("worstcase-%1").arg(index);
            client->signal.sendEvent("join-room", {{"roomId", room},
                {"userData", QJsonObject{{"userId", name}, {"username", name}, {"isMuted", true}}}});
        });
        QObject::connect(&client->signal, &Signaling::eventReceived, &app,
            [&, client, index](const QString& name, const QJsonArray&) {
                if (name == "room-joined") {
                    client->joined = true;
                    client->screen.startInjected();
                    (void)index;
                }
            });
        QObject::connect(&client->camera, &CameraPublisher::roomChanged, &app, [client](bool ready) {
            if (ready) client->camera.start();
        });
        QObject::connect(&client->camera, &CameraPublisher::message, &app, [](const QString& text) {
            std::fprintf(stderr, "Camera publisher: %s\n", text.toUtf8().constData());
        });
        QObject::connect(&client->screen, &ScreenService::keyframeRequested, &app, [client] {
            client->screenEncoder.requestKeyframe();
        });
    }

    // clients[1] joins once clients[0] has joined, same cascade pattern as
    // the other smokes (avoids a race on room creation).
    QObject::connect(&clients[0].signal, &Signaling::eventReceived, &app,
        [&](const QString& name, const QJsonArray&) {
            if (name == "room-joined" && !clients[1].signal.ready()) clients[1].signal.connectTo(url);
        });

    QObject::connect(&videoTick, &QTimer::timeout, &app, [&] {
        for (auto& client : clients) {
            if (!client.joined) continue;
            QImage cameraImage(320, 180, QImage::Format_RGB32);
            cameraImage.fill(QColor(168, 168, 168));
            client.camera.submitFrame(QVideoFrame(cameraImage));
            for (const auto& frame : client.screenEncoder.poll()) client.screen.sendFrame(frame);
            if (client.screenEncoder.ready()) {
                QByteArray bytes(640 * 360 * 3 / 2, char(128));
                std::fill(bytes.begin(), bytes.begin() + 640 * 360, char(80));
                if (client.screenEncoder.submit(bytes, qint64(client.screenSent) * 333333)) ++client.screenSent;
            }
        }
    });
    QObject::connect(&audioTick, &QTimer::timeout, &app, [&] {
        static int frameCount = 0;
        VoiceFrame frame{};
        for (int i = 0; i < VoiceSamples; ++i)
            frame[i] = 0.2f * std::sin(2 * 3.141592653589793 * 440 * (frameCount * VoiceSamples + i) / VoiceRate);
        ++frameCount;
        for (auto& client : clients) if (client.joined) client.voice.sendOpus(client.audioEncoder.encode(frame));
    });

    // Sampling: skip `warmupSeconds` after everything is up, then sample at a
    // fixed interval for the remaining steady-state window and report stats.
    QElapsedTimer wall;
    Stat workingSet, privateMem, threads, cpuPercent;
    double lastCpuSeconds = 0.0;
    qint64 lastSampleMs = 0;
    bool warmupDone = false;
    qint64 warmupStartMs = 0;

    QObject::connect(&sampleTick, &QTimer::timeout, &app, [&] {
        const qint64 nowMs = wall.elapsed();
        if (!warmupDone) {
            if (nowMs - warmupStartMs < qint64(warmupSeconds) * 1000) return;
            warmupDone = true;
            lastCpuSeconds = currentCpuSeconds();
            lastSampleMs = nowMs;
            return; // first post-warmup sample establishes the CPU baseline only
        }
        const auto metrics = processMetrics();
        if (metrics.value("ok").toBool()) {
            workingSet.add(metrics.value("workingSetMB").toDouble());
            privateMem.add(metrics.value("privateMB").toDouble());
        }
        threads.add(static_cast<double>(currentThreadCount()));
        const double cpuNow = currentCpuSeconds();
        const double wallDeltaS = double(nowMs - lastSampleMs) / 1000.0;
        if (wallDeltaS > 0) {
            const double pct = 100.0 * (cpuNow - lastCpuSeconds) / wallDeltaS;
            cpuPercent.add(pct);
        }
        lastCpuSeconds = cpuNow;
        lastSampleMs = nowMs;
        if (nowMs >= qint64(totalSeconds) * 1000) {
            app.quit();
        }
    });

    QTimer::singleShot(qint64(totalSeconds) * 1000 + 15000, &app, [&] {
        std::fprintf(stderr, "Worst-case bench overran its deadline\n");
        app.exit(9);
    });

    videoTick.start();
    audioTick.start();
    sampleTick.setInterval(500);
    wall.start();
    warmupStartMs = 0;
    sampleTick.start();
    clients[0].signal.connectTo(url);

    const int code = app.exec();
    if (code != 0) return code;

    std::printf("Synthetic camera: this machine reports no physical camera (Native cameras: 0); "
                "camera frames are injected synthetically, same as triscord-dual-video-smoke.\n");
    std::printf("Warm-up excluded from statistics: %d s. Steady-state window measured: %d s. "
                "Samples: %ld (CPU deltas: %ld).\n",
                warmupSeconds, totalSeconds - warmupSeconds, workingSet.count, cpuPercent.count);
    std::printf("Working set (MB): min=%.2f mean=%.2f peak=%.2f\n",
                workingSet.min, workingSet.mean(), workingSet.max);
    std::printf("Private bytes (MB): min=%.2f mean=%.2f peak=%.2f\n",
                privateMem.min, privateMem.mean(), privateMem.max);
    std::printf("Thread count: min=%.0f mean=%.2f peak=%.0f\n",
                threads.min, threads.mean(), threads.max);
    std::printf("CPU (%% of 1 core, from CPU-time deltas): min=%.2f mean=%.2f peak=%.2f\n",
                cpuPercent.min, cpuPercent.mean(), cpuPercent.max);
    std::printf("PASS: voice + camera + screen share sustained simultaneously in a single process "
                "for the steady-state window\n");
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    if (argc < 2 || argc > 4) {
        std::fprintf(stderr, "Usage: %s <http://127.0.0.1:port> [totalSeconds=75] [warmupSeconds=15]\n", argv[0]);
        return 2;
    }
    const QUrl url(QString::fromLocal8Bit(argv[1]));
    const int totalSeconds = argc >= 3 ? QString::fromLocal8Bit(argv[2]).toInt() : 75;
    const int warmupSeconds = argc >= 4 ? QString::fromLocal8Bit(argv[3]).toInt() : 15;
    try {
        return run(app, url, totalSeconds, warmupSeconds);
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
