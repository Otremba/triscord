#pragma once
#include <QByteArray>
#include <QCache>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QObject>
#include <QSet>
#include <QString>
#include <functional>

namespace triscord {

// Client side of the auth worker's profile media API (cloudflare-auth/BACKEND_HANDOFF.md):
// PUT /profile/avatar|banner with the raw bytes and their real MIME type, DELETE to remove, and the
// public GET of the returned media url. Limits mirror the worker so an oversized file is refused before
// any upload: avatar 524288 bytes, banner 1048576 bytes; PNG, JPEG and GIF (animated GIF kept).
enum class ProfileMediaKind { Avatar, Banner };

qint64 profileMediaMaxBytes(ProfileMediaKind kind);

// MIME type from the file's magic bytes ("image/png", "image/jpeg", "image/gif"); empty for anything
// else. The worker rejects a Content-Type that does not match the content, so the extension is ignored.
QString sniffProfileImageMime(const QByteArray& bytes);

// Short Portuguese message for a local or server-side refusal; empty when `status` is a success.
QString profileMediaErrorMessage(ProfileMediaKind kind, int status, const QJsonObject& body = {});

class ProfileMediaClient final : public QObject {
    Q_OBJECT
public:
    // status 0 = no HTTP answer. `account` is the updated account on success.
    using Done = std::function<void(int status, const QJsonObject& account, const QJsonObject& body)>;
    explicit ProfileMediaClient(QObject* parent = nullptr);
    void upload(const QString& session, ProfileMediaKind kind, const QByteArray& bytes, Done done);
    void remove(const QString& session, ProfileMediaKind kind, Done done);

private:
    QNetworkAccessManager network_;
};

// Process-wide LRU cache, capped at 8 MiB of compressed image bytes.
class RemoteImageCache final : public QObject {
    Q_OBJECT
public:
    static RemoteImageCache& instance();
    // Cached bytes, or empty while not downloaded yet.
    QByteArray bytes(const QString& url) const {
        const auto* image = cache_.object(url);
        return image ? *image : QByteArray();
    }
    // Downloads once; `loaded` fires with the url when bytes are available (immediately if cached).
    void fetch(const QString& url);
signals:
    void loaded(const QString& url);

private:
    RemoteImageCache() = default;
    QNetworkAccessManager network_;
    QCache<QString, QByteArray> cache_{8 * 1024}; // cost unit: KiB
    QSet<QString> pending_;
};

} // namespace triscord
