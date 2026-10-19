#pragma once
#include <QElapsedTimer>
#include <QJsonObject>
#include <QObject>
#include <QString>

namespace triscord {

// True when `text` mentions `name` as a whole word (optionally with @), case-insensitively.
bool mentionsName(const QString& text, const QString& name);

// When triscord notifies (no UI here, so both the Qt client and the WebView2 client use it): someone entering
// the room you are in, and chat messages that mention you, only while the app is in the background, at most one
// of each every 3 seconds, never for your own messages.
class NotificationPolicy final : public QObject {
    Q_OBJECT
public:
    explicit NotificationPolicy(QObject* parent = nullptr) : QObject(parent) {}
    void setEnabled(bool enabled) { enabled_ = enabled; }
    bool isEnabled() const { return enabled_; }
    void memberEntered(const QString& name, bool background);
    void chatMessage(const QJsonObject& message, const QString& selfSocket, const QString& selfName, bool background);

signals:
    void deliver(const QString& title, const QString& body);

private:
    bool enabled_ = true;
    QElapsedTimer entryRate_, mentionRate_;
};

} // namespace triscord
