#pragma once
#include <QObject>
#include <QString>
#include <QTcpServer>
#include <QNetworkAccessManager>
#include <QTimer>
#include <optional>

namespace triscord {

// The native app's Google OAuth client id (Desktop app type, production).
// Not a secret: desktop/installed-app client ids are public by design.
QString googleClientId();

// The OAuth client secret paired with googleClientId(). Google's installed-app
// token exchange requires it even though a desktop client is not confidential
// (see RFC 8252 §8.5). Resolution order, matching ice_config.cpp's pattern:
//   1. TRISCORD_GOOGLE_CLIENT_SECRET environment variable.
//   2. QSettings key "googleClientSecret".
//   3. The secret a distributed build carries (TRISCORD_GOOGLE_CLIENT_SECRET_FILE
//      at configure time, generated header; never in source control).
//   4. Empty (not configured) — callers must treat this as "sign-in
//      unavailable" and fail clearly, never crash or fall back to a literal.
QString googleClientSecret();

// --- Pure, testable PKCE/OAuth helpers -------------------------------------

// Cryptographically random code_verifier, 43-128 chars from the PKCE
// "unreserved" charset [A-Za-z0-9-._~].
QString generateCodeVerifier();

// code_challenge = BASE64URL-ENCODE(SHA256(code_verifier)), per RFC 7636.
QString codeChallengeS256(const QString& codeVerifier);

// Random opaque value used as the OAuth "state" parameter (CSRF protection).
QString generateState();

QString buildAuthorizationUrl(const QString& clientId, const QString& redirectUri,
                               const QString& codeChallenge, const QString& state);

// Result of parsing the first line + query string of the loopback HTTP
// callback request Google's browser redirect makes, e.g.
// "GET /?code=abc&state=xyz HTTP/1.1".
struct CallbackResult {
    QString code;
    QString state;
    QString error; // e.g. "access_denied"; empty when no error parameter.
    bool parsed = false; // false if the request line could not be parsed at all.
};
CallbackResult parseLoopbackRequest(const QByteArray& requestLine);

// Minimal HTML shown in the browser tab after the callback lands.
QString loopbackResponseHtml(bool success);

// --- Full interactive flow --------------------------------------------------

struct GoogleIdentity {
    QString session;
    QString id;
    QString email;
    QString nick;
    QString avatarUrl;
    QString expiresAt; // ISO 8601, as returned by the auth worker.
    bool isNew = false;
};

// Drives one interactive sign-in attempt: starts a loopback listener, opens
// the system browser, waits for the callback, exchanges the code, and posts
// the resulting id_token to the auth worker's /auth/google. Emits exactly one
// of succeeded()/failed() per start(), and can be destroyed safely from
// either.
class GoogleAuthFlow final : public QObject {
    Q_OBJECT
public:
    explicit GoogleAuthFlow(QObject* parent = nullptr);
    ~GoogleAuthFlow() override;

    // Begins the flow. Safe to call once per instance.
    void start();

    // Aborts the flow (e.g. user cancelled); cleans up the socket and emits
    // failed("cancelled") if not already finished.
    void cancel();

signals:
    void succeeded(const GoogleIdentity& identity);
    void failed(const QString& reason);

private:
    void finishFailed(const QString& reason);
    void onNewConnection();
    void exchangeCode(const QString& code);
    void postToAuthWorker(const QString& idToken);

    QTcpServer server_;
    QNetworkAccessManager network_;
    QTimer timeout_;
    QString codeVerifier_;
    QString state_;
    QString redirectUri_;
    bool finished_ = false;
};

} // namespace triscord
