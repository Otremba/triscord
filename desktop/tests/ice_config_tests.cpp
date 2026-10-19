#include "ice_config.h"
#include <QtTest>
#include <QSettings>
#include <QCoreApplication>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonDocument>

using namespace triscord;

class IceConfigTests : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() {
        QCoreApplication::setOrganizationName("Triscord");
        QCoreApplication::setApplicationName("TriscordIceConfigTests");
    }
    void init() {
        qunsetenv("TRISCORD_ICE_SERVERS");
        QSettings().remove("iceServers");
    }
    void cleanupTestCase() { QSettings().clear(); }

    void defaultListIsReturnedWhenNothingConfigured() {
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(4));
        QCOMPARE(servers[0].url, QString("stun:stun.l.google.com:19302"));
        QCOMPARE(servers[1].url, QString("stun:stun1.l.google.com:19302"));
        QCOMPARE(servers[2].url, QString("stun:stun2.l.google.com:19302"));
        QCOMPARE(servers[3].url, QString("stun:stun.cloudflare.com:3478"));
        for (const auto& server : servers) {
            QVERIFY(server.username.isEmpty());
            QVERIFY(server.credential.isEmpty());
            // The OpenRelay relays resolved to a sinkhole (192.0.2.1) and were removed.
            QVERIFY(!server.url.contains("openrelay"));
        }
        QCOMPARE(toRtcIceServers(servers).size(), size_t(4));
    }

    void cloudflareIceResponseParsesEveryUrl() {
        // Shape returned by Cloudflare Realtime generate-ice-servers, relayed verbatim by GET /ice.
        const QByteArray body =
            "[{\"urls\":[\"stun:stun.cloudflare.com:3478\",\"stun:stun.cloudflare.com:53\"]},"
            "{\"urls\":[\"turn:turn.cloudflare.com:3478?transport=udp\",\"turn:turn.cloudflare.com:3478?transport=tcp\","
            "\"turns:turn.cloudflare.com:5349?transport=tcp\",\"https://not-ice.example\"],"
            "\"username\":\"user123\",\"credential\":\"cred456\"}]";
        const auto json = QJsonDocument::fromJson(body).array();
        const auto entries = parseRtcIceServers(json);
        QCOMPARE(entries.size(), size_t(5));
        QCOMPARE(entries[0].url, QString("stun:stun.cloudflare.com:3478"));
        QVERIFY(entries[0].username.isEmpty());
        QCOMPARE(entries[2].username, QString("user123"));
        QCOMPARE(entries[4].credential, QString("cred456"));
        const auto relays = toRtcIceServers(entries);
        QCOMPARE(relays.size(), size_t(5));
        QCOMPARE(QString::fromStdString(relays[2].hostname), QString("turn.cloudflare.com"));
        QCOMPARE(relays[2].relayType, rtc::IceServer::RelayType::TurnUdp);
        QCOMPARE(relays[3].relayType, rtc::IceServer::RelayType::TurnTcp);
        QCOMPARE(relays[4].relayType, rtc::IceServer::RelayType::TurnTls);
        QCOMPARE(relays[4].port, uint16_t(5349));
        // A single "urls" string is accepted too.
        const auto single = parseRtcIceServers(QJsonDocument::fromJson(R"([{"urls":"stun:a.example:1"}])").array());
        QCOMPARE(single.size(), size_t(1));
    }

    void freshSessionRelaysGoFirstAndExpire() {
        const auto relay = IceServerEntry{"turn:turn.cloudflare.com:3478?transport=udp", "u", "c"};
        setSessionIceServers({relay}, QDateTime::currentMSecsSinceEpoch() + 60000);
        auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(5));
        QCOMPARE(servers[0].url, relay.url);
        QCOMPARE(servers[1].url, QString("stun:stun.l.google.com:19302"));
        // An explicit override still wins over the fetched relays.
        qputenv("TRISCORD_ICE_SERVERS", R"([{"url":"stun:only.example.com:3478"}])");
        QCOMPARE(resolveIceServers().size(), size_t(1));
        qunsetenv("TRISCORD_ICE_SERVERS");
        // Expired credentials are never handed to a peer.
        setSessionIceServers({relay}, QDateTime::currentMSecsSinceEpoch() - 1);
        servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(4));
        clearSessionIceServers();
    }

    void turnTransportTcpQueryStringParsesPortAndRelayType() {
        QSettings().setValue("iceServers", QString(R"([{"url":"turn:relay.example.com:4443?transport=tcp","username":"u","credential":"p"}])"));
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(1));
        QCOMPARE(servers[0].url, QString("turn:relay.example.com:4443?transport=tcp"));
        const auto rtcServers = toRtcIceServers(servers);
        QCOMPARE(rtcServers.size(), size_t(1));
        QCOMPARE(QString::fromStdString(rtcServers[0].hostname), QString("relay.example.com"));
        QCOMPARE(rtcServers[0].port, uint16_t(4443));
        QCOMPARE(rtcServers[0].relayType, rtc::IceServer::RelayType::TurnTcp);
        QVERIFY(rtcServers[0].type == rtc::IceServer::Type::Turn);
    }

    void overrideFullyReplacesDefaultsWithoutMergingTurn() {
        qputenv("TRISCORD_ICE_SERVERS", R"([{"url":"stun:only.example.com:3478"}])");
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(1));
        QCOMPARE(servers[0].url, QString("stun:only.example.com:3478"));
        // No OpenRelay TURN entries leaked in alongside the override.
        for (const auto& server : servers) {
            QVERIFY(!server.url.contains("openrelay"));
        }
    }

    void environmentVariableOverridesWithMultipleServers() {
        qputenv("TRISCORD_ICE_SERVERS", R"([{"url":"stun:one.example.com:3478"},{"url":"stun:two.example.com:3478"}])");
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(2));
        QCOMPARE(servers[0].url, QString("stun:one.example.com:3478"));
        QCOMPARE(servers[1].url, QString("stun:two.example.com:3478"));
    }

    void turnEntryWithCredentialsRoundTrips() {
        QSettings().setValue("iceServers", QString(R"([{"url":"turn:relay.example.com:3478","username":"alice","credential":"secret"}])"));
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(1));
        QCOMPARE(servers[0].url, QString("turn:relay.example.com:3478"));
        QCOMPARE(servers[0].username, QString("alice"));
        QCOMPARE(servers[0].credential, QString("secret"));
        const auto rtcServers = toRtcIceServers(servers);
        QCOMPARE(rtcServers.size(), size_t(1));
        QCOMPARE(QString::fromStdString(rtcServers[0].hostname), QString("relay.example.com"));
        QCOMPARE(rtcServers[0].port, uint16_t(3478));
        QCOMPARE(QString::fromStdString(rtcServers[0].username), QString("alice"));
        QCOMPARE(QString::fromStdString(rtcServers[0].password), QString("secret"));
        QVERIFY(rtcServers[0].type == rtc::IceServer::Type::Turn);
    }

    void malformedEnvironmentVariableFallsBackWithoutCrashing() {
        qputenv("TRISCORD_ICE_SERVERS", "not valid json {{{");
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(4));
        QCOMPARE(servers[0].url, QString("stun:stun.l.google.com:19302"));
    }

    void malformedSettingsEntriesAreSkipped() {
        QSettings().setValue("iceServers", QString(R"([{"username":"no-url-here"},{"url":"stun:good.example.com:19302"}])"));
        const auto servers = resolveIceServers();
        QCOMPARE(servers.size(), size_t(1));
        QCOMPARE(servers[0].url, QString("stun:good.example.com:19302"));
    }
};

QTEST_GUILESS_MAIN(IceConfigTests)
#include "ice_config_tests.moc"
