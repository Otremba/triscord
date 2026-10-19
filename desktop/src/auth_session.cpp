#include "auth_session.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSettings>
#include <QUrl>

namespace triscord {

QString authServerUrl() {
    const auto env = qEnvironmentVariable("TRISCORD_AUTH_SERVER");
    if (!env.isEmpty()) return env;
    return QStringLiteral("https://triscord-auth.triscord-cloudflare-control.workers.dev");
}

AuthSession::AuthSession(QObject* parent) : QObject(parent) {
    load();
}

void AuthSession::load() {
    QSettings settings;
    session_ = settings.value("auth/session").toString();
    id_ = settings.value("auth/id").toString();
    email_ = settings.value("auth/email").toString();
    nick_ = settings.value("auth/nick").toString();
    avatarUrl_ = settings.value("auth/avatarUrl").toString();
    expiresAt_ = QDateTime::fromString(settings.value("auth/expiresAt").toString(), Qt::ISODate);
}

void AuthSession::persist() {
    QSettings settings;
    settings.setValue("auth/session", session_);
    settings.setValue("auth/id", id_);
    settings.setValue("auth/email", email_);
    settings.setValue("auth/nick", nick_);
    settings.setValue("auth/avatarUrl", avatarUrl_);
    settings.setValue("auth/expiresAt", expiresAt_.toString(Qt::ISODate));
}

bool AuthSession::isValid() const {
    if (session_.isEmpty()) return false;
    if (expiresAt_.isValid() && QDateTime::currentDateTimeUtc() >= expiresAt_) return false;
    return true;
}

void AuthSession::setSignedIn(const QString& session, const QString& id, const QString& email,
                               const QString& nick, const QString& avatarUrl, const QDateTime& expiresAt) {
    session_ = session;
    id_ = id;
    email_ = email;
    nick_ = nick;
    avatarUrl_ = avatarUrl;
    expiresAt_ = expiresAt;
    persist();
    emit signedIn();
}

void AuthSession::setNick(const QString& nick) {
    nick_ = nick;
    persist();
}

void AuthSession::clearSession() {
    const bool wasSignedIn = !session_.isEmpty();
    session_.clear();
    id_.clear();
    email_.clear();
    nick_.clear();
    avatarUrl_.clear();
    expiresAt_ = QDateTime();
    persist();
    if (wasSignedIn) emit signedOut();
}

void AuthSession::validateAsync() {
    if (session_.isEmpty()) { emit signedOut(); return; }
    if (expiresAt_.isValid() && QDateTime::currentDateTimeUtc() >= expiresAt_) {
        clearSession();
        return;
    }
    QNetworkRequest request(QUrl(authServerUrl() + "/me"));
    request.setRawHeader("Authorization", "Bearer " + session_.toUtf8());
    auto* reply = network_.get(request);
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        if (reply->error() != QNetworkReply::NoError) {
            const auto status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
            if (status == 401) { clearSession(); return; }
            // Any other network failure: keep the cached session (offline
            // start should not sign the user out), but still report the
            // cached state so the UI can proceed.
            emit signedIn();
            return;
        }
        const auto doc = QJsonDocument::fromJson(reply->readAll());
        const auto account = doc.object().value("account").toObject();
        if (account.isEmpty()) { emit signedIn(); return; }
        id_ = account.value("id").toString(id_);
        email_ = account.value("email").toString(email_);
        nick_ = account.value("nick").toString(nick_);
        if (account.contains("avatar_url")) avatarUrl_ = account.value("avatar_url").toString();
        persist();
        emit signedIn();
    });
}

} // namespace triscord
