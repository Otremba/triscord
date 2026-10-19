#pragma once
#include <QObject>
#include <QString>
#include <QDateTime>
#include <QNetworkAccessManager>

namespace triscord {

// Base URL of the deployed Cloudflare Worker that backs Google sign-in
// (see cloudflare-auth/src/worker.js). Overridable via the
// TRISCORD_AUTH_SERVER environment variable for tests/alternate deployments.
QString authServerUrl();

// Holds the signed-in account and its session token, persisted via QSettings
// under the "auth/" key prefix (same persistence mechanism as every other
// local preference, see main_window.cpp / ice_config.cpp). The session token
// and any id_token are never logged; they only ever reach QSettings and the
// Authorization header sent to the auth worker.
class AuthSession final : public QObject {
    Q_OBJECT
public:
    explicit AuthSession(QObject* parent = nullptr);

    // True when a session token is present and its expiry (if known) has not
    // passed. Does not contact the network; see validateAsync() for that.
    bool isValid() const;

    QString session() const { return session_; }
    QString id() const { return id_; }
    QString email() const { return email_; }
    QString nick() const { return nick_; }
    QString avatarUrl() const { return avatarUrl_; }
    QDateTime expiresAt() const { return expiresAt_; }

    // Stores the session returned by POST /auth/google and persists it.
    void setSignedIn(const QString& session, const QString& id, const QString& email,
                      const QString& nick, const QString& avatarUrl, const QDateTime& expiresAt);

    // Updates only the nick (after a successful POST /nick) and persists it.
    void setNick(const QString& nick);

    // Clears the stored session (local only; does not call /logout).
    void clearSession();

    // If a stored session exists, asks GET /me to confirm it is still valid
    // and refreshes the cached fields from the response. On 401/network
    // failure the session is cleared. Safe to call with no stored session
    // (it is a no-op). Emits signedIn()/signedOut() when the outcome is known.
    void validateAsync();

signals:
    void signedIn();
    void signedOut();

private:
    void load();
    void persist();

    QNetworkAccessManager network_;
    QString session_, id_, email_, nick_, avatarUrl_;
    QDateTime expiresAt_;
};

} // namespace triscord
