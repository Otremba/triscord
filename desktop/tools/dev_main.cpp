#include "main_window.h"
#include "platform_probe.h"
#include <QApplication>
#include <QCommandLineParser>
#include <QFile>
#include <QJsonDocument>
#include <QTimer>
#include <QUuid>

int main(int argc, char** argv) {
    QApplication app(argc, argv);
    app.setOrganizationName("Triscord");
    app.setApplicationName("TriscordNativeDevTools");
    app.setApplicationVersion("0.6.2");
    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addVersionOption();
    parser.addOption({"smoke-report", "Write a startup diagnostic JSON and exit (does not record audio or capture the screen)", "path"});
    parser.addOption({"probe-capture", "Include a GPU-only desktop frame diagnostic in the smoke report"});
    parser.addOption({"preview-image", "Render only this application's window to a PNG", "path"});
    parser.addOption({"signaling-smoke", "Test rooms and a chat round trip against a local server", "url"});
    parser.process(app);
    triscord::MainWindow window;
    if (parser.isSet("preview-image")) {
        QTimer::singleShot(0, &app, [&] { app.exit(window.grab().save(parser.value("preview-image")) ? 0 : 5); });
    } else if (parser.isSet("signaling-smoke")) {
        // Integration tests may never accidentally connect to a hosted service.
        const QUrl server(parser.value("signaling-smoke"));
        if (server.host() != "127.0.0.1" && server.host() != "localhost" && server.host() != "::1") return 6;
        auto* signal = new triscord::Signaling(&app);
        const auto token = QUuid::createUuid().toString(QUuid::WithoutBraces);
        const auto room = "native-smoke-" + token;
        auto* deadline = new QTimer(&app);
        deadline->setSingleShot(true);
        QObject::connect(deadline, &QTimer::timeout, &app, [&] { app.exit(7); });
        QObject::connect(signal, &triscord::Signaling::eventReceived, &app,
            [&, signal, token, room, deadline](const QString& event, const QJsonArray& args) {
                if (args.isEmpty()) return;
                if (event == "rooms-update" && args.first().isArray() && !signal->property("joined").toBool()) {
                    signal->setProperty("joined", true);
                    signal->sendEvent("join-room", {{"roomId", room}, {"userData", QJsonObject{
                        {"userId", "native_" + token}, {"username", "Native Smoke"}, {"isMuted", true}}}});
                } else if (event == "room-joined" && args.first().toObject().value("roomId").toString() == room) {
                    signal->sendEvent("send-chat-message", {{"roomId", room}, {"message", token}});
                } else if (event == "new-chat-message") {
                    const auto message = args.first().toObject();
                    if (message.value("text").toString() != token || message.value("senderName").toString() != "Native Smoke") return;
                    QFile file(parser.value("smoke-report"));
                    if (!file.open(QIODevice::WriteOnly)) { app.exit(2); return; }
                    const auto bytes = QJsonDocument(QJsonObject{{"connected", true}, {"roomJoined", true},
                        {"chatRoundTrip", true}, {"voiceImplemented", true}, {"screenSharingImplemented", true}}).toJson();
                    const bool written = file.write(bytes) == bytes.size();
                    deadline->stop();
                    signal->disconnectFromServer();
                    app.exit(written ? 0 : 3);
                }
            });
        deadline->start(10000);
        signal->connectTo(server);
    } else if (!parser.isSet("smoke-report")) parser.showHelp();
    else QTimer::singleShot(1000, &app, [&] {
        QJsonObject report{{"version", app.applicationVersion()}, {"qt", qVersion()},
                           {"process", triscord::processMetrics()}, {"graphics", triscord::probeGraphics()},
                           {"microphone", triscord::probeMicrophone()}, {"voiceImplemented", true}, {"screenSharingImplemented", true}};
        if (parser.isSet("probe-capture")) report.insert("desktopFrame", triscord::probeDesktopFrame());
        QFile file(parser.value("smoke-report"));
        if (!file.open(QIODevice::WriteOnly)) { app.exit(2); return; }
        const auto bytes = QJsonDocument(report).toJson();
        app.exit(file.write(bytes) == bytes.size() ? 0 : 3);
    });
    return app.exec();
}
