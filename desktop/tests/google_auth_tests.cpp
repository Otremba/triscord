#include "google_auth.h"
#include "auth_session.h"
#include <QtTest>
#include <QSettings>
#include <QCoreApplication>
#include <QSignalSpy>
#include <QTcpServer>
#include <QTcpSocket>

using namespace triscord;

class GoogleAuthTests : public QObject {
    Q_OBJECT
private slots:
    void initTestCase() {
        QCoreApplication::setOrganizationName("Triscord");
        QCoreApplication::setApplicationName("TriscordGoogleAuthTests");
    }
    void init() {
        qunsetenv("TRISCORD_GOOGLE_CLIENT_SECRET");
        qunsetenv("TRISCORD_AUTH_SERVER");
        QSettings().clear();
    }
    void cleanupTestCase() { QSettings().clear(); }

    // RFC 7636 appendix B known test vector.
    void codeChallengeMatchesKnownVector() {
        const QString verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        const QString expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
        QCOMPARE(codeChallengeS256(verifier), expected);
    }

    void codeVerifierHasExpectedLengthAndCharset() {
        const auto verifier = generateCodeVerifier();
        QVERIFY(verifier.size() >= 43 && verifier.size() <= 128);
        static const QRegularExpression allowed("^[A-Za-z0-9\\-._~]+$");
        QVERIFY(allowed.match(verifier).hasMatch());
    }

    void codeVerifiersAreRandomized() {
        QVERIFY(generateCodeVerifier() != generateCodeVerifier());
        QVERIFY(generateState() != generateState());
    }

    void authorizationUrlCarriesPkceAndState() {
        const auto url = buildAuthorizationUrl("client-id", "http://127.0.0.1:1234/", "challenge-value", "state-value");
        QVERIFY(url.contains("client_id=client-id"));
        QVERIFY(url.contains("code_challenge=challenge-value"));
        QVERIFY(url.contains("code_challenge_method=S256"));
        QVERIFY(url.contains("state=state-value"));
        QVERIFY(url.contains("scope=openid"));
        QVERIFY(!url.contains(QLatin1Char(' '))); // a valid URL: no raw spaces (regression from the e2e test)
    }

    void callbackParsesCodeAndState() {
        const auto result = parseLoopbackRequest("GET /?code=abc123&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
        QVERIFY(result.parsed);
        QCOMPARE(result.code, QString("abc123"));
        QCOMPARE(result.state, QString("xyz"));
        QVERIFY(result.error.isEmpty());
    }

    void callbackParsesErrorParameter() {
        const auto result = parseLoopbackRequest("GET /?error=access_denied&state=xyz HTTP/1.1\r\n\r\n");
        QVERIFY(result.parsed);
        QCOMPARE(result.error, QString("access_denied"));
        QVERIFY(result.code.isEmpty());
    }

    void malformedRequestLineDoesNotParse() {
        const auto result = parseLoopbackRequest("not an http request at all");
        QVERIFY(!result.parsed);
    }

    void missingClientSecretFailsFlowCleanly() {
        GoogleAuthFlow flow;
        QSignalSpy failedSpy(&flow, &GoogleAuthFlow::failed);
        flow.start();
        QCOMPARE(failedSpy.count(), 1);
        QCOMPARE(failedSpy.at(0).at(0).toString(), QString("missing-client-secret"));
    }

    void clientSecretReadFromEnvironment() {
        qputenv("TRISCORD_GOOGLE_CLIENT_SECRET", "env-secret");
        QCOMPARE(googleClientSecret(), QString("env-secret"));
    }

    void clientSecretReadFromSettingsWhenEnvAbsent() {
        QSettings().setValue("googleClientSecret", "settings-secret");
        QCOMPARE(googleClientSecret(), QString("settings-secret"));
    }

    void clientSecretEmptyWhenNotConfigured() {
        QVERIFY(googleClientSecret().isEmpty());
    }

    // --- AuthSession persistence ---

    void sessionRoundTripsThroughSettings() {
        AuthSession first;
        first.setSignedIn("tok-1", "id-1", "a@example.com", "Alice", "https://example.com/a.png",
                           QDateTime::currentDateTimeUtc().addDays(1));
        QVERIFY(first.isValid());

        AuthSession second;
        QCOMPARE(second.session(), QString("tok-1"));
        QCOMPARE(second.id(), QString("id-1"));
        QCOMPARE(second.email(), QString("a@example.com"));
        QCOMPARE(second.nick(), QString("Alice"));
        QVERIFY(second.isValid());
    }

    void expiredStoredSessionIsNotValid() {
        AuthSession session;
        session.setSignedIn("tok-2", "id-2", "b@example.com", "Bob", {},
                             QDateTime::currentDateTimeUtc().addSecs(-60));
        QVERIFY(!session.isValid());
    }

    void noStoredSessionIsNotValid() {
        AuthSession session;
        QVERIFY(!session.isValid());
        QVERIFY(session.session().isEmpty());
    }

    void clearSessionWipesFields() {
        AuthSession session;
        session.setSignedIn("tok-3", "id-3", "c@example.com", "Carl", {}, QDateTime::currentDateTimeUtc().addDays(1));
        QSignalSpy signedOutSpy(&session, &AuthSession::signedOut);
        session.clearSession();
        QVERIFY(session.session().isEmpty());
        QVERIFY(!session.isValid());
        QCOMPARE(signedOutSpy.count(), 1);
    }

    void expiredSessionTreatedAsSignedOutOnValidate() {
        AuthSession session;
        session.setSignedIn("tok-4", "id-4", "d@example.com", "Dan", {}, QDateTime::currentDateTimeUtc().addSecs(-5));
        QSignalSpy signedOutSpy(&session, &AuthSession::signedOut);
        session.validateAsync();
        QCOMPARE(signedOutSpy.count(), 1);
        QVERIFY(session.session().isEmpty());
    }

    void validateRefreshesNestedAccountAndClearsRemovedAvatar() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        QByteArray received;
        const QByteArray body = R"({"account":{"id":"id-refreshed","email":"new@example.com","nick":"New nick","avatar_url":null}})";
        connect(&server, &QTcpServer::newConnection, this, [&] {
            auto* socket = server.nextPendingConnection();
            connect(socket, &QTcpSocket::readyRead, socket, [&, socket] {
                received += socket->readAll();
                if (!received.contains("\r\n\r\n")) return;
                socket->write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " +
                    QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
                socket->disconnectFromHost();
            });
        });
        qputenv("TRISCORD_AUTH_SERVER", QString("http://127.0.0.1:%1").arg(server.serverPort()).toUtf8());
        AuthSession session;
        session.setSignedIn("local-test-session", "old-id", "old@example.com", "Old nick", "https://example.com/removed.png",
            QDateTime::currentDateTimeUtc().addDays(1));
        QSignalSpy signedInSpy(&session, &AuthSession::signedIn);
        session.validateAsync();
        QTRY_COMPARE(signedInSpy.count(), 1);
        QVERIFY(received.startsWith("GET /me HTTP/1.1"));
        QVERIFY(received.toLower().contains("authorization: bearer local-test-session"));
        QCOMPARE(session.id(), QString("id-refreshed"));
        QCOMPARE(session.email(), QString("new@example.com"));
        QCOMPARE(session.nick(), QString("New nick"));
        QVERIFY(session.avatarUrl().isEmpty());
        AuthSession persisted;
        QCOMPARE(persisted.nick(), QString("New nick"));
        QVERIFY(persisted.avatarUrl().isEmpty());
        QCOMPARE(persisted.session(), QString("local-test-session"));
        qunsetenv("TRISCORD_AUTH_SERVER");
    }
};

QTEST_GUILESS_MAIN(GoogleAuthTests)
#include "google_auth_tests.moc"
