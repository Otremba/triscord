#include "screen_service.h"
#include "video_image.h"
#include "private_settings.h"
#include "screen_quality.h"
#include <QtTest>
#include <thread>
#include <cmath>
using namespace triscord;
class ScreenClientTests : public QObject {
    Q_OBJECT
private slots:
    void captureTimerDoesNotWakeBeforeTheEncoderFrameDeadline() {
        for (const int fps : {15, 30, 60}) {
            const auto config = screenPreset(720, fps);
            const qint64 interval = screenCaptureInterval(config) * 10000LL;
            QVERIFY(interval >= 10000000 / fps);
            QVERIFY(interval < 10000000 / fps + 10000);
            ScreenFrameSchedule schedule;
            // No device, wall-clock timer or encoder: reproduce consecutive timer deadlines exactly.
            for (int tick = 0; tick < 120; ++tick) {
                const auto now = tick * interval;
                QVERIFY2(schedule.shouldSubmit(now, fps, true, true), "A regular capture wake-up must not lose every second frame");
                schedule.submitted(now);
            }
        }
    }
    void staticShareAnswersKeyframesWithoutNewCapture() {
        ScreenFrameSchedule schedule;
        QVERIFY(schedule.shouldSubmit(0, 30, true, true));
        schedule.submitted(0);
        QVERIFY(!schedule.shouldSubmit(1000000, 30, false, true));
        schedule.requestKeyframe();
        QVERIFY(!schedule.shouldSubmit(100, 30, false, true)); // preserve the configured frame rate
        QVERIFY(!schedule.shouldSubmit(1000000, 30, false, false)); // encoder backpressure must keep the PLI
        QVERIFY(schedule.shouldSubmit(1000000, 30, false, true)); // frozen source, ready encoder
        schedule.submitted(1000000);
        QVERIFY(!schedule.shouldSubmit(2000000, 30, false, true));
        QVERIFY(schedule.shouldSubmit(11000000, 30, false, true)); // keepalive even without a PLI
        QVERIFY(schedule.shouldSubmit(2000000, 30, true, true)); // changed image must not wait for keepalive
    }
    void publisherIsAnnouncedBeforeFirstVideoFrame() {
        Signaling signaling;
        ScreenCall call(&signaling, ScreenCall::SourceMode::Injected);
        QSignalSpy streams(&call, &ScreenCall::streamsChanged), frames(&call, &ScreenCall::frame);
        emit signaling.sessionStarted("z");
        emit signaling.eventReceived("room-joined", QJsonArray{QJsonObject{{"roomId", "unit"},
            {"existingUsers", QJsonArray{QJsonObject{{"socketId", "a"}, {"username", "Friend"}, {"isScreenSharing", true}}}}}});
        QCOMPARE(streams.last()[0].toJsonArray().size(), 1);
        QCOMPARE(streams.last()[0].toJsonArray().first().toObject().value("id").toString(), QString("a"));
        QCOMPARE(frames.size(), 0); // listing must not depend on transport/decoder delivering the first image
        emit signaling.eventReceived("user-state-updated", QJsonArray{QJsonObject{{"socketId", "a"},
            {"state", QJsonObject{{"isScreenSharing", false}}}}});
        QVERIFY(streams.last()[0].toJsonArray().isEmpty());
    }
    void cameraAndScreenKeepSeparateStateAndViewingControls() {
        Signaling signaling;
        ScreenCall screen(&signaling, ScreenCall::SourceMode::Injected);
        ScreenCall camera(&signaling, ScreenCall::SourceMode::Injected, {}, nullptr, ScreenCall::MediaKind::Camera);
        QSignalSpy screens(&screen, &ScreenCall::streamsChanged), cameras(&camera, &ScreenCall::streamsChanged);
        QSignalSpy screenEvents(&screen, &ScreenCall::outboundEvent), cameraEvents(&camera, &ScreenCall::outboundEvent);
        emit signaling.sessionStarted("a");
        emit signaling.eventReceived("room-joined", QJsonArray{QJsonObject{{"roomId", "dual"},
            {"existingUsers", QJsonArray{QJsonObject{{"socketId", "peer"}, {"isCameraOn", true}, {"isScreenSharing", false}}}}}});
        QCOMPARE(screens.last()[0].toJsonArray().size(), 0); QCOMPARE(cameras.last()[0].toJsonArray().size(), 1);
        emit signaling.eventReceived("user-state-updated", QJsonArray{QJsonObject{{"socketId", "peer"},
            {"state", QJsonObject{{"isScreenSharing", true}, {"isCameraOn", false}}}}});
        QCOMPARE(screens.last()[0].toJsonArray().size(), 1); QCOMPARE(cameras.last()[0].toJsonArray().size(), 0);
        screen.setVideoDisabled("peer", true); camera.setVideoDisabled("peer", true);
        QCOMPARE(screenEvents.last()[0].toString(), QString("screen-watch"));
        QCOMPARE(cameraEvents.last()[0].toString(), QString("camera-watch"));
        screen.leave(); camera.leave(); screenEvents.clear(); cameraEvents.clear();
        emit signaling.eventReceived("room-joined", QJsonArray{QJsonObject{{"roomId", "empty"}}});
        screen.startInjected(); camera.startInjected();
        QVERIFY(screenEvents.last()[1].toJsonObject().value("isScreenSharing").toBool());
        QVERIFY(cameraEvents.last()[1].toJsonObject().value("isCameraOn").toBool());
        camera.stop(); QVERIFY(!cameraEvents.last()[1].toJsonObject().value("isCameraOn").toBool());
        QVERIFY(screenEvents.last()[1].toJsonObject().value("isScreenSharing").toBool());
    }
    void cameraTransportContainsVideoAndNoScreenAudioTrack() {
        VideoPeer peer(rtc::Configuration{}, nullptr, false);
        QSignalSpy description(&peer, &VideoPeer::localDescription); peer.offer();
        QTRY_COMPARE(description.size(), 1);
        const auto sdp = description.first()[0].toString();
        QVERIFY(sdp.contains("m=video")); QVERIFY(sdp.contains("a=mid:camera")); QVERIFY(!sdp.contains("m=audio"));
        QVERIFY(!peer.sendAudio(QByteArray(20, 'a')));
        QVERIFY_EXCEPTION_THROWN(peer.addCandidate("", "screen"), std::invalid_argument);
    }
    void sharingPresetsRespectCodecAndRenderLimits() {
        for (int height : {480, 720, 1080}) for (int fps : {15, 30, 60}) {
            const auto config = screenPreset(height, fps);
            QVERIFY(config.valid()); QCOMPARE(config.size.height(), height); QCOMPARE(config.fps, fps);
            QCOMPARE(screenRenderInterval(config, true), 1000 / fps); QCOMPARE(screenRenderInterval(config, false), 200);
        }
        QCOMPARE(screenPreset(720, 30).bitrate, 2500000);
        QVERIFY_EXCEPTION_THROWN(screenPreset(2160, 60), std::invalid_argument);
        QVERIFY_EXCEPTION_THROWN(screenPreset(720, 0), std::invalid_argument);
    }
    // The total upload is shared among viewers: the preset up to the budget, an equal share past it, never below the floor.
    void bitrateCeilingSharesTheUploadBudget() {
        const int preset = screenPreset(1080, 60).bitrate;   // 8 Mbps
        QCOMPARE(screenBitrateCeiling(preset, 0), preset);
        QCOMPARE(screenBitrateCeiling(preset, 1), preset);
        QCOMPARE(screenBitrateCeiling(preset, 2), preset);
        QCOMPARE(screenBitrateCeiling(preset, 3), kScreenUploadBudget / 3);
        QCOMPARE(screenBitrateCeiling(preset, 4), 4000000);
        QCOMPARE(screenBitrateCeiling(preset, 100), ScreenBitrateControl::floor(preset));
        QCOMPARE(screenBitrateCeiling(screenPreset(720, 30).bitrate, 4), screenPreset(720, 30).bitrate);   // small presets fit whole
    }
    // 19/10: one keyframe request no longer cuts the stream, cuts stop at an eighth of the preset, and a calm link
    // climbs back from the floor to the preset in about a minute instead of several.
    void bitrateCutsOnlyOnRealCongestionAndRecoversFast() {
        const int preset = 4000000;
        ScreenBitrateControl control;
        QCOMPARE(control.keyframeRequested(1000, preset, preset), 0);
        QCOMPARE(control.keyframeRequested(2000, preset, preset), 0);
        QCOMPARE(control.keyframeRequested(3000, preset, preset), 3000000);   // third within 5 s: a quarter off
        QCOMPARE(control.keyframeRequested(9000, preset, preset), 0);         // the earlier ones no longer count
        QCOMPARE(control.congested(3500, preset, preset), 0);                  // 2 s between cuts
        QCOMPARE(control.congested(5000, preset, preset), 2250000);
        qint64 now = 5000;
        for (int i = 0; i < 30; ++i) control.congested(now += 2000, preset, preset);
        QCOMPARE(control.target(preset), ScreenBitrateControl::floor(preset));   // 500 kbps, not 128
        QCOMPARE(ScreenBitrateControl::floor(preset), 500000);
        QCOMPARE(control.calm(now + 4000, preset, preset), 0);                 // 8 calm seconds first
        int steps = 0;
        for (qint64 t = now + 8000; control.target(preset) < preset && steps < 100; t += 4000) if (control.calm(t, preset, preset)) ++steps;
        QCOMPARE(control.target(preset), preset);
        QVERIFY2(steps * 4 <= 60, qPrintable(QString("%1 s back to the preset").arg(steps * 4)));
        // More viewers lower the ceiling at once; the floor still holds.
        QCOMPARE(control.calm(now + 1000000, preset, preset / 2), preset / 2);
        QCOMPARE(control.calm(now + 1000001, preset, 1), ScreenBitrateControl::floor(preset));
        control.reset();
        QCOMPARE(control.target(preset), preset);
        QCOMPARE(control.calm(0, preset, preset), 0);
    }
    void streamVolumeMuteAndRecoveryAffectDecodedPcm() {
        qRegisterMetaType<VoiceFrame>();
        ScreenAudio normal, louder, muted;
        for (auto* audio : {&normal, &louder, &muted}) audio->setPlaybackEnabled(false);
        louder.setPeerVolume("peer", 2.f); muted.setPeerMuted("peer", true);
        QSignalSpy base(&normal, &ScreenAudio::decoded), amplified(&louder, &ScreenAudio::decoded), silent(&muted, &ScreenAudio::decoded);
        VoiceFrame tone{}; for (int n = 0; n < VoiceSamples; ++n) tone[n] = .1f * std::sin(2 * 3.141592653589793 * 440 * n / VoiceRate);
        VoiceEncoder encoder(true);
        auto feed = [&] {   // three packets: the jitter buffer keeps 60 ms of headroom before playing
            for (uint32_t n = 0; n < 3; ++n) {
                const auto packet = encoder.encode(tone);
                for (auto* audio : {&normal, &louder, &muted}) audio->receive("peer", packet, n * VoiceSamples);
            }
        };
        auto energy = [](const QSignalSpy& spy) {
            double result = 0; for (float sample : spy.first()[1].value<VoiceFrame>()) result += sample * sample; return result;
        };
        feed(); QTRY_VERIFY(base.count() >= 2 && amplified.count() >= 2 && silent.count() >= 2);
        QVERIFY(energy(base) > .01); QVERIFY(std::abs(energy(amplified) / energy(base) - 4.) < .001); QCOMPARE(energy(silent), 0.);
        for (auto* audio : {&normal, &louder, &muted}) audio->remove("peer");
        base.clear(); amplified.clear(); silent.clear(); feed();
        QTRY_VERIFY(base.count() >= 2 && amplified.count() >= 2 && silent.count() >= 2);
        QVERIFY(std::abs(energy(amplified) / energy(base) - 4.) < .001); QCOMPARE(energy(silent), 0.);
        muted.forgetPeer("peer"); silent.clear();
        for (uint32_t n = 0; n < 3; ++n) muted.receive("peer", encoder.encode(tone), n * VoiceSamples);
        QTRY_VERIFY(silent.count() >= 2); QVERIFY(energy(silent) > .01);
    }
    void videoWatchRequiresMemberAndSuppressesDuplicateUpdates() {
        Signaling signaling; ScreenCall call(&signaling, ScreenCall::SourceMode::Injected);
        QSignalSpy sent(&call, &ScreenCall::outboundEvent);
        emit signaling.eventReceived("room-joined", QJsonArray{QJsonObject{{"roomId", "test"},
            {"existingUsers", QJsonArray{QJsonObject{{"socketId", "peer"}, {"username", "friend"}, {"isScreenSharing", false}}}}}});
        call.setVideoDisabled("outsider", true); QCOMPARE(sent.size(), 0);
        call.setVideoDisabled("peer", true); QCOMPARE(sent.size(), 1);
        QCOMPARE(sent[0][0].toString(), QString("screen-watch"));
        QCOMPARE(sent[0][1].toJsonObject().value("watching").toBool(), false);
        call.setVideoDisabled("peer", true); QCOMPARE(sent.size(), 1);
        call.setVideoDisabled("peer", false); QCOMPARE(sent.size(), 2);
        QCOMPARE(sent[1][1].toJsonObject().value("watching").toBool(), true);
        call.leave(); call.setVideoDisabled("peer", true); QCOMPARE(sent.size(), 2);
    }
    void injectedEncoderReceivesViewerRecoveryOnlyWhileSharing() {
        Signaling signaling; ScreenCall call(&signaling, ScreenCall::SourceMode::Injected);
        QSignalSpy requested(&call, &ScreenCall::keyframeRequested);
        emit signaling.eventReceived("room-joined", QJsonArray{QJsonObject{{"roomId", "test"},
            {"existingUsers", QJsonArray{QJsonObject{{"socketId", "peer"}, {"isScreenSharing", false}}}}}});
        auto watch = [&](const QString& id, bool watching) {
            emit signaling.eventReceived("screen-watch", QJsonArray{QJsonObject{{"senderSocketId", id}, {"watching", watching}}});
        };
        watch("peer", true); QCOMPARE(requested.size(), 0);
        call.startInjected(); watch("outsider", true); watch("peer", false); QCOMPARE(requested.size(), 0);
        watch("peer", true); QCOMPARE(requested.size(), 1);
        call.stop(); watch("peer", true); QCOMPARE(requested.size(), 1);
    }
    void mailboxReplacesFramesAndRejectsOldSessions() {
        ScreenFrameMailbox mailbox; mailbox.select("peer",1);
        int notifications = 0;
        std::thread producer([&] { for (int n=0;n<1000;++n) if (mailbox.publish({"peer",1,QImage(4,4,QImage::Format_RGB32)})) ++notifications; });
        producer.join(); QCOMPARE(notifications,1); QCOMPARE(mailbox.take().size(),size_t(1));
        mailbox.select("peer",2); QVERIFY(!mailbox.publish({"peer",1,{}}));
        QVERIFY(mailbox.publish({"peer",2,{}})); mailbox.remove("peer"); QVERIFY(mailbox.take().empty());
        QVERIFY(!mailbox.publish({"peer",2,{}}));
    }
    void oldNotificationCanDeliverNewSession() {
        ScreenFrameMailbox mailbox; mailbox.select("peer",1); QVERIFY(mailbox.publish({"peer",1,{}}));
        mailbox.remove("peer"); mailbox.select("peer",2); QVERIFY(!mailbox.publish({"peer",2,{}}));
        const auto frames=mailbox.take(); QCOMPARE(frames.size(),size_t(1)); QCOMPARE(frames.front().generation,quint64(2));
    }
    void nv12ConvertsColorAndScales() {
        DecodedVideo video{QByteArray(640*360*3/2,char(128)),{640,360},0};
        std::fill(video.nv12.begin(),video.nv12.begin()+640*360,char(79));
        for (int n=640*360;n<video.nv12.size();n+=2) { video.nv12[n]=char(117);video.nv12[n+1]=char(202); }
        const auto image=videoImage(video,{320,180}); QCOMPARE(image.size(),QSize(320,180));
        const auto color=image.pixelColor(160,90); QVERIFY(std::abs(color.red()-210)<10); QVERIFY(std::abs(color.green()-35)<10); QVERIFY(std::abs(color.blue()-50)<10);
        video.nv12.chop(1); QVERIFY_EXCEPTION_THROWN(videoImage(video,{320,180}),std::invalid_argument);
    }
    void groupCodeUsesWindowsProtectedStorage() {
        const QString value="local-test-private-group";
        auto protectedBytes=protectSetting(value); QVERIFY(!protectedBytes.isEmpty()); QVERIFY(!protectedBytes.contains(value.toUtf8()));
        QCOMPARE(unprotectSetting(protectedBytes),value); protectedBytes[0]^=1; QVERIFY(unprotectSetting(protectedBytes).isEmpty());
    }
};
QTEST_GUILESS_MAIN(ScreenClientTests)
#include "screen_client_tests.moc"
