#include "notification_policy.h"

#include <QRegularExpression>

namespace triscord {

bool mentionsName(const QString& text, const QString& name) {
    const auto clean = name.trimmed();
    if (clean.isEmpty()) return false;
    const QRegularExpression pattern(QString::fromLatin1(R"((?<![\p{L}\p{N}_])@?)") + QRegularExpression::escape(clean) + QString::fromLatin1(R"((?![\p{L}\p{N}_]))"),
        QRegularExpression::CaseInsensitiveOption | QRegularExpression::UseUnicodePropertiesOption);
    return pattern.match(text).hasMatch();
}

void NotificationPolicy::memberEntered(const QString& name, bool background) {
    if (!enabled_ || !background || name.isEmpty() || (entryRate_.isValid() && entryRate_.elapsed() < 3000)) return;
    entryRate_.start();
    emit deliver("Triscord", name.left(32) + " entrou na sala");
}

void NotificationPolicy::chatMessage(const QJsonObject& message, const QString& selfSocket, const QString& selfName, bool background) {
    if (!enabled_ || !background || message.value("senderSocketId").toString() == selfSocket ||
        !mentionsName(message.value("text").toString(), selfName) || (mentionRate_.isValid() && mentionRate_.elapsed() < 3000)) return;
    mentionRate_.start();
    emit deliver("Triscord · " + message.value("senderName").toString().left(32) + " mencionou você",
                 message.value("text").toString().left(160));
}

} // namespace triscord
