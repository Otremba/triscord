#include "signaling.h"
#include <QJsonDocument>
#include <QUrlQuery>
#include <algorithm>
#include <cstdio>

namespace triscord {
namespace {
// For the log a user can send: why the server connection dropped (19/10: a friend's call rejoined ten times in a row and
// the log could not say why). Never the URL, which carries the session token.
void note(const QString& text) { std::printf("signaling: %s\n", text.toUtf8().constData()); std::fflush(stdout); }
}
Signaling::Signaling(QObject* parent) : QObject(parent) {
    socket_.setMaxAllowedIncomingMessageSize(4 * 1024 * 1024);
    socket_.setMaxAllowedIncomingFrameSize(4 * 1024 * 1024);
    retry_.setSingleShot(true);
    watchdog_.setSingleShot(true);
    connect(&retry_, &QTimer::timeout, this, [this] {
        if (wanted_) { opened_ = false; socket_.open(url_); watchdog_.start(15000); }
    });
    connect(&watchdog_, &QTimer::timeout, this, [this] {
        note(opened_ ? QString("no heartbeat from the server for %1 s, reconnecting").arg(heartbeatMs_ / 1000)
                     : QStringLiteral("the server did not answer within 15 s, retrying"));
        emit statusChanged(QStringLiteral("Conexão expirou; reconectando"));
        socket_.abort();
        scheduleRetry();
    });
    connect(&socket_, &QWebSocket::textMessageReceived, this, &Signaling::receive);
    connect(&socket_, &QWebSocket::disconnected, this, [this] {
        if (wanted_ && ready_) {
            const auto reason = socket_.closeReason().left(120);
            note(QString("connection closed (code %1%2)").arg(int(socket_.closeCode())).arg(reason.isEmpty() ? QString() : ", " + reason));
        }
        watchdog_.stop();
        opened_ = false;
        if (ready_) { ready_ = false; emit disconnected(); }
        scheduleRetry();
    });
    connect(&socket_, &QWebSocket::errorOccurred, this, [this](QAbstractSocket::SocketError error) {
        if (wanted_) note(QString("network error %1: %2").arg(int(error)).arg(socket_.errorString().left(120)));
        emit statusChanged("Não foi possível conectar. Tentando novamente.");
        scheduleRetry();
    });
}

QUrl Signaling::endpoint(const QUrl& baseUrl, const QList<QPair<QString, QString>>& route) {
    auto url = baseUrl;
    const auto scheme = url.scheme().toLower();
    if (!url.isValid() || url.host().isEmpty() || !url.userInfo().isEmpty() ||
        (scheme != "http" && scheme != "https" && scheme != "ws" && scheme != "wss")) return {};
    url.setScheme((scheme == "https" || scheme == "wss") ? "wss" : "ws");
    auto path = url.path();
    if (!path.endsWith('/')) path += '/';
    url.setPath(path + "socket.io/");
    url.setFragment({});
    QUrlQuery query;
    query.addQueryItem("EIO", "4");
    query.addQueryItem("transport", "websocket");
    for (const auto& item : route)
        if (!item.second.isEmpty()) query.addQueryItem(item.first, item.second); // ids and tokens are [A-Za-z0-9_-]
    url.setQuery(query);
    return url;
}

void Signaling::connectTo(const QUrl& baseUrl, const QString& invite, const QList<QPair<QString, QString>>& route) {
    disconnectFromServer();
    url_ = endpoint(baseUrl, route);
    invite_ = invite.left(128);
    if (url_.isEmpty()) { emit protocolError("Endereço de servidor inválido"); return; }
    wanted_ = true;
    emit statusChanged("Conectando");
    socket_.open(url_);
    watchdog_.start(15000);
}

void Signaling::disconnectFromServer() {
    wanted_ = false;
    retry_.stop();
    watchdog_.stop();
    if (ready_) socket_.sendTextMessage("41");
    const bool wasReady = ready_;
    ready_ = false;
    opened_ = false;
    socketId_.clear();
    attempts_ = 0;
    socket_.abort();
    if (wasReady) emit disconnected();
}

void Signaling::scheduleRetry() {
    if (!wanted_ || retry_.isActive()) return;
    if (ready_) { ready_ = false; emit disconnected(); }
    watchdog_.stop();
    retry_.start(std::min(15000, 500 * (1 << std::min(attempts_++, 5))));
}

bool Signaling::sendEvent(const QString& event, const QJsonObject& data) {
    if (!ready_ || event.isEmpty() || socket_.bytesToWrite() > 65536) return false; // Never buffer stale session signals.
    const auto json = QJsonDocument(QJsonArray{event, data}).toJson(QJsonDocument::Compact);
    return socket_.sendTextMessage("42" + QString::fromUtf8(json)) >= 0;
}

void Signaling::receive(const QString& packet) {
    if (!wanted_ || packet.isEmpty()) return;
    if (packet.startsWith('0')) {
        const auto doc = QJsonDocument::fromJson(packet.mid(1).toUtf8());
        if (!doc.isObject() || !doc.object().value("sid").isString() || opened_) {
            emit protocolError("Handshake Engine.IO inválido"); return;
        }
        opened_ = true;
        const auto obj = doc.object();
        const auto interval = std::clamp(obj.value("pingInterval").toInt(25000), 500, 60000);
        const auto timeout = std::clamp(obj.value("pingTimeout").toInt(20000), 500, 60000);
        heartbeatMs_ = interval + timeout;
        watchdog_.start(heartbeatMs_);
        socket_.sendTextMessage(invite_.isEmpty() ? "40" : "40" + QString::fromUtf8(QJsonDocument(QJsonObject{{"invite", invite_}}).toJson(QJsonDocument::Compact)));
    } else if (packet.startsWith('2') && opened_) {
        socket_.sendTextMessage("3" + packet.mid(1));
        watchdog_.start(heartbeatMs_);
    } else if (packet.startsWith("40") && opened_ && !ready_) {
        const auto sid = QJsonDocument::fromJson(packet.mid(2).toUtf8()).object().value("sid").toString();
        if (sid.isEmpty()) { emit protocolError("Sessão Socket.IO inválida"); return; }
        socketId_ = sid;
        ready_ = true;
        attempts_ = 0;
        retry_.stop();
        emit statusChanged("Conectado — selecione uma sala");
        emit sessionStarted(socketId_);
        emit connected();
    } else if (packet.startsWith("42[" ) && ready_) {
        const auto doc = QJsonDocument::fromJson(packet.mid(2).toUtf8());
        if (!doc.isArray() || doc.array().isEmpty() || !doc.array().first().isString()) {
            emit protocolError("Evento Socket.IO inválido"); return;
        }
        auto args = doc.array();
        const auto event = args.takeAt(0).toString();
        emit eventReceived(event, args);
    } else if (packet == "6") {
        return; // Engine.IO noop, including hibernating Workers auto-responses.
    } else if (packet.startsWith("44")) {
        disconnectFromServer();
        emit protocolError("Código do grupo inválido ou acesso recusado.");
    } else if (packet == "41" || packet == "1") {
        note(QStringLiteral("the server ended the session, reconnecting"));
        socket_.abort();
        scheduleRetry();
    } else {
        emit protocolError("Pacote não suportado pelo protótipo nativo");
    }
}
}
