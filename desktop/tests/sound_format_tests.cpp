#include "sound_format.h"
#include <QAudioBufferOutput>
#include <QtTest>
using namespace triscord;

class SoundFormatTests : public QObject {
    Q_OBJECT
private slots:
    void keepsSupportedFloatStereo() {
        const auto wanted = soundPcmFormat();
        QCOMPARE(soundOutputFormat({}, [&](const auto& f) { return f == wanted; }), wanted);
    }
    void fallsBackToSigned16BitStereo() {
        auto wanted = soundPcmFormat(); wanted.setSampleFormat(QAudioFormat::Int16);
        const auto chosen = soundOutputFormat({}, [&](const auto& f) { return f == wanted; });
        QCOMPARE(chosen, wanted);
        QAudioBufferOutput decoder(chosen);
        QCOMPARE(decoder.format(), chosen); // Decoder bytes must use exactly the sink format, not float reinterpreted as int16.
    }
    void respectsDeviceRateAndExplicitChannelLayout() {
        QAudioFormat preferred;
        preferred.setSampleRate(44100); preferred.setChannelCount(2); preferred.setSampleFormat(QAudioFormat::Int16);
        auto wanted = preferred; wanted.setChannelConfig(QAudioFormat::ChannelConfigStereo);
        QCOMPARE(soundOutputFormat(preferred, [&](const auto& f) { return f == wanted; }), wanted);
    }
    void supportsMonoAndSurroundDevices() {
        for (const auto config : {QAudioFormat::ChannelConfigMono, QAudioFormat::ChannelConfigSurround5Dot1}) {
            QAudioFormat wanted;
            wanted.setSampleRate(96000); wanted.setChannelConfig(config); wanted.setSampleFormat(QAudioFormat::Int32);
            QCOMPARE(soundOutputFormat(wanted, [&](const auto& f) { return f == wanted; }), wanted);
        }
    }
    void refusesUnsupportedOrInvalidFormats() {
        QVERIFY(!soundOutputFormat(soundPcmFormat(), [](const auto&) { return false; }).isValid());
        auto preferred = soundPcmFormat(); preferred.setSampleRate(1000);
        QVERIFY(!soundOutputFormat(preferred, [&](const auto& f) { return f == preferred; }).isValid());
        preferred.setSampleRate(48000); preferred.setChannelCount(16);
        QVERIFY(!soundOutputFormat(preferred, [&](const auto& f) { return f == preferred; }).isValid());
    }
};
QTEST_GUILESS_MAIN(SoundFormatTests)
#include "sound_format_tests.moc"
