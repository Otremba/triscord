#include "voice_processing.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <algorithm>
#include <cmath>
#include <iostream>

// Isolated DSP+Opus cost. No devices, network, UI, resource polling or recordings.
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    QJsonArray results;
    for (int mode = 0; mode < 4; ++mode) {
        triscord::VoiceEncoder encoder;
        triscord::VoiceProcessor processor;
        processor.setOptions(mode & 1, mode & 2);
        std::vector<double> samples;
        QElapsedTimer timer;
        for (int n = 0; n < 5200; ++n) {
            triscord::VoiceFrame mic{}, reference{};
            for (int i = 0; i < triscord::VoiceSamples; ++i) {
                const double time = (n * triscord::VoiceSamples + i) / double(triscord::VoiceRate);
                reference[i] = 0.1f * std::sin(2 * 3.141592653589793 * 440 * time);
                mic[i] = 0.15f * std::sin(2 * 3.141592653589793 * 220 * time) + reference[i] * 0.3f;
            }
            timer.start();
            const auto packet = encoder.encode(processor.process(mic, reference));
            if (packet.isEmpty()) return 5;
            if (n >= 200) samples.push_back(timer.nsecsElapsed() / 1000.0);
        }
        double total = 0; for (auto time : samples) total += time;
        std::sort(samples.begin(), samples.end());
        results.append(QJsonObject{{"noise", bool(mode & 1)}, {"echo", bool(mode & 2)},
            {"frames", int(samples.size())}, {"meanMicroseconds", total / samples.size()},
            {"p95Microseconds", samples[samples.size() * 95 / 100]}, {"maxMicroseconds", samples.back()}});
    }
    std::cout << QJsonDocument(QJsonObject{{"scope", "isolated synthetic DSP plus Opus, not whole application performance"},
        {"frameMilliseconds", 20}, {"results", results}}).toJson().toStdString();
}
