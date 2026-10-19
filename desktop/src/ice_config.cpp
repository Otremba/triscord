#include <cstdio>
#include "ice_config.h"
#include <QByteArray>
#include <QDateTime>
#include <QMutex>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QSettings>
#include <QStringList>

namespace triscord {
namespace {

std::vector<IceServerEntry> parseIceServersJson(const QByteArray& json) {
    std::vector<IceServerEntry> entries;
    const auto doc = QJsonDocument::fromJson(json);
    if (!doc.isArray()) return entries;
    for (const auto& value : doc.array()) {
        if (!value.isObject()) continue;
        const auto object = value.toObject();
        const auto url = object.value("url").toString();
        if (url.isEmpty()) continue;
        entries.push_back(IceServerEntry{url, object.value("username").toString(), object.value("credential").toString()});
    }
    return entries;
}

std::vector<IceServerEntry> defaultIceServers() {
    return {
        {"stun:stun.l.google.com:19302", {}, {}},
        {"stun:stun1.l.google.com:19302", {}, {}},
        {"stun:stun2.l.google.com:19302", {}, {}},
        {"stun:stun.cloudflare.com:3478", {}, {}},
    };
}

QMutex sessionMutex;
std::vector<IceServerEntry> sessionServers;
qint64 sessionExpiresAtMs = 0;

} // namespace

std::vector<IceServerEntry> parseRtcIceServers(const QJsonArray& servers) {
    std::vector<IceServerEntry> entries;
    for (const auto& value : servers) {
        if (!value.isObject()) continue;
        const auto object = value.toObject();
        QStringList urls;
        const auto raw = object.value("urls");
        if (raw.isString()) urls << raw.toString();
        for (const auto& url : raw.toArray()) urls << url.toString();
        if (object.value("url").isString()) urls << object.value("url").toString();
        for (const auto& url : urls) {
            if (!url.startsWith("stun:") && !url.startsWith("turn:") && !url.startsWith("turns:")) continue;
            entries.push_back(IceServerEntry{url, object.value("username").toString(), object.value("credential").toString()});
        }
    }
    return entries;
}

void setSessionIceServers(const std::vector<IceServerEntry>& entries, qint64 expiresAtMs) {
    QMutexLocker lock(&sessionMutex);
    sessionServers = entries;
    sessionExpiresAtMs = expiresAtMs;
}

void clearSessionIceServers() { setSessionIceServers({}, 0); }

bool iceRelayOnly() { return qEnvironmentVariable("TRISCORD_ICE_RELAY_ONLY") == "1"; }


bool hasSessionIceServers() {
    QMutexLocker lock(&sessionMutex);
    return !sessionServers.empty() && QDateTime::currentMSecsSinceEpoch() < sessionExpiresAtMs;
}

std::vector<IceServerEntry> resolveIceServers() {
    const auto env = qEnvironmentVariable("TRISCORD_ICE_SERVERS");
    if (!env.isEmpty()) {
        auto parsed = parseIceServersJson(env.toUtf8());
        if (!parsed.empty()) return parsed;
    }
    const auto configured = QSettings().value("iceServers").toString();
    if (!configured.isEmpty()) {
        auto parsed = parseIceServersJson(configured.toUtf8());
        if (!parsed.empty()) return parsed;
    }
    auto servers = defaultIceServers();
    QMutexLocker lock(&sessionMutex);
    if (!sessionServers.empty() && QDateTime::currentMSecsSinceEpoch() < sessionExpiresAtMs)
        servers.insert(servers.begin(), sessionServers.begin(), sessionServers.end());
    return servers;
}

std::vector<rtc::IceServer> toRtcIceServers(const std::vector<IceServerEntry>& entries) {
    std::vector<rtc::IceServer> servers;
    for (const auto& entry : entries) {
        if (entry.url.isEmpty()) continue;
        if (entry.username.isEmpty() && entry.credential.isEmpty()) {
            servers.emplace_back(entry.url.toStdString());
            continue;
        }
        // A TURN entry with credentials needs the hostname/port split out
        // separately, since the single-string constructor has no way to
        // carry a username and password. A query string (e.g.
        // "?transport=tcp") may follow the port, so it must be stripped
        // before parsing the port number, and its "transport=" value maps
        // to the relay type the credentialed constructor otherwise defaults
        // away (TurnUdp).
        auto rest = entry.url;
        const auto scheme = rest.indexOf(':');
        if (scheme >= 0) rest = rest.mid(scheme + 1);
        QString query;
        const auto queryIndex = rest.indexOf('?');
        if (queryIndex >= 0) {
            query = rest.mid(queryIndex + 1);
            rest = rest.left(queryIndex);
        }
        const auto parts = rest.split(':');
        const auto hostname = parts.value(0).toStdString();
        if (hostname.empty()) continue;
        const uint16_t port = parts.size() > 1 ? static_cast<uint16_t>(parts.at(1).toUInt()) : 3478;
        auto relayType = rtc::IceServer::RelayType::TurnUdp;
        if (entry.url.startsWith("turns:")) {
            relayType = rtc::IceServer::RelayType::TurnTls;
        } else if (query.contains("transport=tcp")) {
            relayType = rtc::IceServer::RelayType::TurnTcp;
        } else if (query.contains("transport=tls")) {
            relayType = rtc::IceServer::RelayType::TurnTls;
        }
        servers.emplace_back(hostname, port, entry.username.toStdString(), entry.credential.toStdString(), relayType);
    }
    return servers;
}

} // namespace triscord
