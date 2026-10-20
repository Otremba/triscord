#include "quality_policy.h"
#include "signaling.h"
#include "window_lifecycle.h"
#include "log_filter.h"
#include "error_report_log.h"
#include <QJsonDocument>
#include <QSignalSpy>
#include <QtTest>
#include <QTemporaryDir>
#include <QUuid>
#include <QWebSocketServer>
#include <future>
#include <memory>

using namespace triscord;
class CoreTests : public QObject {
    Q_OBJECT
private slots:
    // Lines taken from a friend's log on 19/10: FFmpeg's blocks go, Triscord's own lines stay, even right after one.
    void logDropsFfmpegChatterOnly() {
        bool block = false;
        QVERIFY(dropLogLine("Input #0, mp3, from 'C:/Users/x/AppData/Local/Temp/TriscordNativePreview.JYLtyT.mp3':", block));
        QVERIFY(dropLogLine("  Metadata:", block));
        QVERIFY(dropLogLine("    encoded_by      : Amadeus Pro", block));
        QVERIFY(dropLogLine("  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 320 kb/s", block));
        QVERIFY(dropLogLine("[mp3float @ 000001d86b9869c0] Could not update timestamps for skipped samples.", block));
        QVERIFY(!dropLogLine("ui -> core: videoStageOccluders", block));
        QVERIFY(!dropLogLine("  indented, but not after an FFmpeg header", block));
        QVERIFY(!dropLogLine("video: 3 lost packets recovered by retransmission, 0 unrecoverable (last 10 s)", block));
        QVERIFY(!dropLogLine("[not ffmpeg] a bracketed line of ours", block));
        QVERIFY(!dropLogLine("", block));
    }
    void errorReportSignalsComeFromRealFailureLines() {
        // Diego's 0.9.37 log of 19/10: the decoder failed on every frame, then the share thumbnails.
        const QString diego = QStringLiteral(
            "19:42:40.151 Triscord 0.9.37, 2026-10-19T19:42:40\n"
            "19:43:08.103 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x1\n"
            "19:43:18.116 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x24\n"
            "19:43:28.214 video: asked the sender for a keyframe: decoder: COM video initialization HRESULT=2147549446 x37, incomplete frame x2\n"
            "19:50:09.414 capture: thumbnail 0 failed: Windows capture failed (0x80010106)\n"
            "19:53:19.124 warning: screen: start failed: Windows capture failed (0x80010106)\n");
        QCOMPARE(logSignals(diego), (QStringList{"screen-start", "decoder", "capture", "keyframe-storm"}));
        // A healthy session: a few keyframes and losses, one dropped connection; and an old log without the closing line.
        const QString healthy = QStringLiteral(
            "10:00:00.000 Triscord 0.9.37, 2026-10-19T10:00:00\n"
            "10:00:10.000 video: asked the sender for a keyframe: frame backlog x2\n"
            "10:00:20.000 video: 12 lost packets recovered by retransmission, 3 unrecoverable (last 10 s)\n"
            "10:00:30.000 signaling: connection closed (1006)\n"
            "10:00:40.000 voice: connection restored, rejoining the call\n");
        QVERIFY(logSignals(healthy).isEmpty());
        QVERIFY(logSignals(QString(healthy).replace("0.9.37", "0.9.39") + "10:01:00.000 Triscord closed\n").isEmpty());
        QCOMPARE(logSignals(QString(healthy).replace("0.9.37", "0.9.39")), QStringList{"unclean-exit"});
        QString loop = healthy;
        for (int n = 0; n < 3; ++n) loop += "10:02:00.000 voice: connection restored, rejoining the call\n10:02:01.000 signaling: heartbeat timeout\n";
        loop += "10:03:00.000 video: 9 lost packets recovered by retransmission, 60 unrecoverable (last 10 s)\n10:04:00.000 error: qt.core: fatal-ish\n";
        QCOMPARE(logSignals(loop), (QStringList{"packet-loss", "signaling", "voice-reconnect", "qt-error"}));
    }
    void errorReportTextKeepsTheHeaderAndHidesSecrets() {
        const QString log = "00:00:00.000 Triscord 0.9.39, x\nsession " + QString(64, 'a') + " for diego@example.com\n" + QString(2000, 'z') + "\nlast line\n";
        const auto text = reportText(log, 600);
        QVERIFY(text.startsWith("00:00:00.000 Triscord 0.9.39, x\n[…]\n"));
        QVERIFY(text.endsWith("last line\n"));
        QVERIFY(text.size() <= 600);
        const auto whole = reportText(log);
        QVERIFY(whole.contains("session <hex> for <email>"));
        QVERIFY(!whole.contains("diego@example.com"));
    }
    void loginItemWritesAndReadsBackItsCommand() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QSettings store(dir.filePath("run.ini"), QSettings::IniFormat);
        LoginItem item(&store);
        const QString exe = "C:/Program Files/Triscord/triscord.exe";
        QVERIFY(!item.enabled(exe));
        QVERIFY(item.setEnabled(true, exe));
        QVERIFY(item.enabled(exe));
        // Quoted, native separators, and the flag that lets a logon start stay in the tray.
        QCOMPARE(LoginItem::command(exe), QString("\"C:\\Program Files\\Triscord\\triscord.exe\" --startup"));
        QVERIFY(!item.enabled("C:/Elsewhere/triscord.exe"));   // a moved or reinstalled copy is not the registered one
        QVERIFY(item.setEnabled(false, exe));
        QVERIFY(!item.enabled(exe));
    }

    void startupArgumentMarksALogonStart() {
        QVERIFY(launchedAtLogin({"triscord-web.exe", "--startup"}));
        QVERIFY(!launchedAtLogin({"triscord-web.exe"}));
    }

    void windowPrefsDefaultToTrayOnAndAVisibleStart() {
        QTemporaryDir dir;
        QVERIFY(dir.isValid());
        QSettings store(dir.filePath("prefs.ini"), QSettings::IniFormat);
        auto prefs = WindowPrefs::load(store);
        QVERIFY(prefs.closeToTray);
        QVERIFY(!prefs.startMinimized);
        prefs.closeToTray = false;
        prefs.startMinimized = true;
        WindowPrefs::save(store, prefs);
        const auto saved = WindowPrefs::load(store);
        QVERIFY(!saved.closeToTray);
        QVERIFY(saved.startMinimized);
    }

    void instanceKeyFollowsTheSettingsLocation() {
        QCOMPARE(SingleInstance::keyFor("a"), SingleInstance::keyFor("a"));
        QVERIFY(SingleInstance::keyFor("a") != SingleInstance::keyFor("b"));
        QVERIFY(SingleInstance::keyFor("").startsWith("TriscordWeb-"));
    }

    void secondLaunchAsksThePrimaryToComeForward() {
        const auto key = SingleInstance::keyFor("test-" + QUuid::createUuid().toString());
        SingleInstance primary(key);
        QVERIFY(primary.isPrimary());
        QVERIFY(primary.startListening());
        QSignalSpy shown(&primary, &SingleInstance::showRequested);

        SingleInstance second(key);
        QVERIFY(!second.isPrimary());
        QVERIFY(!second.startListening());   // only the primary listens
        // The second launch is another process in real life, blocking while this one runs its event loop.
        auto delivered = std::async(std::launch::async, [&second] { return second.notifyPrimary(2000); });
        QTRY_COMPARE_WITH_TIMEOUT(shown.count(), 1, 3000);
        QVERIFY(delivered.get());
    }

    void aLaunchWithNobodyListeningGivesUp() {
        const auto key = SingleInstance::keyFor("test-" + QUuid::createUuid().toString());
        SingleInstance primary(key);   // holds the mutex but never listens (still starting up)
        SingleInstance second(key);
        QVERIFY(!second.isPrimary());
        QVERIFY(!second.notifyPrimary(400));
        QVERIFY(!primary.notifyPrimary(100));   // a primary never asks itself
    }

    void rejectsInvalidServers() {
        QVERIFY(Signaling::endpoint(QUrl("file:///tmp/foo")).isEmpty());
        QVERIFY(Signaling::endpoint(QUrl("https://user:password@example.com")).isEmpty());
        QCOMPARE(Signaling::endpoint(QUrl("https://example.com/community")).toString(),
                 QString("wss://example.com/community/socket.io/?EIO=4&transport=websocket"));
    }
    void reservesAudioUnderCongestion() {
        const auto b = allocateVideo(600000, 9, 0, 9);
        QCOMPARE(b.totalVideoBps, 0);
        QCOMPARE(b.focusedBps, 0);
        QCOMPARE(allocateVideo(0, 1, 0, 1).totalVideoBps, 0);
        QCOMPARE(allocateVideo(-1, 1, 0, 1).totalVideoBps, 0);
    }
    void totalBudgetDoesNotGrowWithAudience() {
        const auto one = allocateVideo(10000000, 1, 0, 9);
        const auto nine = allocateVideo(10000000, 9, 0, 9);
        QVERIFY(nine.focusedBps < one.focusedBps);
        QVERIFY(nine.totalVideoBps <= 7000000 - 128000 - 9 * 64000);
    }
    void focusAndSecondaryStayBounded() {
        for (int mbps = 0; mbps <= 100; ++mbps) {
            for (int focus = 0; focus <= 9; ++focus) {
                const auto b = allocateVideo(mbps * 1000000LL, focus, 9 - focus, 9);
                QVERIFY(b.focusedBps <= 4000000);
                QVERIFY(b.secondaryBps <= 500000);
                QVERIFY(b.totalVideoBps <= std::max<std::int64_t>(0, mbps * 700000LL - 704000));
                QVERIFY(b.totalVideoBps >= 0);
            }
        }
    }
    void noAudienceMeansNoVideo() { QCOMPARE(allocateVideo(100000000, 0, 0, 9).totalVideoBps, 0); }
    void offlineEventsAreNeverQueued() {
        Signaling client;
        QVERIFY(!client.sendEvent("webrtc-offer", {{"session", "old-session"}}));
    }
    void engineIoHandshakeHeartbeatAndEvents() {
        QWebSocketServer server("test", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        std::unique_ptr<QWebSocket> peer;
        QStringList packets;
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            peer.reset(server.nextPendingConnection());
            connect(peer.get(), &QWebSocket::textMessageReceived, this, [&](const QString& packet) {
                packets.append(packet);
                if (packet == "40") peer->sendTextMessage("40{\"sid\":\"test-socket\"}");
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        Signaling client;
        QSignalSpy events(&client, &Signaling::eventReceived);
        QSignalSpy errors(&client, &Signaling::protocolError);
        client.connectTo(QUrl(QString("http://127.0.0.1:%1").arg(server.serverPort())));
        QTRY_VERIFY_WITH_TIMEOUT(client.ready(), 2000);
        QVERIFY(packets.contains("40"));
        peer->sendTextMessage("2probe");
        QTRY_VERIFY_WITH_TIMEOUT(packets.contains("3probe"), 1000);
        peer->sendTextMessage("42[\"rooms-update\",[{\"id\":\"geral\"}]]");
        QTRY_COMPARE_WITH_TIMEOUT(events.count(), 1, 1000);
        QCOMPARE(events.first().first().toString(), QString("rooms-update"));
        peer->sendTextMessage("42[broken");
        QTRY_COMPARE_WITH_TIMEOUT(errors.count(), 1, 1000);
        QVERIFY(client.sendEvent("send-chat-message", {{"message", "hello"}}));
        QTRY_VERIFY_WITH_TIMEOUT(packets.contains("42[\"send-chat-message\",{\"message\":\"hello\"}]"), 1000);
        client.disconnectFromServer();
        QVERIFY(!client.ready());
        QVERIFY(!client.sendEvent("send-chat-message", {{"message", "stale"}}));
    }
    void manualDisconnectCancelsReconnect() {
        Signaling client;
        client.connectTo(QUrl("http://127.0.0.1:1"));
        client.disconnectFromServer();
        QSignalSpy statuses(&client, &Signaling::statusChanged);
        QTest::qWait(700);
        QVERIFY(!client.ready());
        QCOMPARE(statuses.count(), 0);
    }
    void reconnectCreatesFreshHandshakeWithoutOfflineSignals() {
        QWebSocketServer server("retry-test", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QList<QWebSocket*> peers;
        QStringList packets;
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            auto* peer = server.nextPendingConnection();
            peer->setParent(&server);
            peers.append(peer);
            connect(peer, &QWebSocket::textMessageReceived, this, [&, peer](const QString& packet) {
                packets.append(packet);
                if (packet == "40") peer->sendTextMessage("40{\"sid\":\"fresh\"}");
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        Signaling client;
        QSignalSpy connected(&client, &Signaling::connected);
        QSignalSpy disconnected(&client, &Signaling::disconnected);
        client.connectTo(QUrl(QString("http://127.0.0.1:%1").arg(server.serverPort())));
        QTRY_COMPARE_WITH_TIMEOUT(connected.count(), 1, 2000);
        peers.first()->close();
        QTRY_COMPARE_WITH_TIMEOUT(disconnected.count(), 1, 1000);
        QVERIFY(!client.sendEvent("webrtc-offer", {{"session", "stale"}}));
        QTRY_COMPARE_WITH_TIMEOUT(connected.count(), 2, 3000);
        QCOMPARE(peers.size(), 2);
        QCOMPARE(packets.count("40"), 2);
        for (const auto& packet : packets) QVERIFY(!packet.contains("stale"));
        client.disconnectFromServer();
    }
};
QTEST_GUILESS_MAIN(CoreTests)
#include "core_tests.moc"
