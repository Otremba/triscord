#include "video_rtp.h"
#include <QtTest>

using namespace triscord;
namespace {
QByteArray rtp(uint16_t sequence, uint32_t timestamp, QByteArray payload, bool marker = false) {
    QByteArray packet(12, 0); packet[0] = char(128); packet[1] = char(102 | (marker ? 128 : 0));
    packet[2] = char(sequence >> 8); packet[3] = char(sequence);
    for (int n = 0; n < 4; ++n) packet[4 + n] = char(timestamp >> (24 - 8 * n));
    packet[11] = 1; packet += payload; return packet;
}
QByteArray idr() { return QByteArray::fromHex("7800026742000268ce000265aa"); } // STAP-A SPS/PPS/IDR.
}
class VideoRtpTests : public QObject {
    Q_OBJECT
private slots:
    // 19/10, stream "sometimes bad" for a viewer: a lost packet is NACKed and the packets behind it wait for the
    // retransmission, so the frame assembles instead of freezing until a keyframe.
    void lossIsNackedAndHeldUntilRetransmission() {
        using namespace std::chrono;
        const auto t0 = steady_clock::now();
        VideoRtpReorder reorder;
        VideoRtpAssembler receiver;
        auto feed = [&](const VideoRtpReorder::Result& result) {
            std::optional<ReceivedVideo> last;
            for (const auto& packet : result.ready) if (auto frame = receiver.push(packet)) last = frame;
            return last;
        };
        QVERIFY(feed(reorder.push(rtp(10, 0, idr(), true), t0)));
        auto result = reorder.push(rtp(11, 3000, QByteArray::fromHex("7c81aa")), t0);
        QCOMPARE(result.ready.size(), size_t(1));
        QVERIFY(!feed(result));
        result = reorder.push(rtp(13, 3000, QByteArray::fromHex("7c41cc"), true), t0 + milliseconds(1));   // 12 lost
        QVERIFY(result.ready.empty());
        QCOMPARE(result.nack, std::vector<uint16_t>{12});
        QVERIFY(!feed(result));
        result = reorder.push(rtp(12, 3000, QByteArray::fromHex("7c01bb")), t0 + milliseconds(60));   // retransmitted
        QVERIFY(result.nack.empty());
        QCOMPARE(result.ready.size(), size_t(2));
        auto frame = feed(result);
        QVERIFY(frame); QCOMPARE(frame->annexB, QByteArray::fromHex("0000000161aabbcc"));
        QVERIFY(!receiver.takeRecoveryRequest());
        QCOMPARE(reorder.recovered(), 1);
        // Nothing comes back within 150 ms: the gap is let through and the assembler asks for a keyframe, as before.
        reorder.push(rtp(15, 6000, QByteArray::fromHex("41dd"), true), t0 + milliseconds(100));   // 14 lost for good
        result = reorder.push(rtp(16, 9000, QByteArray::fromHex("41ee"), true), t0 + milliseconds(260));
        QCOMPARE(result.lost, 1);
        QCOMPARE(result.ready.size(), size_t(2));
        feed(result);
        QVERIFY(receiver.takeRecoveryRequest());
        // A late retransmission after giving up is ignored; sequence numbers wrap.
        QVERIFY(reorder.push(rtp(14, 3000, QByteArray::fromHex("41ff"), true), t0 + milliseconds(270)).ready.empty());
        VideoRtpReorder wrap;
        QCOMPARE(wrap.push(rtp(65535, 0, idr(), true), t0).ready.size(), size_t(1));
        result = wrap.push(rtp(1, 3000, idr(), true), t0);
        QCOMPARE(result.nack, std::vector<uint16_t>{0});
    }
    void nackPacketMatchesRfc4585() {
        const auto packet = rtcpNack(0x01020304, {100, 101, 103, 140});
        QCOMPARE(packet.size(), 20);   // header + 2 FCI entries
        QCOMPARE(uint8_t(packet[0]), uint8_t(0x81));
        QCOMPARE(uint8_t(packet[1]), uint8_t(205));
        QCOMPARE((uint8_t(packet[2]) << 8) | uint8_t(packet[3]), 4);   // length in words minus one
        QCOMPARE(packet.mid(8, 4), QByteArray::fromHex("01020304"));
        QCOMPARE(packet.mid(12, 4), QByteArray::fromHex("00640005"));   // PID 100, BLP: 101 and 103
        QCOMPARE(packet.mid(16, 4), QByteArray::fromHex("008c0000"));   // PID 140
        QVERIFY(rtcpNack(1, {}).isEmpty());
    }
    void joinsOnlyAtSpsPpsIdr() {
        VideoRtpAssembler receiver;
        QVERIFY(!receiver.push(rtp(1, 0, QByteArray::fromHex("41aa"), true)));
        QVERIFY(receiver.takeRecoveryRequest());
        auto frame = receiver.push(rtp(2, 3000, idr(), true));
        QVERIFY(frame); QVERIFY(frame->keyframe);
        QCOMPARE(frame->annexB, QByteArray::fromHex("0000000167420000000168ce0000000165aa"));
        QVERIFY(!receiver.push(rtp(2, 3000, idr(), true)));
        QVERIFY(receiver.push(rtp(3, 6000, QByteArray::fromHex("41bb"), true)));
    }
    void fragmentedFrameReordersAndWrapsSequence() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(65532, 0, idr(), true)));
        QVERIFY(!receiver.push(rtp(0, 3000, QByteArray::fromHex("7c41cc"), true)));
        QVERIFY(!receiver.push(rtp(65534, 3000, QByteArray::fromHex("7c01aa"))));
        QVERIFY(!receiver.push(rtp(65535, 3000, QByteArray::fromHex("7c01bb"))));
        auto result = receiver.push(rtp(65533, 3000, QByteArray::fromHex("7c81dd")));
        QVERIFY(result); QCOMPARE(result->annexB, QByteArray::fromHex("0000000161ddaabbcc"));
    }
    void lossSkipsDeltasUntilRecovery() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(0, 0, idr(), true)));
        QVERIFY(!receiver.push(rtp(1, 3000, QByteArray::fromHex("7c81aa"))));
        QVERIFY(!receiver.push(rtp(3, 3000, QByteArray::fromHex("7c41cc"), true)));
        QVERIFY(!receiver.push(rtp(4, 6000, QByteArray::fromHex("41dd"), true)));
        QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(receiver.push(rtp(5, 9000, idr(), true)));
        QVERIFY(!receiver.push(rtp(2, 3000, QByteArray::fromHex("7c01bb")))); // Too late.
    }
    void excessiveSameTimestampIsDiscarded() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(0, 0, idr(), true)));
        for (int n = 1; n <= VideoPacketLimit + 1; ++n) QVERIFY(!receiver.push(rtp(uint16_t(n), 3000, QByteArray::fromHex("41aa"))));
        QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(!receiver.push(rtp(VideoPacketLimit + 2, 3000, idr(), true)));
        // No marker was available to infer the next first sequence number.
        QVERIFY(receiver.push(rtp(VideoPacketLimit + 3, 6000, idr(), true)));
    }
    void extensionsCsrcAndPaddingAreHandled() {
        VideoRtpAssembler receiver;
        auto packet = rtp(0, 0, idr(), true);
        packet[0] = char(177); // RTP v2, padding, extension, one CSRC.
        packet.insert(12, QByteArray::fromHex("00000002bede000101000000"));
        packet += QByteArray::fromHex("00000004");
        auto frame = receiver.push(packet);
        QVERIFY(frame); QVERIFY(frame->keyframe);
    }
    void excessiveBytesAreDiscardedBeforePacketLimit() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(0, 0, idr(), true)));
        for (int n = 1; n <= VideoPacketLimit; ++n)
            QVERIFY(!receiver.push(rtp(uint16_t(n), 3000, QByteArray(1400, char(65)))));
        QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(!receiver.push(rtp(VideoPacketLimit + 1, 3000, idr(), true)));
        QVERIFY(receiver.push(rtp(VideoPacketLimit + 2, 6000, idr(), true)));
    }
    void oldPartialFrameExpires() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(0, 0, idr(), true)));
        QVERIFY(!receiver.push(rtp(1, 3000, QByteArray::fromHex("7c81aa"))));
        QTest::qWait(230);
        QVERIFY(!receiver.push(rtp(2, 3000, QByteArray::fromHex("7c41bb"), true)));
        QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(receiver.push(rtp(3, 6000, idr(), true)));
    }
    void incompleteFragmentNeverReachesDecoder() {
        VideoRtpAssembler receiver;
        QVERIFY(receiver.push(rtp(0, 0, idr(), true)));
        QVERIFY(!receiver.push(rtp(1, 3000, QByteArray::fromHex("7c81aa"), true)));
        QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(!receiver.push(rtp(2, 6000, QByteArray::fromHex("41bb"), true)));
        QVERIFY(receiver.push(rtp(3, 9000, idr(), true)));
    }
    void malformedHeadersAndPayloadsRecover() {
        for (auto malformed : {QByteArray(1, 0), rtp(0, 0, QByteArray::fromHex("78ffffaa"), true),
                rtp(0, 0, QByteArray::fromHex("7cc1aa"), true), rtp(0, 0, QByteArray::fromHex("80aa"), true)}) {
            VideoRtpAssembler receiver;
            QVERIFY(!receiver.push(malformed)); QVERIFY(receiver.takeRecoveryRequest());
            QVERIFY(receiver.push(rtp(1, 3000, idr(), true)));
        }
        VideoRtpAssembler receiver;
        auto extension = rtp(0, 0, idr(), true); extension[0] = char(144); extension.insert(12, QByteArray::fromHex("bedeffff"));
        QVERIFY(!receiver.push(extension)); QVERIFY(receiver.takeRecoveryRequest());
        QVERIFY(receiver.push(rtp(1, 3000, idr(), true)));
    }
    void timestampClockRejectsLateAndUnwraps() {
        VideoRtpClock clock;
        QCOMPARE(clock.accept(0xffffff00U), std::optional<qint64>(0));
        QCOMPARE(clock.accept(0xffffff00U + 3000U), std::optional<qint64>(333333));
        QVERIFY(!clock.accept(0xffffff00U + 3000U));
        QVERIFY(!clock.accept(0xffffff00U));
        QCOMPARE(clock.accept(0xffffff00U + 6000U), std::optional<qint64>(666666));
    }
};
QTEST_GUILESS_MAIN(VideoRtpTests)
#include "video_rtp_tests.moc"
