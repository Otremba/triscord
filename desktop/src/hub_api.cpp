#include "hub_api.h"
#include <QJsonDocument>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QUrl>
#include <algorithm>

namespace triscord {
namespace {

HubServer serverFrom(const QJsonObject& object) {
    return {object.value("id").toString(), object.value("name").toString(), object.value("ownerAccountId").toString()};
}

} // namespace

HubApi::HubApi(QObject* parent) : QObject(parent) {
    network_.setTransferTimeout(15000);
}

void HubApi::request(const QByteArray& method, const QString& path, const QJsonObject& body, Reply done) {
    if (!canCall()) { if (done) done(0, {}); return; }
    auto base = base_;
    while (base.endsWith('/')) base.chop(1);
    QNetworkRequest request(QUrl(base + path));
    request.setRawHeader("Authorization", "Bearer " + session_.toUtf8());
    QNetworkReply* reply = nullptr;
    if (method == "GET") {
        reply = network_.get(request);
    } else {
        request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
        reply = network_.sendCustomRequest(request, method, QJsonDocument(body).toJson(QJsonDocument::Compact));
    }
    connect(reply, &QNetworkReply::finished, this, [reply, done] {
        reply->deleteLater();
        const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
        if (done) done(status, QJsonDocument::fromJson(reply->readAll()).object());
    });
}

void HubApi::fetchIce(std::function<void(int, const QJsonArray&)> done) {
    request("GET", "/ice", {}, [done](int status, const QJsonObject& body) {
        done(status, status == 200 ? body.value("iceServers").toArray() : QJsonArray{});
    });
}

void HubApi::listServers(std::function<void(int, const QList<HubServer>&)> done) {
    request("GET", "/servers", {}, [done](int status, const QJsonObject& body) {
        QList<HubServer> servers;
        if (status == 200)
            for (const auto& value : body.value("servers").toArray()) {
                const auto server = serverFrom(value.toObject());
                if (!server.id.isEmpty()) servers << server;
            }
        done(status, servers);
    });
}

void HubApi::createServer(const QString& name, std::function<void(int, const HubServer&)> done) {
    request("POST", "/servers", {{"name", name}}, [done](int status, const QJsonObject& body) {
        done(status, status == 201 ? serverFrom(body) : HubServer{});
    });
}

void HubApi::createInvite(const QString& serverId, std::function<void(int, const QString&)> done) {
    request("POST", "/servers/" + serverId + "/invites", {}, [done](int status, const QJsonObject& body) {
        done(status, status == 201 ? body.value("code").toString() : QString());
    });
}

void HubApi::acceptInvite(const QString& code, std::function<void(int, const QString&)> done) {
    request("POST", "/invites/" + code + "/accept", {}, [done](int status, const QJsonObject& body) {
        done(status, status == 200 ? body.value("serverId").toString() : QString());
    });
}

void HubApi::deleteServer(const QString& serverId, std::function<void(int)> done) {
    request("DELETE", "/servers/" + serverId, {}, [done](int status, const QJsonObject&) { done(status); });
}

void HubApi::leaveServer(const QString& serverId, std::function<void(int)> done) {
    request("POST", "/servers/" + serverId + "/leave", {}, [done](int status, const QJsonObject&) { done(status); });
}

QString HubApi::extractInviteCode(const QString& text) {
    static const QRegularExpression code("(?<![0-9a-fA-F])([0-9a-fA-F]{32})(?![0-9a-fA-F])");
    const auto match = code.match(text);
    return match.hasMatch() ? match.captured(1).toLower() : QString();
}

QString HubApi::serverAcronym(const QString& name) {
    static const QRegularExpression possessive("'s ");
    static const QRegularExpression word("\\w+");
    static const QRegularExpression space("\\s");
    auto text = name;
    text.replace(possessive, " ");
    QString out;
    qsizetype last = 0;
    auto it = word.globalMatch(text);
    while (it.hasNext()) {
        const auto match = it.next();
        out += text.mid(last, match.capturedStart() - last);
        out += match.captured().left(1);
        last = match.capturedEnd();
    }
    out += text.mid(last);
    out.remove(space);
    return out;
}

ServerListPlan HubApi::planServerList(const QList<HubServer>& servers, const QString& selected, const QString& callServer, bool inCall) {
    auto has = [&](const QString& id) { return std::any_of(servers.begin(), servers.end(), [&](const HubServer& s) { return s.id == id; }); };
    ServerListPlan plan;
    plan.selected = selected;
    const bool callGone = !callServer.isEmpty() && !has(callServer);
    plan.leaveCall = inCall && callGone;
    if (!has(selected)) {
        plan.selectionChanged = true;
        plan.showCallServer = inCall && !callGone;
        plan.selected = plan.showCallServer ? callServer : servers.isEmpty() ? QString() : servers.first().id;
        plan.reconnect = !plan.showCallServer && (!selected.isEmpty() || !servers.isEmpty());
    }
    if (callGone) plan.reconnect = true;
    return plan;
}

} // namespace triscord
