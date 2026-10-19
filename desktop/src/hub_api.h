#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QNetworkAccessManager>
#include <QObject>
#include <QString>
#include <functional>

namespace triscord {

// One server (guild) the signed-in account belongs to, as returned by the
// signaling hub's GET /servers (cloudflare/src/worker.js handleServersApi).
struct HubServer {
    QString id;
    QString name;
    QString ownerAccountId;
};

// What the client does once GET /servers answers (CoreSession::refreshServers), given the server shown, the server
// the main connection belongs to and whether a call is up there.
struct ServerListPlan {
    QString selected;            // server to show
    bool selectionChanged = false;
    bool showCallServer = false; // the shown server vanished while a call is up elsewhere: show the call's server
    bool leaveCall = false;      // the call's server is gone
    bool reconnect = false;      // move the main connection to `selected`
};

// HTTP client for the signaling hub's account-scoped API: the server
// directory, invites and GET /ice. Every call carries the auth worker's
// session token as "Authorization: Bearer"; the token is never logged.
// All calls are asynchronous; callbacks run on the owning thread. Status 0
// means the request never got an HTTP answer (offline, DNS, TLS).
//
// A hub deployed before the server layer answers 404 for /servers and /ice:
// callers treat that as "feature not available" and keep the legacy single
// server working.
class HubApi final : public QObject {
    Q_OBJECT
public:
    using Reply = std::function<void(int status, const QJsonObject& body)>;
    explicit HubApi(QObject* parent = nullptr);

    void setBaseUrl(const QString& url) { base_ = url.trimmed(); }
    void setSession(const QString& token) { session_ = token; }
    bool canCall() const { return !base_.isEmpty() && !session_.isEmpty(); }

    void request(const QByteArray& method, const QString& path, const QJsonObject& body, Reply done);

    void fetchIce(std::function<void(int status, const QJsonArray& iceServers)> done);
    void listServers(std::function<void(int status, const QList<HubServer>& servers)> done);
    void createServer(const QString& name, std::function<void(int status, const HubServer& server)> done);
    void createInvite(const QString& serverId, std::function<void(int status, const QString& code)> done);
    void acceptInvite(const QString& code, std::function<void(int status, const QString& serverId)> done);
    // DELETE /servers/:id (owner only) and POST /servers/:id/leave (members; the owner gets 409).
    void deleteServer(const QString& serverId, std::function<void(int status)> done);
    void leaveServer(const QString& serverId, std::function<void(int status)> done);

    // Pulls the 32-hex invite code out of whatever the user pasted (the bare
    // code, or any text/link that contains it). Empty when there is none.
    static QString extractInviteCode(const QString& text);
    // Discord's guild acronym, ported from its web bundle (f_0000d3 offset
    // 11891250): e.replace(/'s /g," ").replace(/\w+/g,e=>e[0]).replace(/\s/g,"")
    // "Servidor de camargo" -> "Sdc", the tile observed in the server rail.
    static QString serverAcronym(const QString& name);
    // Leaving or deleting the viewed server must not drop a call on another server, and a connection to a server
    // that no longer exists (deleted by its owner) must move, or it retries the refused handshake forever.
    static ServerListPlan planServerList(const QList<HubServer>& servers, const QString& selected, const QString& callServer, bool inCall);

private:
    QNetworkAccessManager network_;
    QString base_, session_;
};

} // namespace triscord
