#include "profile_media.h"
#include "auth_session.h"
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSet>
#include <QTimer>
#include <QUrl>
#include <memory>

namespace triscord {
namespace {

QString mediaPath(ProfileMediaKind kind) {
    return kind == ProfileMediaKind::Avatar ? QStringLiteral("/profile/avatar") : QStringLiteral("/profile/banner");
}

} // namespace

qint64 profileMediaMaxBytes(ProfileMediaKind kind) {
    return kind == ProfileMediaKind::Avatar ? 524288 : 1048576;
}

QString sniffProfileImageMime(const QByteArray& bytes) {
    if (bytes.startsWith(QByteArray::fromHex("89504e470d0a1a0a"))) return "image/png";
    if (bytes.startsWith(QByteArray::fromHex("ffd8ff"))) return "image/jpeg";
    if (bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a")) return "image/gif";
    return {};
}

QString profileMediaErrorMessage(ProfileMediaKind kind, int status, const QJsonObject& body) {
    if (status >= 200 && status < 300) return {};
    const bool avatar = kind == ProfileMediaKind::Avatar;
    if (status == 413) {
        const qint64 max = body.value("max_bytes").toInteger(profileMediaMaxBytes(kind));
        return QString("Imagem grande demais (máximo %1 KB).").arg(max / 1024);
    }
    if (status == 415) return "Formato não aceito. Use PNG, JPEG ou GIF.";
    if (status == 507) return "O espaço de imagens do servidor acabou. Tente de novo mais tarde.";
    if (status == 401) return "Sua sessão expirou. Entre com o Google de novo.";
    if (status == 404) return "O servidor de contas publicado ainda não aceita imagens.";
    if (status == 0) return "Sem conexão com o servidor. Tente novamente.";
    return avatar ? "Não foi possível atualizar o avatar." : "Não foi possível atualizar a faixa.";
}

ProfileMediaClient::ProfileMediaClient(QObject* parent) : QObject(parent) {
    network_.setTransferTimeout(30000);
}

void ProfileMediaClient::upload(const QString& session, ProfileMediaKind kind, const QByteArray& bytes, Done done) {
    // Refuse locally what the worker would refuse anyway (and never send an unknown type).
    const auto mime = sniffProfileImageMime(bytes);
    if (mime.isEmpty()) { QTimer::singleShot(0, this, [done] { done(415, {}, {}); }); return; }
    if (bytes.size() > profileMediaMaxBytes(kind)) {
        const QJsonObject body{{"error", "media_too_large"}, {"max_bytes", profileMediaMaxBytes(kind)}};
        QTimer::singleShot(0, this, [done, body] { done(413, {}, body); });
        return;
    }
    QNetworkRequest request(QUrl(authServerUrl() + mediaPath(kind)));
    request.setRawHeader("Authorization", "Bearer " + session.toUtf8());
    request.setHeader(QNetworkRequest::ContentTypeHeader, mime);
    auto* reply = network_.put(request, bytes);
    connect(reply, &QNetworkReply::finished, this, [reply, done] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const auto body = QJsonDocument::fromJson(reply->readAll()).object();
        done(status, body.value("account").toObject(), body);
    });
}

void ProfileMediaClient::remove(const QString& session, ProfileMediaKind kind, Done done) {
    QNetworkRequest request(QUrl(authServerUrl() + mediaPath(kind)));
    request.setRawHeader("Authorization", "Bearer " + session.toUtf8());
    auto* reply = network_.deleteResource(request);
    connect(reply, &QNetworkReply::finished, this, [reply, done] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        const auto body = QJsonDocument::fromJson(reply->readAll()).object();
        done(status, body.value("account").toObject(), body);
    });
}

RemoteImageCache& RemoteImageCache::instance() {
    static RemoteImageCache cache;
    return cache;
}

void RemoteImageCache::fetch(const QString& url) {
    if (url.isEmpty()) return;
    if (cache_.contains(url)) { emit loaded(url); return; }
    if (pending_.contains(url)) return;
    const QUrl target(url);
    if (target.scheme() != "https" && target.scheme() != "http") return;
    pending_.insert(url);
    QNetworkRequest request(target);
    request.setTransferTimeout(20000);
    auto* reply = network_.get(request);
    constexpr qint64 maxImageBytes = 2 * 1048576;
    struct Download { QByteArray bytes; bool oversized = false; };
    const auto download = std::make_shared<Download>();
    // Enforce the cap while receiving, including chunked responses. Checking
    // readAll() only after finished already allowed unbounded buffering.
    reply->setReadBufferSize(64 * 1024);
    connect(reply, &QIODevice::readyRead, this, [reply, download] {
        const auto remaining = maxImageBytes - download->bytes.size();
        const auto chunk = reply->read(remaining + 1);
        if (chunk.size() > remaining) {
            download->oversized = true;
            reply->abort();
            return;
        }
        download->bytes.append(chunk);
    });
    connect(reply, &QNetworkReply::finished, this, [this, reply, url, download] {
        reply->deleteLater();
        pending_.remove(url);
        if (download->oversized || reply->error() != QNetworkReply::NoError) return;
        const auto tail = reply->read(maxImageBytes - download->bytes.size() + 1);
        if (download->bytes.size() + tail.size() > maxImageBytes) return;
        download->bytes.append(tail);
        const auto& bytes = download->bytes;
        // Only keep real images, capped at the banner limit plus slack (Google avatars are small too).
        if (sniffProfileImageMime(bytes).isEmpty()) return;
        cache_.insert(url, new QByteArray(bytes), static_cast<int>((bytes.size() + 1023) / 1024));
        emit loaded(url);
    });
}

} // namespace triscord
