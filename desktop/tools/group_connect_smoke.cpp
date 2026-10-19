#include "signaling.h"
#include "group_connection.h"
#include <QCoreApplication>
#include <QTimer>
#include <QUuid>
#include <cstdio>
int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    if (!triscord::groupConnection::automatic) {
        std::fprintf(stderr, "This development check requires an explicitly configured private group build.\n"); return 2;
    }
    triscord::Signaling signal;
    const auto marker = QUuid::createUuid().toString(QUuid::WithoutBraces);
    QObject::connect(&signal, &triscord::Signaling::connected, &app, [&] {
        signal.sendEvent("join-room", {{"roomId", "native-validation"}, {"roomName", "Validação nativa"},
            {"userData", QJsonObject{{"userId", marker}, {"username", "Automatic group check"}, {"isMuted", true}}}});
    });
    QObject::connect(&signal, &triscord::Signaling::protocolError, &app, [&] { app.exit(3); });
    QObject::connect(&signal, &triscord::Signaling::eventReceived, &app, [&](const QString& name, const QJsonArray& args) {
        if (args.isEmpty()) return;
        if (name == "room-joined") signal.sendEvent("send-chat-message", {{"message", "Validação automática " + marker}});
        else if (name == "new-chat-message" && args.first().toObject().value("text").toString().endsWith(marker)) {
            std::puts("PASS: compiled automatic server/invitation authenticated, joined and exchanged chat without external configuration");
            signal.disconnectFromServer(); app.quit();
        }
    });
    QTimer::singleShot(15000, &app, [&] { app.exit(4); });
    signal.connectTo(QUrl(triscord::groupConnection::server), QString::fromUtf8(triscord::groupConnection::invite));
    return app.exec();
}
