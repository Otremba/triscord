#include "desktop_notifications.h"
#include <QApplication>
#include <QSystemTrayIcon>
namespace triscord {
DesktopNotifications::DesktopNotifications(QObject* parent, bool native) : QObject(parent), native_(native) {
    connect(&policy_, &NotificationPolicy::deliver, this, &DesktopNotifications::deliver);
}
void DesktopNotifications::setEnabled(bool enabled) { policy_.setEnabled(enabled); if (!enabled && tray_) tray_->hide(); }
void DesktopNotifications::deliver(const QString& title, const QString& body) {
    emit requested(title, body);
    if (!native_ || !QSystemTrayIcon::isSystemTrayAvailable() || !QSystemTrayIcon::supportsMessages()) return;
    if (!tray_) {
        tray_ = new QSystemTrayIcon(QApplication::windowIcon(), this); tray_->setToolTip("Triscord");
        connect(tray_, &QSystemTrayIcon::messageClicked, this, &DesktopNotifications::openRequested);
        connect(tray_, &QSystemTrayIcon::activated, this, [this](QSystemTrayIcon::ActivationReason reason) {
            if (reason == QSystemTrayIcon::Trigger || reason == QSystemTrayIcon::DoubleClick) emit openRequested();
        });
    }
    tray_->show(); tray_->showMessage(title, body, QSystemTrayIcon::Information, 5000);
}
}
