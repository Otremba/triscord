#include "hub_api.h"
#include "profile_media.h"
#include <QBuffer>
#include <QImage>
#include "signaling.h"
#include <QtTest>
#include <QTcpServer>
#include <QTcpSocket>
#include <QUrlQuery>
#include <QEventLoop>
#include <QJsonDocument>
#include <QNetworkReply>
#include <QTimer>
#include <algorithm>

using namespace triscord;

// Minimal HTTP/1.1 responder standing in for the signaling hub: answers each request with the next
// queued (status, body) pair and records the request head it received.
class FakeHub : public QObject {
    Q_OBJECT
public:
    FakeHub() {
        server_.listen(QHostAddress::LocalHost);
        connect(&server_, &QTcpServer::newConnection, this, [this] {
            auto* socket = server_.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, socket, [this, socket] {
                buffer_ += socket->readAll();
                const auto end = buffer_.indexOf("\r\n\r\n");
                if (end < 0) return;
                const auto head = buffer_.left(end);
                const auto lengthAt = head.toLower().indexOf("content-length:");
                const int length = lengthAt < 0 ? 0 : head.mid(lengthAt + 15, head.indexOf("\r\n", lengthAt) - lengthAt - 15).trimmed().toInt();
                if (buffer_.size() < end + 4 + length) return;
                requests << head + "\r\n\r\n" + buffer_.mid(end + 4, length);
                buffer_.clear();
                const auto reply = replies.isEmpty() ? qMakePair(500, QByteArray("{}")) : replies.takeFirst();
                socket->write("HTTP/1.1 " + QByteArray::number(reply.first) + " X\r\nContent-Type: application/json\r\nContent-Length: " +
                              QByteArray::number(reply.second.size()) + "\r\nConnection: close\r\n\r\n" + reply.second);
                socket->disconnectFromHost();
            });
        });
    }
    QString url() const { return QString("http://127.0.0.1:%1").arg(server_.serverPort()); }
    QList<QPair<int, QByteArray>> replies;
    QList<QByteArray> requests;

private:
    QTcpServer server_;
    QByteArray buffer_;
};

class HubApiTests : public QObject {
    Q_OBJECT
private slots:
    void endToEndWorkers() {
        const auto auth = qEnvironmentVariable("TRISCORD_AUTH_SERVER");
        const auto hub = qEnvironmentVariable("TRISCORD_E2E_HUB");
        if (hub.isEmpty()) QSKIP("Run cloudflare npm run test:e2e:native for the real local Workers/D1 fixture");
        // Refuse accidental production use. No QSettings or real account credentials are accessed.
        QCOMPARE(QUrl(auth).host(), QString("127.0.0.1"));
        QCOMPARE(QUrl(hub).host(), QString("127.0.0.1"));
        QNetworkAccessManager network;
        auto http = [&](const QByteArray& method, const QString& path, const QString& token,
                        const QJsonObject& body = QJsonObject{}) {
            QNetworkRequest request(QUrl(auth + path));
            request.setTransferTimeout(10000);
            request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
            if (!token.isEmpty()) request.setRawHeader("Authorization", "Bearer " + token.toUtf8());
            auto* reply = network.sendCustomRequest(request, method,
                method == "GET" ? QByteArray{} : QJsonDocument(body).toJson(QJsonDocument::Compact));
            QEventLoop loop; QTimer timer; timer.setSingleShot(true);
            connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
            connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
            timer.start(12000); loop.exec();
            const auto result = qMakePair(reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(),
                QJsonDocument::fromJson(reply->readAll()).object());
            if (!reply->isFinished()) reply->abort();
            reply->deleteLater(); return result;
        };
        auto loginA = http("POST", "/auth/google", {}, {{"id_token", qEnvironmentVariable("TRISCORD_E2E_TOKEN_A")}});
        auto loginB = http("POST", "/auth/google", {}, {{"id_token", qEnvironmentVariable("TRISCORD_E2E_TOKEN_B")}});
        QCOMPARE(loginA.first, 200); QCOMPARE(loginB.first, 200);
        const auto tokenA = loginA.second.value("session").toString();
        const auto tokenB = loginB.second.value("session").toString();
        QVERIFY(!tokenA.isEmpty()); QVERIFY(!tokenB.isEmpty());
        QCOMPARE(http("POST", "/nick", tokenA, {{"nick", "QtAlice"}}).first, 200);
        QCOMPARE(http("POST", "/nick", tokenB, {{"nick", "QtBob"}}).first, 200);
        QCOMPARE(http("PATCH", "/profile", tokenA, {{"bio", "Qt E2E"}, {"note", "private"}}).first, 200);
        const auto publicProfile = http("GET", "/profile/qt-alice", {}).second.value("profile").toObject();
        QCOMPARE(publicProfile.value("bio").toString(), QString("Qt E2E"));
        QVERIFY(!publicProfile.contains("note")); QVERIFY(!publicProfile.contains("email"));
        QImage image(8, 8, QImage::Format_RGB32); image.fill(Qt::green);
        QByteArray png; { QBuffer buffer(&png); buffer.open(QIODevice::WriteOnly); QVERIFY(image.save(&buffer, "PNG")); }
        ProfileMediaClient media;
        int status = -1; QJsonObject account;
        media.upload(tokenA, ProfileMediaKind::Avatar, png, [&](int s, const QJsonObject& a, const QJsonObject&) { status = s; account = a; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 200, 15000);
        const auto url = account.value("avatar_url").toString(); QVERIFY(!url.isEmpty());
        auto& cache = RemoteImageCache::instance(); cache.fetch(url);
        QTRY_COMPARE_WITH_TIMEOUT(cache.bytes(url), png, 15000);
        QCOMPARE(http("GET", "/me", tokenA).second.value("account").toObject().value("avatar_url").toString(), url);
        HubApi a, b; a.setBaseUrl(hub); b.setBaseUrl(hub); a.setSession(tokenA); b.setSession(tokenB);
        HubServer server; status = -1;
        a.createServer("Qt E2E guild", [&](int s, const HubServer& v) { status = s; server = v; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 201, 15000); QVERIFY(!server.id.isEmpty());
        QString invite; status = -1;
        a.createInvite(server.id, [&](int s, const QString& v) { status = s; invite = v; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 201, 15000); QVERIFY(!invite.isEmpty());
        QString joined; status = -1;
        b.acceptInvite(invite, [&](int s, const QString& v) { status = s; joined = v; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 200, 15000); QCOMPARE(joined, server.id);
        QList<HubServer> listed; status = -1;
        b.listServers([&](int s, const QList<HubServer>& v) { status = s; listed = v; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 200, 15000);
        QVERIFY(std::any_of(listed.begin(), listed.end(), [&](const HubServer& v) { return v.id == server.id; }));
        Signaling sa, sb;
        bool roomA = false, roomB = false, received = false, fence = false, forced = false;
        QJsonObject message;
        connect(&sa, &Signaling::eventReceived, this, [&](const QString& event, const QJsonArray& args) {
            if (event == "room-joined") roomA = true;
            if (event == "force-muted") forced = true;
            if (event == "new-chat-message" && args.first().toObject().value("text").toString() == "moderation fence") fence = true;
        });
        connect(&sb, &Signaling::eventReceived, this, [&](const QString& event, const QJsonArray& args) {
            if (event == "room-joined") roomB = true;
            if (event == "new-chat-message" && args.first().toObject().value("text").toString() == "Qt real Workers") {
                received = true; message = args.first().toObject();
            }
        });
        sa.connectTo(QUrl(hub), {}, {{"serverId", server.id}, {"sessionToken", tokenA}});
        sb.connectTo(QUrl(hub), {}, {{"serverId", server.id}, {"sessionToken", tokenB}});
        QTRY_VERIFY_WITH_TIMEOUT(sa.ready() && sb.ready(), 15000);
        QVERIFY(sa.sendEvent("join-room", {{"roomId", "qt-e2e"}, {"userData", QJsonObject{{"userId", "forged-a"}, {"username", "Forged"}}}}));
        QTRY_VERIFY_WITH_TIMEOUT(roomA, 15000); // the first participant owns this room
        QVERIFY(sb.sendEvent("join-room", {{"roomId", "qt-e2e"}, {"userData", QJsonObject{{"userId", "forged-b"}, {"username", "Forged"}}}}));
        QTRY_VERIFY_WITH_TIMEOUT(roomA && roomB, 15000);
        QVERIFY(sa.sendEvent("send-chat-message", {{"message", "Qt real Workers"}}));
        QTRY_VERIFY_WITH_TIMEOUT(received, 15000);
        QCOMPARE(message.value("senderUserId").toString(), QString("qt-alice"));
        QCOMPARE(message.value("senderName").toString(), QString("QtAlice"));
        QVERIFY(sb.sendEvent("force-mute-user", {{"socketId", sa.socketId()}}));
        // The hub silently ignores unauthorized moderation. A following chat
        // round-trip fences that command without relying on a fixed sleep.
        QVERIFY(sb.sendEvent("send-chat-message", {{"message", "moderation fence"}}));
        QTRY_VERIFY_WITH_TIMEOUT(fence, 15000); QVERIFY(!forced);
        sa.disconnectFromServer(); sb.disconnectFromServer();
        status = -1;
        media.remove(tokenA, ProfileMediaKind::Avatar, [&](int s, const QJsonObject&, const QJsonObject&) { status = s; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 200, 15000);
        QCOMPARE(http("POST", "/logout", tokenA).first, 200);
        QCOMPARE(http("GET", "/me", tokenA).first, 401);
        status = -1; a.listServers([&](int s, const QList<HubServer>&) { status = s; });
        QTRY_COMPARE_WITH_TIMEOUT(status, 401, 15000);
    }

    void acronymMatchesDiscordAlgorithm() {
        // Observed tile: "Servidor de camargo" -> "Sdc".
        QCOMPARE(HubApi::serverAcronym("Servidor de camargo"), QString("Sdc"));
        QCOMPARE(HubApi::serverAcronym("gogó de ferro"), QString("gódf")); // JS \w is ASCII: "ó" is kept as a separator
        QCOMPARE(HubApi::serverAcronym("Camargo's place"), QString("Cp"));
        QCOMPARE(HubApi::serverAcronym("  "), QString());
    }

    void inviteCodeIsExtractedFromPastedText() {
        const QString code = "0123456789abcdef0123456789abcdef";
        QCOMPARE(HubApi::extractInviteCode(code), code);
        QCOMPARE(HubApi::extractInviteCode("  entra aí: " + code.toUpper() + " valeu"), code);
        QCOMPARE(HubApi::extractInviteCode("https://x.example/invite/" + code), code);
        QVERIFY(HubApi::extractInviteCode("0123456789abcdef0123456789abcde").isEmpty()); // 31 chars
        QVERIFY(HubApi::extractInviteCode(code + "0").isEmpty()); // 33 hex chars is not a code
    }

    void serverListPlanKeepsTheCallAndLeavesDeletedServers() {
        const QList<HubServer> both{{"a", "A", "o"}, {"b", "B", "o"}}, onlyB{{"b", "B", "o"}}, onlyC{{"c", "C", "o"}};
        // Nothing changed: nothing to do.
        auto plan = HubApi::planServerList(both, "a", "a", true);
        QVERIFY(!plan.selectionChanged && !plan.reconnect && !plan.leaveCall && !plan.showCallServer);
        // In a call on "b", viewing "a", then leaving "a": the view goes back to the call's server and the main
        // connection stays where it is (18/10: it moved to the first server and dropped the call).
        plan = HubApi::planServerList(onlyB, "a", "b", true);
        QVERIFY(plan.selectionChanged && plan.showCallServer);
        QCOMPARE(plan.selected, QString("b"));
        QVERIFY(!plan.reconnect && !plan.leaveCall);
        // Not in a call: the first remaining server is shown and connected.
        plan = HubApi::planServerList(onlyB, "a", "a", false);
        QCOMPARE(plan.selected, QString("b"));
        QVERIFY(plan.selectionChanged && plan.reconnect && !plan.showCallServer && !plan.leaveCall);
        // The call's server was deleted while another server is viewed: leave the call, connect to the viewed one
        // (the hub refuses the old server's handshake forever).
        plan = HubApi::planServerList(onlyB, "b", "a", true);
        QVERIFY(!plan.selectionChanged && plan.leaveCall && plan.reconnect);
        QCOMPARE(plan.selected, QString("b"));
        // Both gone while in a call there: leave, show the first remaining server.
        plan = HubApi::planServerList(onlyC, "a", "a", true);
        QVERIFY(plan.selectionChanged && plan.leaveCall && plan.reconnect && !plan.showCallServer);
        QCOMPARE(plan.selected, QString("c"));
        // Last server gone: nothing selected, the connection is dropped (connectSignaling with no server).
        plan = HubApi::planServerList({}, "a", "a", false);
        QVERIFY(plan.selectionChanged && plan.reconnect);
        QVERIFY(plan.selected.isEmpty());
        // No server yet and none selected (new account): nothing to connect.
        plan = HubApi::planServerList({}, "", "", false);
        QVERIFY(!plan.selectionChanged || plan.selected.isEmpty());
        QVERIFY(!plan.reconnect);
        // First list after sign-in with nothing selected: show and connect the first server.
        plan = HubApi::planServerList(both, "", "", false);
        QCOMPARE(plan.selected, QString("a"));
        QVERIFY(plan.reconnect);
    }

    void signalingRouteCarriesServerAndSession() {
        const auto url = Signaling::endpoint(QUrl("https://hub.example"), {{"serverId", "abc-123"}, {"sessionToken", "ff00"}, {"empty", ""}});
        QCOMPARE(url.scheme(), QString("wss"));
        QCOMPARE(url.path(), QString("/socket.io/"));
        const QUrlQuery query(url);
        QCOMPARE(query.queryItemValue("EIO"), QString("4"));
        QCOMPARE(query.queryItemValue("serverId"), QString("abc-123"));
        QCOMPARE(query.queryItemValue("sessionToken"), QString("ff00"));
        QVERIFY(!query.hasQueryItem("empty"));
        // Legacy connection: no route, no extra items.
        QVERIFY(!QUrlQuery(Signaling::endpoint(QUrl("https://hub.example"))).hasQueryItem("serverId"));
    }

    void listCreateInviteAcceptAndIceFollowTheHubContract() {
        FakeHub fake;
        HubApi api;
        api.setBaseUrl(fake.url() + "/");
        api.setSession("deadbeef");
        fake.replies = {
            {200, R"({"servers":[{"id":"s1","name":"Servidor de camargo","ownerAccountId":"a1"},{"name":"no id"}]})"},
            {201, R"({"id":"s2","name":"Novo","ownerAccountId":"a1","createdAt":1})"},
            {201, R"({"code":"0123456789abcdef0123456789abcdef","serverId":"s2","expiresAt":null,"maxUses":null})"},
            {410, R"({"error":"invite_invalid"})"},
            {200, R"({"iceServers":[{"urls":["turn:turn.cloudflare.com:3478?transport=udp"],"username":"u","credential":"c"}]})"},
        };
        QList<HubServer> listed; int listStatus = -1;
        api.listServers([&](int status, const QList<HubServer>& servers) { listStatus = status; listed = servers; });
        QTRY_COMPARE(listStatus, 200);
        QCOMPARE(listed.size(), 1); // the entry without an id is dropped
        QCOMPARE(listed[0].name, QString("Servidor de camargo"));

        HubServer created; int createStatus = -1;
        api.createServer("Novo", [&](int status, const HubServer& server) { createStatus = status; created = server; });
        QTRY_COMPARE(createStatus, 201);
        QCOMPARE(created.id, QString("s2"));

        QString code; int inviteStatus = -1;
        api.createInvite("s2", [&](int status, const QString& c) { inviteStatus = status; code = c; });
        QTRY_COMPARE(inviteStatus, 201);
        QCOMPARE(code.size(), 32);

        QString joined = "unset"; int acceptStatus = -1;
        api.acceptInvite(code, [&](int status, const QString& id) { acceptStatus = status; joined = id; });
        QTRY_COMPARE(acceptStatus, 410);
        QVERIFY(joined.isEmpty());

        QJsonArray ice; int iceStatus = -1;
        api.fetchIce([&](int status, const QJsonArray& servers) { iceStatus = status; ice = servers; });
        QTRY_COMPARE(iceStatus, 200);
        QCOMPARE(ice.size(), 1);

        QCOMPARE(fake.requests.size(), 5);
        QVERIFY(fake.requests[0].startsWith("GET /servers HTTP/1.1"));
        QVERIFY(fake.requests[1].startsWith("POST /servers HTTP/1.1"));
        QVERIFY(fake.requests[1].endsWith(R"({"name":"Novo"})"));
        QVERIFY(fake.requests[2].startsWith("POST /servers/s2/invites HTTP/1.1"));
        QVERIFY(fake.requests[3].startsWith("POST /invites/0123456789abcdef0123456789abcdef/accept HTTP/1.1"));
        QVERIFY(fake.requests[4].startsWith("GET /ice HTTP/1.1"));
        for (const auto& request : fake.requests) QVERIFY2(request.toLower().contains("authorization: bearer deadbeef"), request.constData());
    }

    void oldHubWithoutServerLayerReportsNotFound() {
        FakeHub fake;
        HubApi api;
        api.setBaseUrl(fake.url());
        api.setSession("deadbeef");
        fake.replies = {{404, R"({"error":"not_found"})"}};
        int status = -1; QList<HubServer> listed{HubServer{"x", "x", "x"}};
        api.listServers([&](int s, const QList<HubServer>& servers) { status = s; listed = servers; });
        QTRY_COMPARE(status, 404);
        QVERIFY(listed.isEmpty());
    }

    void profileImageTypeComesFromTheBytes() {
        QImage image(8, 8, QImage::Format_RGB32); image.fill(Qt::red);
        QByteArray png; { QBuffer b(&png); b.open(QIODevice::WriteOnly); image.save(&b, "PNG"); }
        QByteArray jpg; { QBuffer b(&jpg); b.open(QIODevice::WriteOnly); image.save(&b, "JPG"); }
        QCOMPARE(sniffProfileImageMime(png), QString("image/png"));
        QCOMPARE(sniffProfileImageMime(jpg), QString("image/jpeg"));
        QCOMPARE(sniffProfileImageMime(QByteArray("GIF89a\x01\x00", 8)), QString("image/gif"));
        QVERIFY(sniffProfileImageMime("RIFF....WEBPVP8 ").isEmpty()); // WebP is not accepted by the worker
        QCOMPARE(profileMediaMaxBytes(ProfileMediaKind::Avatar), qint64(524288));
        QCOMPARE(profileMediaMaxBytes(ProfileMediaKind::Banner), qint64(1048576));
        QVERIFY(profileMediaErrorMessage(ProfileMediaKind::Avatar, 200).isEmpty());
        QVERIFY(profileMediaErrorMessage(ProfileMediaKind::Avatar, 413, QJsonObject{{"max_bytes", 524288}}).contains("512 KB"));
    }

    void profileMediaUploadSendsRawBytesWithRealMime() {
        FakeHub fake;
        qputenv("TRISCORD_AUTH_SERVER", fake.url().toUtf8());
        QImage image(8, 8, QImage::Format_RGB32); image.fill(Qt::blue);
        QByteArray png; { QBuffer b(&png); b.open(QIODevice::WriteOnly); image.save(&b, "PNG"); }
        fake.replies = {
            {200, R"({"account":{"avatar_url":"https:\/\/auth.example\/media\/abc"},"media":{"animated":false}})"},
            {415, R"({"error":"unsupported_media"})"},
            {200, R"({"account":{"avatar_url":null}})"},
        };
        ProfileMediaClient client;
        int status = -1; QJsonObject account;
        client.upload("deadbeef", ProfileMediaKind::Avatar, png, [&](int s, const QJsonObject& a, const QJsonObject&) { status = s; account = a; });
        QTRY_COMPARE(status, 200);
        QCOMPARE(account.value("avatar_url").toString(), QString("https://auth.example/media/abc"));
        status = -1;
        client.upload("deadbeef", ProfileMediaKind::Banner, png, [&](int s, const QJsonObject&, const QJsonObject&) { status = s; });
        QTRY_COMPARE(status, 415); // server refusal is reported, never treated as done
        status = -1;
        client.remove("deadbeef", ProfileMediaKind::Avatar, [&](int s, const QJsonObject& a, const QJsonObject&) { status = s; account = a; });
        QTRY_COMPARE(status, 200);
        QVERIFY(account.value("avatar_url").isNull());
        QCOMPARE(fake.requests.size(), 3);
        QVERIFY(fake.requests[0].startsWith("PUT /profile/avatar HTTP/1.1"));
        QVERIFY(fake.requests[0].toLower().contains("content-type: image/png"));
        QVERIFY(fake.requests[0].toLower().contains("authorization: bearer deadbeef"));
        QVERIFY(fake.requests[0].endsWith(png)); // raw body, no multipart/base64
        QVERIFY(fake.requests[1].startsWith("PUT /profile/banner HTTP/1.1"));
        QVERIFY(fake.requests[2].startsWith("DELETE /profile/avatar HTTP/1.1"));

        // Refused locally, nothing sent: oversized avatar and a non-image file.
        status = -1;
        client.upload("deadbeef", ProfileMediaKind::Avatar, png + QByteArray(524288, '\0'), [&](int s, const QJsonObject&, const QJsonObject&) { status = s; });
        QTRY_COMPARE(status, 413);
        status = -1;
        client.upload("deadbeef", ProfileMediaKind::Avatar, "not an image", [&](int s, const QJsonObject&, const QJsonObject&) { status = s; });
        QTRY_COMPARE(status, 415);
        QCOMPARE(fake.requests.size(), 3);
        qunsetenv("TRISCORD_AUTH_SERVER");
    }

    void remoteImageCacheEvictsOldImagesAtItsMemoryBudget() {
        FakeHub fake;
        QImage image(8, 8, QImage::Format_RGB32); image.fill(Qt::red);
        QByteArray png; { QBuffer buffer(&png); buffer.open(QIODevice::WriteOnly); image.save(&buffer, "PNG"); }
        png.append(QByteArray(2 * 1048576 - png.size(), '\0'));
        auto& cache = RemoteImageCache::instance();
        QString firstUrl;
        for (int i = 0; i < 5; ++i) {
            const QString url = fake.url() + "/bounded-cache/" + QString::number(i);
            if (i == 0) firstUrl = url;
            fake.replies.append(qMakePair(200, png));
            cache.fetch(url);
            QTRY_COMPARE(cache.bytes(url), png);
        }
        QVERIFY(cache.bytes(firstUrl).isEmpty());
        QCOMPARE(fake.requests.size(), 5);
    }

    void oversizedRemoteImageIsRejectedAndCanBeRetried() {
        FakeHub fake;
        QImage image(8, 8, QImage::Format_RGB32); image.fill(Qt::red);
        QByteArray png; { QBuffer buffer(&png); buffer.open(QIODevice::WriteOnly); image.save(&buffer, "PNG"); }
        QByteArray oversized = png;
        oversized.append(QByteArray(2 * 1048576 + 1 - oversized.size(), '\0'));
        fake.replies = {{200, oversized}, {200, png}};
        auto& cache = RemoteImageCache::instance();
        const QString url = fake.url() + "/oversized-retry";
        cache.fetch(url);
        // While the first download is pending fetch() is a no-op. A rejected
        // download must release its pending slot and permit the next request.
        QTRY_VERIFY_WITH_TIMEOUT((cache.fetch(url), fake.requests.size() >= 2), 5000);
        QTRY_COMPARE(cache.bytes(url), png);
    }

    void noSessionMeansNoRequest() {
        HubApi api;
        api.setBaseUrl("http://127.0.0.1:9");
        int status = -1;
        api.listServers([&](int s, const QList<HubServer>&) { status = s; });
        QCOMPARE(status, 0); // answered synchronously, nothing sent without a session
    }
};

QTEST_GUILESS_MAIN(HubApiTests)
#include "hub_api_tests.moc"
