#pragma once
#include "notification_policy.h"
#include <QObject>
#include <QJsonObject>
class QSystemTrayIcon;
namespace triscord {
// Qt Widgets client: NotificationPolicy decides, a tray icon shows the message.
class DesktopNotifications final : public QObject {
    Q_OBJECT
public:
    explicit DesktopNotifications(QObject* parent = nullptr, bool native = true);
    void setEnabled(bool enabled);
    void memberEntered(const QString& name, bool background) { policy_.memberEntered(name, background); }
    void chatMessage(const QJsonObject& message, const QString& selfSocket,
                     const QString& selfName, bool background) { policy_.chatMessage(message, selfSocket, selfName, background); }
signals:
    void requested(const QString& title, const QString& body);
    void openRequested();
private:
    void deliver(const QString& title, const QString& body);
    bool native_;
    NotificationPolicy policy_;
    QSystemTrayIcon* tray_ = nullptr;
};
}
