#include "google_auth.h"
#include "auth_session.h"
#include "google_client.h"

#include <QCryptographicHash>
#include <QDesktopServices>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QSettings>
#include <QTcpSocket>
#include <QUrl>
#include <QUrlQuery>

namespace triscord {
namespace {
constexpr int kFlowTimeoutMs = 3 * 60 * 1000;
}

QString googleClientId() {
    return QStringLiteral("250225176755-tdsas1pgo4b4ikbspqunik5v88i81rpi.apps.googleusercontent.com");
}

QString googleClientSecret() {
    const auto env = qEnvironmentVariable("TRISCORD_GOOGLE_CLIENT_SECRET");
    if (!env.isEmpty()) return env;
    const auto configured = QSettings().value("googleClientSecret").toString();
    if (!configured.isEmpty()) return configured;
    return QString::fromLatin1(googleClient::builtinSecret);
}

QString generateCodeVerifier() {
    static const QString charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    QString result;
    result.reserve(128);
    auto* rng = QRandomGenerator::system();
    for (int i = 0; i < 128; ++i) {
        result.append(charset.at(static_cast<int>(rng->bounded(static_cast<quint32>(charset.size())))));
    }
    return result;
}

QString codeChallengeS256(const QString& codeVerifier) {
    const auto hash = QCryptographicHash::hash(codeVerifier.toUtf8(), QCryptographicHash::Sha256);
    return QString::fromUtf8(hash.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

QString generateState() {
    auto* rng = QRandomGenerator::system();
    QByteArray bytes(24, Qt::Uninitialized);
    for (auto& byte : bytes) byte = static_cast<char>(rng->bounded(256u));
    return QString::fromUtf8(bytes.toBase64(QByteArray::Base64UrlEncoding | QByteArray::OmitTrailingEquals));
}

QString buildAuthorizationUrl(const QString& clientId, const QString& redirectUri,
                               const QString& codeChallenge, const QString& state) {
    // TRISCORD_GOOGLE_AUTH_URL / TRISCORD_GOOGLE_TOKEN_URL point the flow at the local fake Google of the
    // end-to-end tests (tests/e2e/); the real endpoints are used whenever they are unset.
    QUrl url(qEnvironmentVariable("TRISCORD_GOOGLE_AUTH_URL", "https://accounts.google.com/o/oauth2/v2/auth"));
    QUrlQuery query;
    query.addQueryItem("client_id", clientId);
    query.addQueryItem("redirect_uri", redirectUri);
    query.addQueryItem("response_type", "code");
    query.addQueryItem("scope", "openid email profile");
    query.addQueryItem("code_challenge", codeChallenge);
    query.addQueryItem("code_challenge_method", "S256");
    query.addQueryItem("state", state);
    url.setQuery(query);
    // Fully encoded: the default pretty form left "openid email profile" with raw spaces (found by the e2e test).
    return QString::fromUtf8(url.toEncoded());
}

CallbackResult parseLoopbackRequest(const QByteArray& requestLine) {
    CallbackResult result;
    // Expect "GET /<path>?<query> HTTP/1.1" as the first line of the request.
    const auto firstLine = requestLine.split('\n').value(0).trimmed();
    const auto parts = firstLine.split(' ');
    if (parts.size() < 2 || parts.at(0) != "GET") return result;
    const QUrl url(QString::fromUtf8(parts.at(1)), QUrl::TolerantMode);
    const QUrlQuery query(url.query());
    result.parsed = true;
    result.code = query.queryItemValue("code", QUrl::FullyDecoded);
    result.state = query.queryItemValue("state", QUrl::FullyDecoded);
    result.error = query.queryItemValue("error", QUrl::FullyDecoded);
    return result;
}

QString loopbackResponseHtml(bool success) {
    const auto message = success ? "Login concluído. Você pode fechar esta aba e voltar ao Triscord."
                                  : "Não foi possível concluir o login. Você pode fechar esta aba e tentar novamente no Triscord.";
    return QString("<html><head><meta charset=\"utf-8\"></head><body style=\"font-family:sans-serif;background:#1e1f22;color:#dcdcdf;"
                    "display:flex;align-items:center;justify-content:center;height:100vh;margin:0;\"><p>%1</p></body></html>")
        .arg(message);
}

GoogleAuthFlow::GoogleAuthFlow(QObject* parent) : QObject(parent) {
    timeout_.setSingleShot(true);
    connect(&timeout_, &QTimer::timeout, this, [this] { finishFailed("timeout"); });
    connect(&server_, &QTcpServer::newConnection, this, &GoogleAuthFlow::onNewConnection);
}

GoogleAuthFlow::~GoogleAuthFlow() {
    if (server_.isListening()) server_.close();
}

void GoogleAuthFlow::cancel() {
    finishFailed("cancelled");
}

void GoogleAuthFlow::finishFailed(const QString& reason) {
    if (finished_) return;
    finished_ = true;
    timeout_.stop();
    if (server_.isListening()) server_.close();
    emit failed(reason);
}

void GoogleAuthFlow::start() {
    if (googleClientSecret().isEmpty()) {
        finishFailed("missing-client-secret");
        return;
    }
    if (!server_.listen(QHostAddress::LocalHost, 0)) {
        finishFailed("loopback-listen-failed");
        return;
    }
    redirectUri_ = QString("http://127.0.0.1:%1/").arg(server_.serverPort());
    codeVerifier_ = generateCodeVerifier();
    state_ = generateState();
    const auto authUrl = buildAuthorizationUrl(googleClientId(), redirectUri_, codeChallengeS256(codeVerifier_), state_);
    // End-to-end tests read the authorization URL from a file instead of a browser opening on the desktop.
    if (const auto urlFile = qEnvironmentVariable("TRISCORD_OPEN_URL_FILE"); !urlFile.isEmpty()) {
        QFile file(urlFile);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(authUrl.toUtf8()) < 0) {
            finishFailed("browser-open-failed");
            return;
        }
    } else if (!QDesktopServices::openUrl(QUrl(authUrl))) {
        finishFailed("browser-open-failed");
        return;
    }
    timeout_.start(kFlowTimeoutMs);
}

void GoogleAuthFlow::onNewConnection() {
    auto* socket = server_.nextPendingConnection();
    if (!socket) return;
    connect(socket, &QTcpSocket::readyRead, this, [this, socket] {
        const auto request = socket->readAll();
        const auto result = parseLoopbackRequest(request);
        const bool success = result.parsed && result.error.isEmpty() && !result.code.isEmpty() && result.state == state_;
        socket->write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n");
        socket->write(loopbackResponseHtml(success).toUtf8());
        socket->flush();
        socket->disconnectFromHost();
        socket->deleteLater();

        if (finished_) return;
        if (!result.parsed) return; // ignore stray requests (favicon etc.), keep listening.
        server_.close();
        if (!result.error.isEmpty()) { finishFailed(result.error); return; }
        if (result.state != state_) { finishFailed("state-mismatch"); return; }
        if (result.code.isEmpty()) { finishFailed("no-code"); return; }
        exchangeCode(result.code);
    });
}

void GoogleAuthFlow::exchangeCode(const QString& code) {
    QNetworkRequest request(QUrl(qEnvironmentVariable("TRISCORD_GOOGLE_TOKEN_URL", "https://oauth2.googleapis.com/token")));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/x-www-form-urlencoded");
    QUrlQuery body;
    body.addQueryItem("code", code);
    body.addQueryItem("client_id", googleClientId());
    body.addQueryItem("client_secret", googleClientSecret());
    body.addQueryItem("redirect_uri", redirectUri_);
    body.addQueryItem("grant_type", "authorization_code");
    body.addQueryItem("code_verifier", codeVerifier_);
    auto* reply = network_.post(request, body.toString(QUrl::FullyEncoded).toUtf8());
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        if (finished_) return;
        if (reply->error() != QNetworkReply::NoError) { finishFailed("token-exchange-failed"); return; }
        const auto doc = QJsonDocument::fromJson(reply->readAll());
        const auto idToken = doc.object().value("id_token").toString();
        if (idToken.isEmpty()) { finishFailed("no-id-token"); return; }
        postToAuthWorker(idToken);
    });
}

void GoogleAuthFlow::postToAuthWorker(const QString& idToken) {
    QNetworkRequest request(QUrl(authServerUrl() + "/auth/google"));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    QJsonObject body;
    body["id_token"] = idToken;
    auto* reply = network_.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    connect(reply, &QNetworkReply::finished, this, [this, reply] {
        reply->deleteLater();
        if (finished_) return;
        if (reply->error() != QNetworkReply::NoError) { finishFailed("auth-worker-failed"); return; }
        const auto object = QJsonDocument::fromJson(reply->readAll()).object();
        const auto account = object.value("account").toObject();
        if (account.isEmpty() || object.value("session").toString().isEmpty()) {
            finishFailed("auth-worker-bad-response");
            return;
        }
        GoogleIdentity identity;
        identity.session = object.value("session").toString();
        identity.expiresAt = object.value("expires_at").toString();
        identity.id = account.value("id").toString();
        identity.email = account.value("email").toString();
        identity.nick = account.value("nick").toString();
        identity.avatarUrl = account.value("avatar_url").toString();
        identity.isNew = account.value("is_new").toBool();
        finished_ = true;
        timeout_.stop();
        emit succeeded(identity);
    });
}

} // namespace triscord
