#pragma once
#include <QObject>
#include <QJsonArray>
#include <QJsonObject>
#include <QTimer>
#include <QUrl>
#include <QWebSocket>

namespace triscord {
// Engine.IO v4 / Socket.IO default namespace, JSON events only. Binary and
// acknowledgements are intentionally rejected until their adapters exist.
class Signaling final : public QObject {
    Q_OBJECT
public:
    explicit Signaling(QObject* parent = nullptr);
    // `route` adds query items to the WebSocket URL; the hub routes a connection carrying
    // serverId + sessionToken to that server's Durable Object (cloudflare/src/worker.js).
    void connectTo(const QUrl& baseUrl, const QString& invite = {}, const QList<QPair<QString, QString>>& route = {});
    void disconnectFromServer();
    bool sendEvent(const QString& event, const QJsonObject& data);
    bool ready() const { return ready_; }
    QString socketId() const { return socketId_; }
    static QUrl endpoint(const QUrl& baseUrl, const QList<QPair<QString, QString>>& route = {});
signals:
    void statusChanged(const QString& status);
    void eventReceived(const QString& event, const QJsonArray& arguments);
    void connected();
    void sessionStarted(const QString& socketId);
    void disconnected();
    void protocolError(const QString& message);
private:
    void receive(const QString& packet);
    void scheduleRetry();
    QWebSocket socket_;
    QTimer retry_;
    QTimer watchdog_;
    QUrl url_;
    QString socketId_;
    QString invite_;
    bool ready_ = false;
    bool wanted_ = false;
    bool opened_ = false;
    int attempts_ = 0;
    int heartbeatMs_ = 45000;
};
}
