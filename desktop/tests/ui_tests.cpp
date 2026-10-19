#include "markdown_parser.h"
#include "account_panel.h"
#include "main_window.h"
#include "server_dialog.h"
#include "profile_preview.h"
#include <QBuffer>
#include <QMovie>
#include <QStackedWidget>
#include "dark_theme.h"
#include "share_session.h"
#include "video_stage_label.h"
#include "chat_pane.h"
#include "participant_pane.h"
#include "call_grid.h"
#include "call_footer.h"
#include "camera_view.h"
#include "soundboard.h"
#include "share_picker.h"
#include "call_shortcuts.h"
#include "desktop_notifications.h"
#include "discord_icons.h"
#include "channel_composer.h"
#include "navigation_chrome.h"
#include "bundled_fonts.h"
#include "call_views.h"
#include "settings_view.h"
#include "login_window.h"
#include "auth_session.h"
#include "profile_edit_dialog.h"
#include <QtTest>
#include <QWebSocketServer>
#include <QLineEdit>
#include <QSettings>
#include <QJsonDocument>
#include <QDir>
#include <QPainter>
#include <QCheckBox>
#include <QSplitter>
#include <QScrollArea>
#include <QDateTime>
#include <QCryptographicHash>
#include <QAudioBufferOutput>
#include <QMediaPlayer>
#include <QAudioBuffer>
#include <QTemporaryDir>
#include <QMenu>
#include <QSlider>
#include <QSpinBox>
#include <QClipboard>
#include <QTcpServer>
#include <QTcpSocket>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QDialog>
#include <functional>
using namespace triscord;

namespace {
// Minimal single-threaded HTTP stub for GET /me and PATCH /profile, used so
// profile-editor tests never touch the live Worker. `respond` is given the
// method, path and parsed JSON body and returns (status, json body).
struct StubAuthServer {
    QTcpServer server;
    std::function<QPair<int, QJsonObject>(const QString&, const QString&, const QJsonObject&)> respond;

    StubAuthServer() {
        server.listen(QHostAddress::LocalHost);
        QObject::connect(&server, &QTcpServer::newConnection, &server, [this] {
            while (server.hasPendingConnections()) {
                auto* socket = server.nextPendingConnection();
                QObject::connect(socket, &QTcpSocket::readyRead, socket, [this, socket] { handle(socket); });
                QObject::connect(socket, &QTcpSocket::disconnected, socket, &QObject::deleteLater);
            }
        });
    }

    QString url() const { return QString("http://127.0.0.1:%1").arg(server.serverPort()); }

    void handle(QTcpSocket* socket) {
        auto buffer = socket->property("buf").toByteArray();
        buffer += socket->readAll();
        socket->setProperty("buf", buffer);
        const int headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const auto headerBlock = buffer.left(headerEnd);
        int contentLength = 0;
        for (const auto& line : headerBlock.split('\n')) {
            if (line.toLower().startsWith("content-length:")) contentLength = line.mid(16).trimmed().toInt();
        }
        const int bodyStart = headerEnd + 4;
        if (buffer.size() - bodyStart < contentLength) return;
        const auto body = buffer.mid(bodyStart, contentLength);
        const auto requestLine = headerBlock.split('\n').value(0).trimmed().split(' ');
        const QString method = QString::fromUtf8(requestLine.value(0));
        const QString path = QString::fromUtf8(requestLine.value(1));
        const auto bodyObj = QJsonDocument::fromJson(body).object();
        const auto result = respond ? respond(method, path, bodyObj) : qMakePair(404, QJsonObject{{"error", "not_found"}});
        const auto json = QJsonDocument(result.second).toJson(QJsonDocument::Compact);
        QByteArray response = "HTTP/1.1 " + QByteArray::number(result.first) + " X\r\n"
            "Content-Type: application/json\r\nContent-Length: " + QByteArray::number(json.size()) +
            "\r\nConnection: close\r\n\r\n" + json;
        socket->write(response);
        socket->flush();
        socket->disconnectFromHost();
    }
};
} // namespace

class UiTests final : public QObject {
    Q_OBJECT
private slots:
    void chatSpoilersAndLinksInteractWithoutOpeningHiddenLinks() {
        ChatPane chat; chat.resize(640,240); chat.show();
        QSignalSpy links(&chat, &ChatPane::linkRequested);
        chat.appendMessage({{"id","interactive"},{"senderName","amigo"},{"text","||[segredo](https://example.org/private)|| [site](https://example.org)"}});
        QCoreApplication::processEvents();
        auto* row = chat.item(0);
        QVERIFY(!row->data(Qt::AccessibleTextRole).toString().contains("segredo"));
        const auto& hidden = chat.formattedMessage(chat.model()->index(0,0),chat.font());
        QCOMPARE(hidden.spoilers.size(),1); QVERIFY(!hidden.spoilers[0].revealed);
        QVERIFY(hidden.formats.first().format.foreground() == hidden.formats.first().format.background());
        const QPoint first(80,8+QFontMetrics(chat.font()).height()+QFontMetrics(chat.font()).height()/2);
        QTest::mouseClick(chat.viewport(),Qt::LeftButton,Qt::NoModifier,first);
        QCOMPARE(links.count(),0);
        QVERIFY(row->data(Qt::AccessibleTextRole).toString().contains("segredo"));
        QTest::mouseClick(chat.viewport(),Qt::LeftButton,Qt::NoModifier,first);
        QCOMPARE(links.count(),1);
        QCOMPARE(links.first().first().toUrl(),QUrl("https://example.org/private"));
        QVERIFY(chat.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-revealed.png")));
        chat.clear();
        chat.appendMessage({{"id","interactive"},{"senderName","amigo"},{"text","||segredo||"}});
        QVERIFY(!chat.item(0)->data(Qt::AccessibleTextRole).toString().contains("segredo"));
        chat.clear(); links.clear();
        chat.appendMessage({{"id","unsafe"},{"senderName","amigo"},{"text","[abrir](file:///C:/Windows/notepad.exe)"}});
        QCoreApplication::processEvents(); QTest::mouseClick(chat.viewport(),Qt::LeftButton,Qt::NoModifier,first);
        QCOMPARE(links.count(),0);
    }
    void relativeTimestampsRefreshOnlyWhileChatIsVisible() {
        ChatPane chat; chat.resize(480,200); chat.show();
        chat.appendMessage({{"id","relative"},{"senderName","amigo"},
            {"text",QString("<t:%1:R>").arg(QDateTime::currentSecsSinceEpoch()-5)}});
        const auto index = chat.model()->index(0,0);
        const auto initial = chat.formattedMessage(index,chat.font()).plainText;
        QTRY_VERIFY_WITH_TIMEOUT(chat.formattedMessage(index,chat.font()).plainText != initial,2500);
        chat.hide(); const auto hidden = chat.formattedMessage(index,chat.font()).plainText;
        QTest::qWait(1200);
        QCOMPARE(chat.formattedMessage(index,chat.font()).plainText,hidden);
        chat.show();
        QVERIFY(chat.formattedMessage(index,chat.font()).plainText != hidden);
        chat.clear(); QCOMPARE(chat.count(),0);
    }
    void timestampsAndPixelFontsUseNativeLayout() {
        QFont font; font.setPixelSize(13);
        const auto heading = buildFormattedMarkdown(parseDiscordMarkdown("# título"),font);
        QVERIFY(heading.formats.first().format.font().pixelSize() > 13);
        const auto now = QDateTime(QDate(2026,10,14),QTime(12,0));
        auto node = [](const QDateTime& date, const QString& format) {
            return MarkdownNode{.type=MarkdownNodeType::Timestamp,.content="invalid",.lang=format,.id=QString::number(date.toSecsSinceEpoch())};
        };
        QCOMPARE(formatDiscordTimestamp(node(now,"s"),now),QString("14/10/2026 12:00"));
        QCOMPARE(formatDiscordTimestamp(node(now,"S"),now),QString("14/10/2026 12:00:00"));
        QCOMPARE(formatDiscordTimestamp(node(now,""),now),QString("14 de outubro de 2026 12:00"));
        QCOMPARE(formatDiscordTimestamp(node(now.addSecs(-59),"R"),now),QString("há 59 segundos"));
        QCOMPARE(formatDiscordTimestamp(node(now.addSecs(60),"R"),now),QString("em 1 minuto"));
        QCOMPARE(formatDiscordTimestamp(node(now.addSecs(-3599),"R"),now),QString("há 1 hora"));
        QCOMPARE(formatDiscordTimestamp(node(now.addMonths(2),"R"),now),QString("em 2 meses"));
        for (const auto& format : {"t","T","d","D","f","F","s","S","R"}) {
            const auto ast = parseDiscordMarkdown(QString("<t:1791975600:%1>").arg(format),{.inlineOnly=true});
            QCOMPARE(ast[0].type,MarkdownNodeType::Timestamp);
            QVERIFY(!buildFormattedMarkdown(ast,font).plainText.contains("<t:"));
        }
        const auto invalid = parseDiscordMarkdown("<t:99999999999999999:F>",{.inlineOnly=true});
        QCOMPARE(buildFormattedMarkdown(invalid,font).plainText,QString("<t:99999999999999999:F>"));
    }
    void chatDateSeparatorsRebuildWithoutExtraRows() {
        ChatPane chat; chat.resize(480,320); chat.show();
        const auto time = QDateTime(QDate(2026,10,14),QTime(23,58)).toMSecsSinceEpoch();
        auto message = [time](const QString& id,qint64 offset) {
            return QJsonObject{{"id",id},{"senderUserId","a"},{"senderName","amigo"},{"text",id},{"timestamp",static_cast<double>(time+offset)}};
        };
        chat.appendMessage(message("vamos jogar?",0)); chat.appendMessage(message("já estou na sala",60000));
        chat.appendMessage(message("amanhã seguimos daqui",180000)); QCoreApplication::processEvents();
        QCOMPARE(chat.count(),3);
        QCOMPARE(chat.item(0)->data(Qt::UserRole+3).toString(),QString("14 de outubro de 2026"));
        QVERIFY(chat.item(1)->data(Qt::UserRole+3).toString().isEmpty());
        QCOMPARE(chat.item(2)->data(Qt::UserRole+3).toString(),QString("15 de outubro de 2026"));
        QVERIFY(chat.item(2)->data(Qt::AccessibleTextRole).toString().contains("15 de outubro de 2026"));
        QSignalSpy selection(&chat,&QListWidget::itemSelectionChanged);
        QTest::mouseClick(chat.viewport(),Qt::LeftButton,Qt::NoModifier,QPoint(100,chat.visualItemRect(chat.item(0)).top()+8));
        QCOMPARE(selection.size(),0);
        QVERIFY(chat.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-dates.png")));
        chat.removeMessage("vamos jogar?");
        QCOMPARE(chat.count(),2); QCOMPARE(chat.item(0)->data(Qt::UserRole+3).toString(),QString("14 de outubro de 2026"));
        chat.clear();
        for (int n=0;n<201;++n) chat.appendMessage(message(QString::number(n),n*1000));
        QCOMPARE(chat.count(),200); QVERIFY(!chat.item(0)->data(Qt::UserRole+3).toString().isEmpty());
        auto legacy=message("sem data",0); legacy.remove("timestamp"); chat.appendMessage(legacy);
        QVERIFY(chat.item(chat.count()-1)->data(Qt::UserRole+3).toString().isEmpty());
    }
    void chatMessageActionBarFollowsObservedDiscord() {
        // Observed hover bar (CHAT.md): 16px above the message, 14px from its right edge; triscord keeps the
        // actions it can perform (three quick reactions, add reaction, more).
        ChatPane chat; chat.resize(873,300); chat.setCurrentUser("me"); chat.show();
        const auto time = QDateTime(QDate(2026,9,9),QTime(2,9)).toMSecsSinceEpoch();
        chat.appendMessage(QJsonObject{{"id","m1"},{"senderUserId","me"},{"senderName","camargo"},{"text","https://spotify.link/x"},{"timestamp",static_cast<double>(time)}});
        chat.appendMessage(QJsonObject{{"id","m2"},{"senderUserId","me"},{"senderName","camargo"},{"text","https://sabu.gg/"},{"timestamp",static_cast<double>(time+88*60000)}});
        QCoreApplication::processEvents();
        chat.doItemsLayout(); QTRY_VERIFY(chat.visualItemRect(chat.item(1)).height() > 0);
        // Let the platform deliver any enter/leave for the real cursor before the synthetic hover.
        QVERIFY(QTest::qWaitForWindowExposed(&chat)); QTest::qWait(150);
        auto* bar = chat.viewport()->findChild<QFrame*>("messageActionBar"); QVERIFY(bar); QVERIFY(!bar->isVisible());
        const QRect second = chat.visualItemRect(chat.item(1));
        { const QPointF at(300, second.center().y()); QMouseEvent move(QEvent::MouseMove, at, chat.viewport()->mapToGlobal(at), Qt::NoButton, Qt::NoButton, Qt::NoModifier); QCoreApplication::sendEvent(chat.viewport(), &move); } QCoreApplication::processEvents();
        QVERIFY(bar->isVisible()); QCOMPARE(bar->height(), 32); QCOMPARE(bar->width(), 155);
        QCOMPARE(bar->geometry().right() + 1, second.right() + 1 - 14); QCOMPARE(bar->y(), second.top() - 16);
        const auto quick = bar->findChildren<QPushButton*>("messageQuickReaction"); QCOMPARE(quick.size(), 3);
        QCOMPARE(quick[0]->size(), QSize(28, 28)); QCOMPARE(quick[0]->toolTip(), QString(":thumbsup:\nClique para reagir"));
        QCOMPARE(bar->findChild<QPushButton*>("messageAddReaction")->toolTip(), QString("Adicionar reação"));
        QCOMPARE(bar->findChild<QPushButton*>("messageMoreActions")->toolTip(), QString("Mais"));
        QVERIFY(chat.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-message-bar.png")));
        QSignalSpy reactions(&chat, &ChatPane::reactionRequested);
        quick[1]->click(); QCOMPARE(reactions.size(), 1);
        QCOMPARE(reactions[0][0].toString(), QString("m2")); QCOMPARE(reactions[0][1].toString(), QString::fromUtf8("❤️"));
        { const QPointF at(300, chat.visualItemRect(chat.item(0)).center().y()); QMouseEvent move(QEvent::MouseMove, at, chat.viewport()->mapToGlobal(at), Qt::NoButton, Qt::NoButton, Qt::NoModifier); QCoreApplication::sendEvent(chat.viewport(), &move); } QCoreApplication::processEvents();
        QCOMPARE(bar->y(), std::max(0, chat.visualItemRect(chat.item(0)).top() + 24 - 16)); // below the date separator
        { QEvent leave(QEvent::Leave); QCoreApplication::sendEvent(chat.viewport(), &leave); } QVERIFY(!bar->isVisible());
    }
    void chatGroupingUsesRecoveredAnchorAndTimeBoundary() {
        ChatPane chat; chat.resize(460,360); chat.show();
        const auto time = QDateTime(QDate(2026,10,14),QTime(12,0)).toMSecsSinceEpoch();
        auto message = [time](const QString& id, const QString& author, qint64 offset) {
            return QJsonObject{{"id",id},{"senderUserId",author},{"senderName","amigo"},
                               {"text","mensagem " + id},{"timestamp",static_cast<double>(time+offset)}};
        };
        chat.appendMessage(message("primeira","a",0));
        chat.appendMessage(message("continuação","a",6*60*1000));
        chat.appendMessage(message("novo grupo","a",7*60*1000));
        chat.appendMessage(message("segunda continuação","a",12*60*1000));
        chat.appendMessage(message("outro autor","b",12*60*1000));
        QCoreApplication::processEvents();
        QCOMPARE(chat.item(0)->data(Qt::UserRole+2).toBool(),true);
        QCOMPARE(chat.item(1)->data(Qt::UserRole+2).toBool(),false);
        QCOMPARE(chat.item(2)->data(Qt::UserRole+2).toBool(),true);
        QCOMPARE(chat.item(3)->data(Qt::UserRole+2).toBool(),false);
        QCOMPARE(chat.item(4)->data(Qt::UserRole+2).toBool(),true);
        QVERIFY(chat.visualItemRect(chat.item(1)).height() < chat.visualItemRect(chat.item(0)).height());
        QVERIFY(chat.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-grouped.png")));
        chat.removeMessage("novo grupo"); QCOMPARE(chat.item(2)->data(Qt::UserRole+2).toBool(),true);
        chat.removeMessage("primeira");
        QCOMPARE(chat.item(0)->data(Qt::UserRole+2).toBool(),true);
        QCOMPARE(chat.item(1)->data(Qt::UserRole+2).toBool(),false);
        chat.clear();
        const auto midnight = QDateTime(QDate(2026,10,14),QTime(23,59)).toMSecsSinceEpoch();
        auto first = message("antes","a",0); first.insert("timestamp",static_cast<double>(midnight));
        auto next = message("depois","a",0); next.insert("timestamp",static_cast<double>(midnight+120000));
        chat.appendMessage(first); chat.appendMessage(next); QVERIFY(chat.item(1)->data(Qt::UserRole+2).toBool());
        next.remove("senderUserId"); next.insert("id","sem identidade"); chat.appendMessage(next);
        QVERIFY(chat.item(2)->data(Qt::UserRole+2).toBool());
        chat.clear();
        for (int n = 0; n < 201; ++n) chat.appendMessage(message(QString::number(n),"a",n*1000));
        QCOMPARE(chat.count(),200); QVERIFY(chat.item(0)->data(Qt::UserRole+2).toBool());
        QVERIFY(!chat.item(1)->data(Qt::UserRole+2).toBool());
    }
    void chatMessagesWrapAndStayBounded() {
        ChatPane chat; chat.resize(600,400); chat.show();
        chat.appendMessage({{"id","short"},{"senderName","amigo"},{"text","vamos jogar?"},{"timestamp",1791986400000.0}});
        const auto body = QString("<b>texto literal</b>\n") + QString("mensagem longa sem perder o conteúdo. ").repeated(18);
        chat.appendMessage({{"id","long"},{"senderName","camargo"},{"text",body},{"timestamp",1791986460000.0}});
        QCoreApplication::processEvents(); const int wideHeight = chat.visualItemRect(chat.item(1)).height();
        chat.resize(300,400); QCoreApplication::processEvents();
        QVERIFY(chat.visualItemRect(chat.item(1)).height() > wideHeight);
        QCOMPARE(chat.item(1)->data(Qt::UserRole).toJsonObject().value("text").toString(),body);
        QVERIFY(chat.item(1)->data(Qt::AccessibleTextRole).toString().contains(body));
        chat.updateReactions({{"messageId","short"},{"reactions",QJsonObject{{"👍",QJsonArray{"a","b"}}}}});
        QVERIFY(chat.item(0)->text().contains("👍 2"));
        QVERIFY(chat.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-layout.png")));
        for (int n = 0; n < 205; ++n) chat.appendMessage({{"id",QString::number(n)},{"senderName","amigo"},{"text","mensagem"}});
        QCOMPARE(chat.count(),200); QCOMPARE(chat.item(0)->data(Qt::UserRole).toJsonObject().value("id").toString(),QString("5"));
        for (int n = 0; n < chat.count(); ++n) QVERIFY(!chat.itemWidget(chat.item(n)));
        chat.removeMessage("204"); QCOMPARE(chat.count(),199);
    }
    void callFooterReflowsWithoutClipping() {
        auto group = [](int width) {
            auto* widget = new QWidget;
            auto* layout = new QHBoxLayout(widget); layout->setContentsMargins(0,0,0,0);
            auto* button = new QPushButton("controle", widget); button->setFixedWidth(width); layout->addWidget(button);
            return widget;
        };
        auto* audio = group(240); auto* media = group(300); auto* actions = group(220);
        CallFooter footer(audio, media, actions); footer.resize(1100,120); footer.show(); QCoreApplication::processEvents();
        QCOMPARE(audio->geometry().top(), media->geometry().top());
        footer.resize(800,120); QCoreApplication::processEvents();
        QVERIFY(media->geometry().top() > audio->geometry().bottom());
        for (auto* widget : {audio,media,actions}) QVERIFY(footer.rect().contains(widget->geometry()));
        QVERIFY(!audio->geometry().intersects(actions->geometry()));
        footer.resize(1100,120); QCoreApplication::processEvents();
        QCOMPARE(audio->geometry().top(), media->geometry().top());
    }
    void recoveredCallGridGeometry() {
        // Expected values evaluated from the inert recovered JS module 511205,
        // independently of this C++ implementation.
        struct Fixture { int count, width, height, tileWidth, columns, rows; };
        for (const auto f : {Fixture{1,640,360,623,1,1}, Fixture{2,640,360,312,1,2},
                             Fixture{4,960,540,468,2,2}, Fixture{7,960,540,309,3,3},
                             Fixture{10,1280,720,310,4,3}, Fixture{26,960,540,180,5,6}}) {
            const auto grid = callGrid(f.count, f.width, f.height);
            QCOMPARE(grid.tileWidth, f.tileWidth); QCOMPARE(grid.columns, f.columns); QCOMPARE(grid.rows, f.rows);
            for (int i = 0; i < f.count; ++i) {
                const auto rect = grid.tile(i);
                QVERIFY(rect.left() >= 8); QVERIFY(rect.right() < f.width);
                if (f.count <= 25) QVERIFY(rect.bottom() < f.height);
                for (int j = 0; j < i; ++j) QVERIFY(!rect.intersects(grid.tile(j)));
            }
        }
        QCOMPARE(callGrid(0,640,360).rows, 0);
        QCOMPARE(callGrid(1,0,360).tileWidth, 0);
    }
    void callGridMatchesTheCardsMeasuredInDiscord() {
        // Measured on the real call view (SHARE.md), content area 889x762: two items give 643x362 cards 15px from
        // the top; three items give 432x243 cards in two columns whose incomplete last row is centred.
        QScrollArea host; host.setWidgetResizable(true); host.setFrameShape(QFrame::NoFrame); host.resize(889, 762);
        auto* pane = new ParticipantPane(&host); host.setWidget(pane); host.show();
        const QJsonObject first{{"socketId", "u1"}, {"username", "Um"}}, second{{"socketId", "u2"}, {"username", "Dois"}};
        pane->setParticipants(QJsonArray{first, second}); QCoreApplication::processEvents();
        QCOMPARE(pane->height(), 762);
        QCOMPARE(pane->tileRect("u1").size(), QSize(643, 361));
        QCOMPARE(pane->tileRect("u1").top(), 15);
        QVERIFY(pane->tileRect("u2").top() > pane->tileRect("u1").bottom());
        pane->setParticipants(QJsonArray{first}); pane->setStreams({StreamTile{"s", "Um", 0}});
        pane->setStreamFrame("s", QImage(784, 411, QImage::Format_RGB32)); pane->setParticipants(QJsonArray{first, second});
        QCoreApplication::processEvents();
        QCOMPARE(pane->tileRect("u1").size(), QSize(432, 243));
        QCOMPARE(pane->tileRect("u1").left(), 449); QCOMPARE(pane->tileRect("u1").top(), 130);
        QCOMPARE(pane->tileRect("u2").left(), 229);
        const QRect shared = pane->tileRect(ParticipantPane::streamKey("s"));
        QCOMPARE(shared.left(), 9); QCOMPARE(shared.width(), 432); QVERIFY(qAbs(shared.top() - 139) <= 1); QVERIFY(qAbs(shared.height() - 226) <= 1);
    }
    void cameraCardsLifecycle() {
        ParticipantPane pane; pane.resize(600, 220);
        const QJsonObject user{{"socketId", "camera-peer"}, {"username", "amigo"}, {"isMuted", false}};
        pane.setParticipants(QJsonArray{user}); pane.show();
        QImage image(320,180,QImage::Format_RGB32); image.fill(QColor(168,168,168));
        pane.setFrame("unknown-peer", image);
        QVERIFY(pane.grab().toImage().pixelColor(140,65) != QColor(168,168,168));
        pane.setFrame("camera-peer", image);
        QCOMPARE(pane.grab().toImage().pixelColor(140,65), QColor(168,168,168));
        QVERIFY(pane.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-camera-card.png")));
        pane.removeFrame("camera-peer");
        QVERIFY(pane.grab().toImage().pixelColor(140,65) != QColor(168,168,168));
        pane.setFrame("camera-peer", image); pane.setParticipants({});
        pane.setParticipants(QJsonArray{user});
        QVERIFY(pane.grab().toImage().pixelColor(140,65) != QColor(168,168,168));
    }
    void cameraFocusAndFullscreen() {
        ParticipantPane pane; pane.resize(600, 240);
        pane.setParticipants(QJsonArray{QJsonObject{{"socketId", "camera-peer"}, {"username", "amigo"}},
                                       QJsonObject{{"socketId", "camera-peer-2"}, {"username", "outro amigo"}}}); pane.show();
        QImage image(640,360,QImage::Format_RGB32); image.fill(QColor(80,100,120));
        pane.setFrame("camera-peer", image);
        pane.setFrame("camera-peer-2", image);
        QSignalSpy focused(&pane, &ParticipantPane::focusChanged);
        // Tiles move when the focus changes (grid <-> stage + filmstrip), so ask the pane where a tile is each time.
        auto centerOf = [&](const QString& key) { return pane.tileRect(key).center(); };
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer"));
        QCOMPARE(pane.focusedPeer(), QString("camera-peer")); QCOMPARE(focused.size(), 1);
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer")); QVERIFY(pane.focusedPeer().isEmpty());
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer")); QCOMPARE(pane.focusedPeer(), QString("camera-peer"));
        QVERIFY(pane.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-camera-focus.png")));
        CameraView viewer;
        connect(&pane, &ParticipantPane::fullscreenRequested, &viewer, &CameraView::openPeer);
        QTest::mouseDClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer"));
        QVERIFY(viewer.isVisible()); QVERIFY(viewer.isFullScreen()); QCOMPARE(viewer.peer(), QString("camera-peer"));
        auto* stage = viewer.findChild<VideoStageLabel*>("cameraStage"); QVERIFY(stage); QVERIFY(!stage->pixmap().isNull());
        stage->setZoomScale(2); QCOMPARE(stage->zoomScale(), 2.0);
        viewer.findChild<QPushButton*>("cameraResetZoom")->click(); QCOMPARE(stage->zoomScale(), 1.0);
        QImage changed(640,360,QImage::Format_RGB32); changed.fill(QColor(150,150,150));
        viewer.setFrame("unknown-peer", changed);
        QCOMPARE(stage->pixmap().toImage().pixelColor(stage->pixmap().width()/2, stage->pixmap().height()/2), QColor(80,100,120));
        viewer.setFrame("camera-peer", changed);
        QCOMPARE(stage->pixmap().toImage().pixelColor(stage->pixmap().width()/2, stage->pixmap().height()/2), QColor(150,150,150));
        viewer.removePeer("unknown-peer"); QVERIFY(viewer.isVisible());
        QTest::keyClick(&viewer, Qt::Key_Escape); QVERIFY(!viewer.isVisible()); QVERIFY(viewer.peer().isEmpty()); QVERIFY(stage->pixmap().isNull());
        QTest::keyClick(&pane, Qt::Key_Escape); QVERIFY(pane.focusedPeer().isEmpty());
        viewer.openPeer("camera-peer", "amigo", image); viewer.removePeer("camera-peer"); QVERIFY(!viewer.isVisible());
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer"));
        pane.removeFrame("camera-peer"); QVERIFY(pane.focusedPeer().isEmpty());
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer-2"));
        QCOMPARE(pane.focusedPeer(), QString("camera-peer-2"));
        QTest::mouseDClick(&pane, Qt::LeftButton, Qt::NoModifier, centerOf("camera-peer-2"));
        QCOMPARE(viewer.peer(), QString("camera-peer-2")); viewer.reject();
    }

    void participantAuthenticationMarkerShowsOnlyForUnauthenticatedGuests() {
        // The focused (stage) tile always shows its name pill regardless of
        // hover, which lets this measure the pill's painted width without
        // simulating mouse-hover state.
        auto pillWidth = [](bool authenticated) {
            ParticipantPane pane; pane.resize(600, 240);
            QJsonObject user{{"socketId", "peer"}, {"username", "mesma_pessoa"}, {"isMuted", false}, {"isDeafened", false}};
            user["authenticated"] = authenticated;
            pane.setParticipants(QJsonArray{user});
            pane.show();
            QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, pane.tileRect("peer").center());
            if (pane.focusedPeer() != QString("peer")) return -1;
            const auto image = pane.grab().toImage();
            const auto card = pane.tileRect("peer");
            // Pill top (margin 12, height 32) plus a couple of pixels: inside the pill's translucent
            // background but above the glyph ink, so text pixels do not break the background scan below.
            const int y = card.bottom() - 12 - 32 + 1 + 2;
            // Walk from the left edge while pixels stay part of the dark pill background.
            int w = 0;
            for (int x = card.left() + 12; x < card.right() - 12; ++x) {
                const auto c = image.pixelColor(x, y);
                if (c.red() < 40 && c.green() < 40 && c.blue() < 40) w = x - (card.left() + 12) + 1; else break;
            }
            return w;
        };
        const int widthVerified = pillWidth(true);
        const int widthUnverified = pillWidth(false);
        QVERIFY(widthVerified > 0);
        QVERIFY(widthUnverified > 0);
        // The unauthenticated marker (" · não verificado") appends visible width to the same pill.
        QVERIFY(widthUnverified > widthVerified);
    }
    void initTestCase() {
        loadBundledFonts();
        applyDarkTheme();
        QCoreApplication::setOrganizationName("Triscord"); QCoreApplication::setApplicationName("TriscordUiTests");
        QSettings settings; settings.clear(); settings.setValue("userId", "ui-test-owner");
    }
    void layoutAndIncrementalPresence() {
        QWebSocketServer server("UI fixture", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QWebSocket* remote = nullptr;
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            remote = server.nextPendingConnection();
            connect(remote, &QWebSocket::textMessageReceived, remote, [peer = remote](const QString& text) {
                if (text.startsWith("40")) peer->sendTextMessage("40{\"sid\":\"ui-self\"}");
            });
            remote->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        QSettings settings;
        settings.setValue("serverUrl", QString("http://127.0.0.1:%1").arg(server.serverPort()));
        settings.setValue("username", "UI test");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected);
        window.show();
        auto* columns = window.findChild<QSplitter*>("roomColumns"); QVERIFY(columns);
        columns->setSizes({260, 650, 240}); QCoreApplication::processEvents();
        QVERIFY(columns->sizes()[0] > 240);
        QVERIFY(!window.findChild<QPushButton*>("connectButton"));
        auto* leave = window.findChild<QPushButton*>("leaveCallButton");
        QVERIFY(leave->isHidden());
        auto* cameraButton = window.findChild<QPushButton*>("cameraButton"); QVERIFY(cameraButton); QVERIFY(!cameraButton->isEnabled());
        QTRY_VERIFY(remote != nullptr);
        QTRY_VERIFY(window.findChild<Signaling*>()->ready());
        auto send = [&](const QString& name, const QJsonObject& data) {
            remote->sendTextMessage("42" + QString::fromUtf8(QJsonDocument(QJsonArray{name, data}).toJson(QJsonDocument::Compact)));
        };
        QJsonArray users{QJsonObject{{"socketId", "ui-self"}, {"username", "UI test"}, {"isMuted", true}},
                         QJsonObject{{"socketId", "peer"}, {"username", "Amigo"}, {"avatar", "#687bbb"}, {"isMuted", true}}};
        auto directory = [&] {
            remote->sendTextMessage("42" + QString::fromUtf8(QJsonDocument(QJsonArray{"rooms-update", QJsonArray{QJsonObject{
                {"id", "ui-room"}, {"name", "Geral"}, {"userCount", 2}, {"ownerUserId", "ui-test-owner"}, {"users", users}}}}).toJson(QJsonDocument::Compact)));
        };
        directory(); auto* members = window.findChild<QListWidget*>("memberList");
        auto* rooms = window.findChild<QListWidget*>("roomList");
        QTRY_COMPARE(rooms->count(), 1);
        QString joinPacket;
        const auto joinCapture = connect(remote, &QWebSocket::textMessageReceived, this, [&](const QString& text) { joinPacket = text; });
        emit rooms->itemClicked(rooms->item(0));
        QTRY_VERIFY(joinPacket.contains("join-room"));
        disconnect(joinCapture);
        send("room-joined", {{"roomId", "ui-room"}, {"existingUsers", QJsonArray{}}, {"chatHistory", QJsonArray{}}});
        QTRY_COMPARE(members->count(), 2);
        { QEvent enter(QEvent::Enter); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &enter); }
        QVERIFY(!leave->isHidden()); auto* retained = members->item(1);
        auto* callCardsScroll = window.findChild<QScrollArea*>("callCardsScroll"); QVERIFY(callCardsScroll);
        window.resize(1280, 900); QCoreApplication::processEvents();
        QVERIFY(!window.findChild<QSplitter*>("callLayoutSplit")); // observed: participants and shared screens are one grid
        QVERIFY(callCardsScroll->height() > 360);
        QTRY_VERIFY(cameraButton->isEnabled());
        auto* shortcuts = window.findChild<CallShortcuts*>(); QVERIFY(shortcuts);
        auto* ptt = window.findChild<QCheckBox*>("pushToTalk");
        auto* mic = window.findChild<QPushButton*>("userMuteButton");
        emit window.findChild<VoiceService*>()->activeChanged(true);
        // Observed in Discord: the microphone starts active and stays usable across joins.
        QVERIFY(mic->isEnabled()); QVERIFY(!mic->isChecked()); ptt->setChecked(true);
        QList<bool> states;
        auto stateCapture = connect(remote, &QWebSocket::textMessageReceived, this, [&](const QString& packet) {
            if (!packet.startsWith("42[")) return;
            const auto event = QJsonDocument::fromJson(packet.mid(2).toUtf8()).array();
            if (event.first().toString() == "user-state-change" && event[1].toObject().contains("isMuted")) states.append(event[1].toObject().value("isMuted").toBool());
        });
        emit shortcuts->talkingChanged(true); QTRY_VERIFY(!states.isEmpty()); QCOMPARE(states.last(), false);
        emit shortcuts->muteRequested(); QTRY_COMPARE(states.last(), true); QVERIFY(mic->isChecked());
        emit shortcuts->talkingChanged(false); emit shortcuts->muteRequested();
        emit shortcuts->talkingChanged(true); QTRY_COMPARE(states.last(), false);
        emit shortcuts->talkingChanged(false); QTRY_COMPARE(states.last(), true);
        ptt->setChecked(false); emit shortcuts->muteRequested(); QTRY_COMPARE(states.size(), 6); QCOMPARE(states.last(), true);
        auto* delay = window.findChild<QSpinBox*>("pttReleaseDelay"); QVERIFY(delay); QVERIFY(!delay->isEnabled());
        ptt->setChecked(true); QVERIFY(delay->isEnabled()); delay->setValue(120);
        QCOMPARE(QSettings().value("pttReleaseDelay").toInt(), 120);
        emit shortcuts->muteRequested(); shortcuts->setTalkKeyPressed(true); QTRY_COMPARE(states.last(), false);
        shortcuts->setTalkKeyPressed(false); const auto beforeManualMute = states.size();
        emit shortcuts->muteRequested(); QTRY_COMPARE(states.size(), beforeManualMute + 1); QCOMPARE(states.last(), true);
        QTest::qWait(160); QCOMPARE(states.last(), true); QVERIFY(mic->isChecked());
        delay->setValue(0); ptt->setChecked(false);
        disconnect(stateCapture);
        send("force-muted", {{"muted", true}}); QTRY_VERIFY(!mic->isEnabled());
        emit shortcuts->talkingChanged(true); emit shortcuts->muteRequested(); QVERIFY(mic->isChecked());
        QString releasePacket;
        const auto releaseCapture = connect(remote, &QWebSocket::textMessageReceived, this, [&](const QString& packet) {
            if (packet.contains("force-mute-user")) releasePacket = packet;
        });
        QTimer::singleShot(20, this, [] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget()); if (!menu) return;
            for (auto* action : menu->actions()) if (action->text() == "Silenciar voz no servidor") {
                action->trigger(); menu->close(); return;
            }
            menu->close();
        });
        emit members->customContextMenuRequested(members->visualItemRect(members->item(0)).center());
        QTRY_VERIFY(releasePacket.contains("\"muted\":false")); disconnect(releaseCapture);
        send("force-muted", {{"muted", false}}); QTRY_VERIFY(mic->isEnabled()); QVERIFY(mic->isChecked());
        emit shortcuts->talkingChanged(false);
        auto* sounds = window.findChild<QPushButton*>("soundboardButton"); QVERIFY(sounds->isEnabled());
        sounds->click(); auto* board = window.findChild<Soundboard*>(); QVERIFY(board->isVisible());
        QCoreApplication::processEvents();
        // Observed popover (SOUNDBOARD.md): 532x522, left-aligned with the button, bottom 8px above it.
        QCOMPARE(board->size(), QSize(532, 522));
        QCOMPARE(board->geometry().left(), std::clamp(sounds->mapToGlobal(QPoint()).x(), window.geometry().left(), window.geometry().right() - 532));
        QCOMPARE(board->geometry().bottom() + 1 + 8, sounds->mapToGlobal(QPoint()).y());
        QCOMPARE(board->findChild<QLineEdit*>("soundboardSearchInput")->placeholderText(), QString("Encontre o som perfeito"));
        QCOMPARE(board->findChild<QFrame*>("soundboardSearch")->height(), 40);
        QVERIFY(!board->findChild<QSlider*>()); QVERIFY(!board->findChild<QPushButton*>("soundboardStop"));
        const auto clips = board->findChildren<SoundCardWidget*>(); QCOMPARE(clips.size(), 32);
        QCOMPARE(clips[0]->size(), QSize(148, 40)); QCOMPARE(clips[1]->x() - clips[0]->x(), 156); QCOMPARE(clips[3]->y() - clips[0]->y(), 48);
        const QPoint firstTile = clips[0]->pos();
        board->findChild<QLineEdit*>("soundboardSearchInput")->setText(clips[5]->name()); QCoreApplication::processEvents();
        QVERIFY(clips[5]->isVisible()); QVERIFY(!clips[0]->isVisible() || clips[0]->name().contains(clips[5]->name(), Qt::CaseInsensitive));
        QTRY_COMPARE(clips[5]->pos(), firstTile);
        board->findChild<QLineEdit*>("soundboardSearchInput")->clear();
        auto* sectionHeader = board->findChild<SoundboardSectionHeader*>("soundboardSectionHeader"); QVERIFY(sectionHeader);
        QTest::mouseClick(sectionHeader, Qt::LeftButton); QVERIFY(!clips[0]->isVisible());
        QTest::mouseClick(sectionHeader, Qt::LeftButton); QVERIFY(clips[0]->isVisible());
        QVERIFY(board->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-soundboard.png")));
        QString soundPacket;
        const auto soundCapture = connect(remote, &QWebSocket::textMessageReceived, this, [&](const QString& packet) { soundPacket = packet; });
        emit clips[0]->clicked(clips[0]->id()); QTRY_VERIFY(soundPacket.contains("soundboard-play"));
        disconnect(soundCapture); board->hide();
        auto* cards = window.findChild<ParticipantPane*>("participantCards");
        QVERIFY(cards); QVERIFY(cards->isVisible());
        auto* roomItem = rooms->item(0);
        auto user = users[1].toObject(); user["isMuted"] = false; users[1] = user; directory();
        QTRY_VERIFY(members->item(1)->text().contains("na chamada")); QCOMPARE(members->item(1), retained); QCOMPARE(rooms->item(0), roomItem);
        QVERIFY(!members->item(1)->icon().isNull());
        bool panAvailable = false, streamControls = false;
        QTimer::singleShot(20, this, [&] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget()); if (!menu) return;
            menu->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-user-menu.png"));
            auto* pan = menu->findChild<QSlider*>("peerAudioPan");
            panAvailable = pan && pan->minimum() == -100 && pan->maximum() == 100;
            if (pan) pan->setValue(-75);
            if (auto* volume = menu->findChild<QSlider*>("streamAudioVolume")) {
                streamControls = volume->minimum() == 0 && volume->maximum() == 200; volume->setValue(35);
            }
            for (auto* action : menu->actions()) if (action->text() == "Silenciar transmissão") { action->trigger(); break; }
            menu->close();
        });
        emit members->customContextMenuRequested(members->visualItemRect(members->item(1)).center());
        QTRY_VERIFY(panAvailable); QVERIFY(streamControls);
        int retainedPan = 0, retainedStreamVolume = 0; bool retainedStreamMute = false;
        QTimer::singleShot(20, this, [&] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget()); if (!menu) return;
            if (auto* pan = menu->findChild<QSlider*>("peerAudioPan")) retainedPan = pan->value();
            if (auto* volume = menu->findChild<QSlider*>("streamAudioVolume")) retainedStreamVolume = volume->value();
            for (auto* action : menu->actions()) if (action->text() == "Silenciar transmissão") retainedStreamMute = action->isChecked();
            menu->close();
        });
        emit members->customContextMenuRequested(members->visualItemRect(members->item(1)).center());
        QTRY_COMPARE(retainedPan, -75);
        QCOMPARE(retainedStreamVolume, 35); QVERIFY(retainedStreamMute);
        auto* session = window.findChild<ShareSession*>(); QVERIFY(session);
        auto* tiles = window.findChild<ParticipantPane*>("participantCards"); QVERIFY(tiles);
        auto* media = window.findChild<ScreenService*>();
        // Observed (SHARE.md): a shared screen is a tile of the call grid, next to the participants, with the
        // red "AO VIVO" badge; its picture keeps the source aspect ratio.
        QSignalSpy streamFrames(session, &ShareSession::streamFrame);
        emit media->streamsChanged(QJsonArray{QJsonObject{{"id", "peer"}, {"name", "Amigo"}}});
        QImage image(320, 180, QImage::Format_RGB32); image.fill(QColor("#26344b")); emit media->frameReady("peer", image);
        QCoreApplication::processEvents();
        QCOMPARE(streamFrames.size(), 1);
        QVERIFY(!tiles->tileRect(ParticipantPane::streamKey("peer")).isNull());
        { const QImage grabbed = tiles->grab().toImage(); int live = 0;
          const QRect box = tiles->tileRect(ParticipantPane::streamKey("peer"));
          for (int y = box.top(); y < box.top() + 30; ++y) for (int x = box.right() - 80; x <= box.right(); ++x) if (grabbed.pixelColor(x, y) == QColor("#d22d39")) ++live;
          QVERIFY(live > 150); }
        // Turning a peer's video off drops its frames until it is turned on again.
        session->setPeerVideoDisabled("peer", true); emit media->frameReady("peer", image); QCOMPARE(streamFrames.size(), 1);
        session->setPeerVideoDisabled("peer", false); emit media->frameReady("peer", image); QCOMPARE(streamFrames.size(), 2);
        emit media->streamsChanged({});
        QVERIFY(tiles->tileRect(ParticipantPane::streamKey("peer")).isNull());
        emit media->sharingChanged(true); emit media->frameReady("$local", image); QCoreApplication::processEvents();
        QVERIFY(!tiles->tileRect(ParticipantPane::streamKey("$local")).isNull());
        emit media->streamsChanged(QJsonArray{
            QJsonObject{{"id", "peer1"}, {"name", "Amigo 1"}},
            QJsonObject{{"id", "peer2"}, {"name", "Amigo 2"}}
        });
        QImage wide(640, 336, QImage::Format_RGB32); wide.fill(QColor(150, 50, 50));
        emit media->frameReady("peer1", wide); emit media->frameReady("peer2", image); emit media->frameReady("$local", image);
        QCoreApplication::processEvents();
        // Clicking a stream opens the focused view: stage across the width, filmstrip tiles of 195x112, and the
        // header gets "Tela de <nome>" with the quality and live pills.
        const QString focusKey = ParticipantPane::streamKey("peer1");
        QTest::mouseClick(tiles, Qt::LeftButton, Qt::NoModifier, tiles->tileRect(focusKey).center());
        QCOMPARE(tiles->focusedPeer(), focusKey);
        QCOMPARE(tiles->tileRect(focusKey).width(), tiles->width());
        QCOMPARE(tiles->tileRect(ParticipantPane::streamKey("peer2")).size(), QSize(195, 112));
        QVERIFY(!tiles->filmstripToggleRect().isNull());
        QCOMPARE(window.findChild<QLabel*>("channelHeaderFocusTitle")->text(), QString("Tela de Amigo 1"));
        QVERIFY(!window.findChild<QLabel*>("channelHeaderFocusTitle")->isHidden());
        QCOMPARE(window.findChild<QLabel*>("headerQualityPill")->text(), QString("336p"));
        QVERIFY(!window.findChild<QLabel*>("headerLivePill")->isHidden());
        QVERIFY(tiles->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-dual-stream-layout.png")));
        // The toggle collapses the filmstrip: the stage area gets the 119px back, so the centred stage moves down by
        // half of it (Discord: stage top 170 -> 230), and only the user's own tile is kept, as a preview.
        const int expandedTop = tiles->tileRect(focusKey).top();
        QTest::mouseClick(tiles, Qt::LeftButton, Qt::NoModifier, tiles->filmstripToggleRect().center());
        QCOMPARE(tiles->tileRect(focusKey).top(), expandedTop + 59);
        QTest::mouseClick(tiles, Qt::LeftButton, Qt::NoModifier, tiles->filmstripToggleRect().center());
        QCOMPARE(tiles->tileRect(focusKey).top(), expandedTop);
        // Double click opens the enlarged viewer (zoom and pan) with the stream's frames; Esc closes it.
        QTest::mouseDClick(tiles, Qt::LeftButton, Qt::NoModifier, tiles->tileRect(focusKey).center());
        auto* viewer = window.findChild<CameraView*>(); QVERIFY(viewer); QVERIFY(viewer->isVisible()); QCOMPARE(viewer->peer(), focusKey);
        QTest::keyClick(viewer, Qt::Key_Escape); QVERIFY(!viewer->isVisible());
        QTest::keyClick(tiles, Qt::Key_Escape);
        QVERIFY(tiles->focusedPeer().isEmpty()); QVERIFY(window.findChild<QLabel*>("channelHeaderFocusTitle")->isHidden());
        emit media->streamsChanged({});
        emit media->sharingChanged(false);
        session->chooseSource(); QCoreApplication::processEvents();

        QSignalSpy sourcePreviews(media, &ScreenService::thumbnailReady);
        QTRY_VERIFY_WITH_TIMEOUT(sourcePreviews.count() > 0, 4000);
        auto* picker = window.findChild<QDialog*>("shareSourceDialog");
        // Observed picker (SHARE.md): a modal over the window with segmented tabs, 439x247 tiles and the
        // stream mode block; choosing a source starts the stream, so there is no confirm button.
        auto* sharePicker = qobject_cast<SharePicker*>(picker); QVERIFY(sharePicker); QVERIFY(picker->isVisible());
        QCOMPARE(picker->windowTitle(), QString("Compartilhar Tela"));
        QCOMPARE(picker->findChild<QPushButton*>("shareTabWindows")->text(), QString("Aplicativos"));
        QCOMPARE(picker->findChild<QPushButton*>("shareTabMonitors")->text(), QString("Tela Inteira"));
        QCOMPARE(picker->findChild<QWidget*>("shareSourceTabs")->height(), 40);
        // The panel is 960x746 when the window allows it and shrinks inside smaller windows.
        { const auto panelSize = picker->findChild<QWidget*>("sharePickerPanel")->size(); QVERIFY(panelSize.width() <= 960 && panelSize.height() <= 746 && panelSize.width() <= picker->width() && panelSize.height() <= picker->height()); }
        QVERIFY(!picker->findChild<QPushButton*>("btnShareConfirm"));
        QCOMPARE(picker->findChild<QLabel*>("shareModeTitle")->text(), QString("Jogos"));
        QCOMPARE(sharePicker->config().size.height(), 720); QCOMPARE(sharePicker->config().fps, 30);
        picker->findChild<QPushButton*>("shareQualityHd")->click();
        QCOMPARE(sharePicker->config().size.height(), 1080); QCOMPARE(sharePicker->config().fps, 60);
        picker->findChild<QPushButton*>("shareQualitySd")->click();
        auto* windowSources = picker->findChild<QListWidget*>("shareWindows");
        auto* monitorSources = picker->findChild<QListWidget*>("shareMonitors");
        const auto sources = captureSources();
        for (auto* list : {windowSources, monitorSources}) {
            for (int n = 0; n < list->count(); ++n) {
                const int sourceIndex = list->item(n)->data(Qt::UserRole).toInt();
                QVERIFY(sourceIndex >= 0 && sourceIndex < sources.size());
                QCOMPARE(sources[sourceIndex].kind, list == monitorSources ? CaptureSource::Kind::Monitor : CaptureSource::Kind::Window);
            }
        }
        QVERIFY(picker->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-share-picker.png")));
        // Same-size capture for the Discord comparison (SHARE.md): 1264x892 window, one tile hovered.
        window.resize(1264, 892); QCoreApplication::processEvents(); picker->setGeometry(window.rect()); QCoreApplication::processEvents();
        QCOMPARE(picker->findChild<QWidget*>("sharePickerPanel")->size(), QSize(960, 746));
        QCOMPARE(picker->findChild<QWidget*>("shareSourceTabs")->width(), 910);
        { auto* list = picker->findChild<QListWidget*>("shareWindows"); if (list->count() > 0) { const QPoint at = list->visualItemRect(list->item(0)).topLeft() + QPoint(200, 120);
          QMouseEvent move(QEvent::MouseMove, QPointF(at), list->viewport()->mapToGlobal(QPointF(at)), Qt::NoButton, Qt::NoButton, Qt::NoModifier); QCoreApplication::sendEvent(list->viewport(), &move); } }
        QCoreApplication::processEvents();
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-share-picker-client.png")));
        picker->reject();

        auto* createRoomBtn = window.findChild<QPushButton*>("createRoomButton");
        QVERIFY(createRoomBtn);
        QCOMPARE(createRoomBtn->text(), QString());
        QVERIFY(!createRoomBtn->icon().isNull());
        QCOMPARE(createRoomBtn->toolTip(), QString("Criar canal"));
        QVERIFY(createRoomBtn->isEnabled());

        // Observed composer: no send or attachment buttons (Enter sends; attachments have no triscord function).
        QVERIFY(!window.findChild<QPushButton*>("chatAttachButton"));
        QVERIFY(!window.findChild<QPushButton*>("chatSendButton"));
        auto* composeContainer = window.findChild<QWidget*>("channelTextArea");
        QVERIFY(composeContainer);
        QVERIFY(composeContainer->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-composer.png")));

        auto* userSettingsBtn = window.findChild<QPushButton*>("userSettingsButton");
        QVERIFY(userSettingsBtn);
        QVERIFY(!userSettingsBtn->icon().isNull());
        QCOMPARE(userSettingsBtn->text(), QString());

        auto* userMuteBtn = window.findChild<QPushButton*>("userMuteButton");
        QVERIFY(userMuteBtn);
        QVERIFY(userMuteBtn->isCheckable());
        QVERIFY(!userMuteBtn->icon().isNull());
        QCOMPARE(userMuteBtn->text(), QString());

        auto* userDeafenBtn = window.findChild<QPushButton*>("userDeafenButton");
        QVERIFY(userDeafenBtn);
        QVERIFY(userDeafenBtn->isCheckable());
        QVERIFY(!userDeafenBtn->icon().isNull());
        QCOMPARE(userDeafenBtn->text(), QString());

        auto* voiceBarDisconnectBtn = window.findChild<QPushButton*>("voiceBarDisconnect");
        QVERIFY(voiceBarDisconnectBtn);
        QVERIFY(!voiceBarDisconnectBtn->icon().isNull());
        QCOMPARE(voiceBarDisconnectBtn->text(), QString());

        auto* userNameLabel = window.findChild<QLabel*>("userNameLabel");
        QVERIFY(userNameLabel);

        auto* userTagLabel = window.findChild<QLabel*>("userTagLabel");
        QVERIFY(userTagLabel);

        send("new-chat-message", {{"id", "message"}, {"senderName", "Amigo"}, {"text", "Olá"}});
        auto* chat = window.findChild<ChatPane*>("chatList"); QTRY_COMPARE(chat->count(), 1);
        QVERIFY(chat->item(0)->text().startsWith("Amigo:"));
        QVERIFY(chat->item(0)->data(Qt::AccessibleTextRole).toString().contains("Amigo"));
        send("message-reaction-updated", {{"roomId", "ui-room"}, {"messageId", "message"}, {"reactions", QJsonObject{{"👍", QJsonArray{"ui-test-owner"}}}}});
        QTRY_VERIFY(chat->item(0)->text().contains("👍"));
        send("new-chat-message", {{"id", "mine"}, {"senderUserId", "ui-test-owner"}, {"senderName", "UI test"}, {"text", "remover"}});
        QTRY_COMPARE(chat->count(), 2);
        QVERIFY(chat->item(1)->text().startsWith("UI test:"));
        QSignalSpy deletion(chat, &ChatPane::deleteRequested);
        QTimer::singleShot(20, this, [] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget());
            if (!menu) return;
            for (auto* action : menu->actions()) if (action->text().compare("excluir mensagem", Qt::CaseInsensitive) == 0) { action->trigger(); menu->close(); return; }
            menu->close();
        });
        emit chat->customContextMenuRequested(chat->visualItemRect(chat->item(1)).center());
        QCOMPARE(deletion.count(), 1); QCOMPARE(deletion.first().first().toString(), QString("mine"));
        send("chat-message-deleted", {{"roomId", "ui-room"}, {"messageId", "mine"}}); QTRY_COMPARE(chat->count(), 1);
        emit media->streamsChanged(QJsonArray{QJsonObject{{"id", "peer"}, {"name", "Amigo"}}});
        QCoreApplication::processEvents();
        image.fill(QColor("#202020"));
        QPainter picture(&image); picture.setPen(QColor("#eeeeee")); picture.drawText(image.rect(), Qt::AlignCenter, "transmissão de teste"); picture.end();
        emit media->frameReady("peer", image);
        emit window.findChild<VoiceService*>()->speakingChanged("peer", true);
        const auto activeCard = cards->grab().toImage();
        bool speakingBorder = false;
        const auto speakingTile = cards->tileRect("peer");
        for (int x = speakingTile.left() + 12; x < speakingTile.right() - 12; ++x) {
            const auto color = activeCard.pixelColor(x, speakingTile.top() + 1);
            if ((color.green() >= 140 && color.green() > color.red() + 40) || qGray(color.rgb()) > 240) { speakingBorder = true; break; }
        }
        QVERIFY(speakingBorder);
        QVERIFY(cards->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-calls-grid.png")));

        window.resize(860, 760); QCoreApplication::processEvents();
        auto* callControlsDock = window.findChild<QWidget*>("callControlsDock");
        QVERIFY(callControlsDock);
        QVERIFY(callControlsDock->isVisible());
        auto* cameraBtn = window.findChild<QPushButton*>("cameraButton"); QVERIFY(cameraBtn);
        auto* shareBtn = window.findChild<QPushButton*>("shareScreenButton"); QVERIFY(shareBtn);
        auto* soundsBtn = window.findChild<QPushButton*>("soundboardButton"); QVERIFY(soundsBtn);
        { QEvent enter(QEvent::Enter); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &enter); }
        auto* leaveBtn = window.findChild<QPushButton*>("leaveCallButton"); QVERIFY(leaveBtn); QVERIFY(leaveBtn->isVisible());
        QVERIFY(callControlsDock->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-calls-controls.png")));
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-narrow.png")));
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-navigation-narrow.png")));
        send("new-chat-message", {{"id","rich-preview"},{"senderName","amigo"},{"text","**vamos jogar?** ||spoiler|| e [link](https://example.org)"},
            {"timestamp",static_cast<double>(QDateTime::currentMSecsSinceEpoch())}});
        QTRY_COMPARE(chat->count(),2);
        window.resize(1280, 900); QCoreApplication::processEvents();
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-redesign-call.png")));
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-navigation-call.png")));
        auto* settingsDialog = window.findChild<QDialog*>("audioSettingsDialog");
        userSettingsBtn->click(); QCoreApplication::processEvents();
        QVERIFY(settingsDialog->isVisible());
        window.resize(1264, 892); QCoreApplication::processEvents(); // size of the observed Discord client area
        QVERIFY(settingsDialog->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-settings.png")));
        // Observed settings modal (SETTINGS.md): drawn inside the window, panel 40px from the edges.
        QCOMPARE(settingsDialog->geometry(), window.rect());
        auto* settingsPanel = settingsDialog->findChild<QWidget*>("settingsPanel"); QVERIFY(settingsPanel);
        QCOMPARE(settingsPanel->geometry(), window.rect().adjusted(40, 40, -40, -40));
        QCOMPARE(settingsDialog->findChild<QWidget*>("settingsSidebar")->width(), 252);
        QCOMPARE(settingsDialog->findChild<QWidget*>("settingsContentHeader")->height(), 49);
        auto* settingsNav = settingsDialog->findChild<QListWidget*>("settingsNav");
        QVERIFY(settingsNav);
        QStringList navTexts; for (int i = 0; i < settingsNav->count(); ++i) navTexts << settingsNav->item(i)->text();
        QCOMPARE(navTexts, (QStringList{"Notificações", "Experiência", "Voz e vídeo", "Voz", "Vídeo", "Painel de efeitos sonoros"}));
        QVERIFY(!settingsDialog->findChild<QPushButton*>("btnSettingsDone")->icon().isNull());
        auto* globalMuteCheck = settingsDialog->findChild<QCheckBox*>("globalMuteShortcut");
        QVERIFY(globalMuteCheck && globalMuteCheck->isVisible());
        QCOMPARE(settingsDialog->findChild<QCheckBox*>("pushToTalk")->size(), QSize(48, 24));
        emit settingsNav->itemClicked(settingsNav->item(0)); QCoreApplication::processEvents();
        auto* desktopNotif = settingsDialog->findChild<QCheckBox*>("desktopNotifications");
        QVERIFY(desktopNotif && desktopNotif->isVisible());
        QCOMPARE(settingsDialog->findChild<QLabel*>("settingsContentTitle")->text(), QString("Notificações"));
        emit settingsNav->itemClicked(settingsNav->item(5)); QCoreApplication::processEvents();
        QVERIFY(settingsDialog->findChild<QSlider*>("settingsSoundboardVolume")->isVisible());
        QVERIFY(settingsNav->item(5)->data(SettingsNavDelegate::ActiveRole).toBool());
        settingsDialog->findChild<QPushButton*>("btnSettingsDone")->click();
        QVERIFY(!settingsDialog->isVisible());
        emit media->streamsChanged({});
        QString leavePacket;
        connect(remote, &QWebSocket::textMessageReceived, this, [&](const QString& text) { leavePacket = text; });
        leave->click(); QTRY_VERIFY(leavePacket.contains("leave-room"));
        QCOMPARE(members->count(), 0); QCOMPARE(chat->count(), 0);
        QVERIFY(!cards->isVisible());
        QVERIFY(leave->isHidden()); QVERIFY(window.findChild<Signaling*>()->ready());
        QVERIFY(!sounds->isEnabled()); QVERIFY(!board->isVisible());
        send("room-joined", {{"roomId", "ui-room"}, {"existingUsers", QJsonArray{}}, {"chatHistory", QJsonArray{}}});
        QTRY_COMPARE(members->count(), 2);
        int freshVolume = 0; bool freshMute = true;
        QTimer::singleShot(20, this, [&] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget()); if (!menu) return;
            if (auto* volume = menu->findChild<QSlider*>("streamAudioVolume")) freshVolume = volume->value();
            for (auto* action : menu->actions()) if (action->text() == "Silenciar transmissão") freshMute = action->isChecked();
            menu->close();
        });
        emit members->customContextMenuRequested(members->visualItemRect(members->item(1)).center());
        QTRY_COMPARE(freshVolume, 100); QVERIFY(!freshMute); leave->click();
        remote->close(); remote->deleteLater();
    }
    void discordMenuSampleForPixelComparison() {
        // Same rows as the observed Discord right-click menu head (reference/discord-menu-4-rightclick.png).
        auto* menu = createDiscordMenu(nullptr);
        addDiscordMenuRow(menu, "Perfil");
        menu->addSeparator();
        addDiscordMenuRow(menu, "Silenciar", std::nullopt, DiscordMenuTrailing::Checkbox, true);
        addDiscordMenuRow(menu, "Desativar áudio", std::nullopt, DiscordMenuTrailing::Checkbox, true);
        menu->ensurePolished(); menu->resize(menu->sizeHint());
        QVERIFY(menu->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-discord-menu-sample.png")));
        QVERIFY(menu->width() >= 204);
        delete menu;
        // Full observed row list (geometry only; the rows without a triscord function exist here just for measuring).
        auto* full = createDiscordMenu(nullptr);
        using T = DiscordMenuTrailing;
        addDiscordMenuRow(full, "Perfil"); full->addSeparator();
        addDiscordMenuRow(full, "Silenciar", std::nullopt, T::Checkbox, true);
        addDiscordMenuRow(full, "Desativar áudio", std::nullopt, T::Checkbox, true);
        addDiscordMenuRow(full, "Prévia da câmera", DiscordIcons::IconType::Settings);
        addDiscordMenuRow(full, "Editar perfil por servidor");
        addDiscordMenuRow(full, "Apps", std::nullopt, T::Chevron); full->addSeparator();
        addDiscordMenuRow(full, "Cargo", std::nullopt, T::Chevron); full->addSeparator();
        addDiscordMenuRow(full, "Usuário em Nova Janela", DiscordIcons::IconType::Settings);
        addDiscordMenuRow(full, "Mostrar participantes sem vídeo", std::nullopt, T::Checkbox, true);
        addDiscordMenuRow(full, "Mostrar Minha Própria Câmera", std::nullopt, T::Checkbox, true); full->addSeparator();
        addDiscordMenuRow(full, "Abrir na visualização de moderador");
        addDiscordMenuRow(full, "Silenciar voz no servidor", std::nullopt, T::Checkbox, false, true);
        addDiscordMenuRow(full, "Desativar áudio no servidor", std::nullopt, T::Checkbox, false, true);
        full->ensurePolished(); full->resize(full->sizeHint());
        qInfo() << "full menu size" << full->size();
        QVERIFY(full->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-discord-menu-full.png")));
        delete full;
    }
    void reconnectRejoinsTheRoomAfterASignalingDrop() {
        // Observed in Discord: after a drop the user is told to hold on and is put back in the call.
        QWebSocketServer server("UI reconnect fixture", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QList<QWebSocket*> sockets; QStringList received;
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            auto* peer = server.nextPendingConnection(); sockets << peer;
            connect(peer, &QWebSocket::textMessageReceived, peer, [peer, &received](const QString& text) {
                if (text.startsWith("40")) peer->sendTextMessage("40{\"sid\":\"ui-self\"}"); else received << text;
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        QSettings settings; settings.setValue("serverUrl", QString("http://127.0.0.1:%1").arg(server.serverPort())); settings.setValue("username", "UI test");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected); window.show();
        auto* signaling = window.findChild<Signaling*>();
        QTRY_VERIFY(signaling->ready());
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}}}})));
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "room-joined"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonObject{{"roomId", "r1"}, {"chatHistory", QJsonArray{}}}})));
        QVERIFY(!window.findChild<QWidget*>("callStage")->isHidden());
        received.clear();
        sockets.last()->close();
        QTRY_VERIFY(!signaling->ready());
        QVERIFY(window.findChild<QLabel*>("connectionStatus")->text().contains("vamos te jogar de volta"));
        // The client reconnects with its own backoff and then joins the same room again.
        QTRY_VERIFY_WITH_TIMEOUT(signaling->ready(), 8000);
        QTRY_VERIFY_WITH_TIMEOUT(std::any_of(received.cbegin(), received.cend(), [](const QString& text) { return text.contains("join-room") && text.contains("\"roomId\":\"r1\""); }), 4000);
        // Leaving on purpose must not rejoin after the next drop.
        QMetaObject::invokeMethod(&window, "leaveRoom"); received.clear(); sockets.last()->close();
        QTRY_VERIFY(!signaling->ready()); QTRY_VERIFY_WITH_TIMEOUT(signaling->ready(), 8000); QTest::qWait(300);
        QVERIFY(!std::any_of(received.cbegin(), received.cend(), [](const QString& text) { return text.contains("join-room"); }));
    }
    void reconnectResumesScreenShareAfterASignalingDrop() {
        // Mirrors reconnectRejoinsTheRoomAfterASignalingDrop, but for the screen share instead of the camera
        // (desktop/LIMITES_E_ESTADO.md: an involuntary drop must resume the share, same as it already resumes the camera).
        // Unlike that test, room-joined has to travel over the real socket (not a direct receiveEvent() call):
        // ScreenService learns its room from the signaling socket itself, not from MainWindow.
        QWebSocketServer server("UI share-reconnect fixture", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QList<QWebSocket*> sockets; QStringList received;
        auto sendOn = [](QWebSocket* sock, const QString& name, const QJsonObject& data) {
            sock->sendTextMessage("42" + QString::fromUtf8(QJsonDocument(QJsonArray{name, data}).toJson(QJsonDocument::Compact)));
        };
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            auto* peer = server.nextPendingConnection(); sockets << peer;
            connect(peer, &QWebSocket::textMessageReceived, peer, [peer, &received, &sendOn](const QString& text) {
                if (text.startsWith("40")) { peer->sendTextMessage("40{\"sid\":\"ui-self\"}"); return; }
                received << text;
                if (text.contains("join-room")) sendOn(peer, "room-joined", {{"roomId", "r1"}, {"chatHistory", QJsonArray{}}});
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        QSettings settings; settings.setValue("serverUrl", QString("http://127.0.0.1:%1").arg(server.serverPort())); settings.setValue("username", "UI test");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected); window.show();
        auto* signaling = window.findChild<Signaling*>();
        QTRY_VERIFY(signaling->ready());
        auto* rooms = window.findChild<QListWidget*>("roomList");
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}}}})));
        QTRY_COMPARE(rooms->count(), 1);
        emit rooms->itemClicked(rooms->item(0));
        QTRY_VERIFY(!window.findChild<QWidget*>("callStage")->isHidden());
        // ScreenCall learns the room asynchronously (its own thread processing the real room-joined event);
        // the share button only enables once that has happened, same signal the picker's start uses internally.
        QTRY_VERIFY(window.findChild<QPushButton*>("shareScreenButton")->isEnabled());
        auto* session = window.findChild<ShareSession*>(); QVERIFY(session);
        session->chooseSource(); QCoreApplication::processEvents();
        auto* picker = window.findChild<QDialog*>("shareSourceDialog"); QVERIFY(picker);
        auto* monitors = picker->findChild<QListWidget*>("shareMonitors"); QVERIFY(monitors);
        if (monitors->count() == 0) QSKIP("no monitor source available to share on this machine");
        emit monitors->itemClicked(monitors->item(0)); QCoreApplication::processEvents();
        QTRY_VERIFY(session->isSharing());
        const auto sharedSource = session->sharedSource();
        received.clear();
        // The drop stops the share, same as it stops the camera; the client remembers it was sharing.
        sockets.last()->close();
        QTRY_VERIFY(!signaling->ready());
        QTRY_VERIFY(!session->isSharing());
        QTRY_VERIFY_WITH_TIMEOUT(signaling->ready(), 8000);
        QTRY_VERIFY_WITH_TIMEOUT(std::any_of(received.cbegin(), received.cend(), [](const QString& text) { return text.contains("join-room") && text.contains("\"roomId\":\"r1\""); }), 4000);
        // Automatic rejoin resumes the same source without the user picking it again.
        QTRY_VERIFY_WITH_TIMEOUT(session->isSharing(), 4000);
        QCOMPARE(session->sharedSource().kind, sharedSource.kind);
        QCOMPARE(session->sharedSource().handle, sharedSource.handle);
        session->resumeShare(sharedSource, false, session->sharedConfig()); // idempotent: no crash if invoked again
        window.findChild<ScreenService*>()->stop();
    }
    void reconnectDoesNotResumeAScreenShareStoppedBeforeTheDrop() {
        // Deliberately stopping the share must behave like deliberately leaving the room: no resumption later.
        QWebSocketServer server("UI share-no-resume fixture", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        QList<QWebSocket*> sockets;
        auto sendOn = [](QWebSocket* sock, const QString& name, const QJsonObject& data) {
            sock->sendTextMessage("42" + QString::fromUtf8(QJsonDocument(QJsonArray{name, data}).toJson(QJsonDocument::Compact)));
        };
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            auto* peer = server.nextPendingConnection(); sockets << peer;
            connect(peer, &QWebSocket::textMessageReceived, peer, [peer, &sendOn](const QString& text) {
                if (text.startsWith("40")) { peer->sendTextMessage("40{\"sid\":\"ui-self\"}"); return; }
                if (text.contains("join-room")) sendOn(peer, "room-joined", {{"roomId", "r1"}, {"chatHistory", QJsonArray{}}});
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        QSettings settings; settings.setValue("serverUrl", QString("http://127.0.0.1:%1").arg(server.serverPort())); settings.setValue("username", "UI test");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected); window.show();
        auto* signaling = window.findChild<Signaling*>();
        QTRY_VERIFY(signaling->ready());
        auto* rooms = window.findChild<QListWidget*>("roomList");
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}}}})));
        QTRY_COMPARE(rooms->count(), 1);
        emit rooms->itemClicked(rooms->item(0));
        QTRY_VERIFY(!window.findChild<QWidget*>("callStage")->isHidden());
        QTRY_VERIFY(window.findChild<QPushButton*>("shareScreenButton")->isEnabled());
        auto* session = window.findChild<ShareSession*>(); QVERIFY(session);
        session->chooseSource(); QCoreApplication::processEvents();
        auto* picker = window.findChild<QDialog*>("shareSourceDialog"); QVERIFY(picker);
        auto* monitors = picker->findChild<QListWidget*>("shareMonitors"); QVERIFY(monitors);
        if (monitors->count() == 0) QSKIP("no monitor source available to share on this machine");
        emit monitors->itemClicked(monitors->item(0)); QCoreApplication::processEvents();
        QTRY_VERIFY(session->isSharing());
        window.findChild<ScreenService*>()->stop();
        QTRY_VERIFY(!session->isSharing());
        sockets.last()->close();
        QTRY_VERIFY(!signaling->ready());
        QTRY_VERIFY_WITH_TIMEOUT(signaling->ready(), 8000);
        QTest::qWait(1200); // past the 800ms the camera/share resume timer would use
        QVERIFY(!session->isSharing());
    }
    void resumeShareIgnoresASourceThatNoLongerExists() {
        // A vanished window/monitor (closed or unplugged) must not crash and must not silently share something else.
        QWebSocketServer server("UI share-vanished fixture", QWebSocketServer::NonSecureMode);
        QVERIFY(server.listen(QHostAddress::LocalHost, 0));
        connect(&server, &QWebSocketServer::newConnection, this, [&] {
            auto* peer = server.nextPendingConnection();
            connect(peer, &QWebSocket::textMessageReceived, peer, [peer](const QString& text) {
                if (text.startsWith("40")) peer->sendTextMessage("40{\"sid\":\"ui-self\"}");
            });
            peer->sendTextMessage("0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}");
        });
        QSettings settings; settings.setValue("serverUrl", QString("http://127.0.0.1:%1").arg(server.serverPort())); settings.setValue("username", "UI test");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected); window.show();
        auto* signaling = window.findChild<Signaling*>();
        QTRY_VERIFY(signaling->ready());
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}}}})));
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "room-joined"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonObject{{"roomId", "r1"}, {"chatHistory", QJsonArray{}}}})));
        auto* session = window.findChild<ShareSession*>(); QVERIFY(session);
        CaptureSource ghost; ghost.kind = CaptureSource::Kind::Window; ghost.handle = 0x7fffffff; ghost.name = "a window that was already closed";
        QVERIFY(!session->resumeShare(ghost, false, {})); // no match in captureSources(): resumeShare refuses, no crash
        QVERIFY(!session->isSharing());
    }
    void migratedSoundsDecode() {
        Soundboard board;
        QFile manifest(":/soundboard/catalog.json"); QVERIFY(manifest.open(QIODevice::ReadOnly));
        const auto catalog = QJsonDocument::fromJson(manifest.readAll()).array(); QCOMPARE(catalog.size(), 32);
        QTemporaryDir cache; QVERIFY(cache.isValid());
        for (const auto& value : catalog) {
            const auto id = value.toObject().value("id").toString();
            QFile clip(":/soundboard/" + id + ".mp3"); QVERIFY(clip.open(QIODevice::ReadOnly));
            const auto data = clip.readAll(); QVERIFY(data.size() > 0 && data.size() <= 1048576);
            QCOMPARE(QCryptographicHash::hash(data, QCryptographicHash::Sha256).toHex(), id.toLatin1());
            const auto audio = soundboardAudio(data);
            QFile file(cache.filePath(id + ".mp3")); QVERIFY(file.open(QIODevice::WriteOnly)); QCOMPARE(file.write(audio), audio.size()); file.close();
            // Qt 6.8 keeps an output back-reference; destroy it while its player is alive.
            qint64 samples = 0; QMediaPlayer decoder; QAudioBufferOutput output;
            decoder.setAudioBufferOutput(&output); decoder.setPlaybackRate(8);
            connect(&output, &QAudioBufferOutput::audioBufferReceived, &output, [&](const QAudioBuffer& buffer) { samples += buffer.sampleCount(); });
            decoder.setSource(QUrl::fromLocalFile(file.fileName()));
            QTRY_VERIFY_WITH_TIMEOUT(decoder.mediaStatus() == QMediaPlayer::LoadedMedia || decoder.error() != QMediaPlayer::NoError, 5000);
            decoder.setActiveVideoTrack(-1); decoder.play();
            QTRY_VERIFY2_WITH_TIMEOUT(samples > 0 || decoder.error() != QMediaPlayer::NoError, qPrintable(id), 5000);
            QCOMPARE(decoder.error(), QMediaPlayer::NoError); QVERIFY2(samples > 0, qPrintable(id));
            decoder.stop();
            decoder.setAudioBufferOutput(nullptr);
        }
        board.setDeafened(true); board.play(catalog.first().toObject().value("id").toString());
        QVERIFY(!board.findChild<QMediaPlayer*>());
    }
    void pushToTalkReleaseDelaySurvivesRepressAndCancelsOnLeave() {
        CallShortcuts shortcuts(nullptr, false);
        QSignalSpy changes(&shortcuts, &CallShortcuts::talkingChanged);
        shortcuts.configure(true, false, 0x77, 120); shortcuts.setActive(true);
        shortcuts.setTalkKeyPressed(true); QCOMPARE(changes.size(), 1); QCOMPARE(changes.last().first().toBool(), true);
        shortcuts.setTalkKeyPressed(false); QTest::qWait(40); QCOMPARE(changes.size(), 1);
        shortcuts.setTalkKeyPressed(true); QTest::qWait(150); QCOMPARE(changes.size(), 1);
        shortcuts.setTalkKeyPressed(false); QTRY_COMPARE(changes.size(), 2); QCOMPARE(changes.last().first().toBool(), false);
        shortcuts.setTalkKeyPressed(true); shortcuts.setTalkKeyPressed(false);
        shortcuts.setActive(false); QCOMPARE(changes.size(), 4); QVERIFY(!changes.last().first().toBool());
        shortcuts.setActive(true); shortcuts.setTalkKeyPressed(true);
        QTest::qWait(150); QCOMPARE(changes.size(), 5); QVERIFY(changes.last().first().toBool());
        shortcuts.setTalkKeyPressed(false); shortcuts.configure(true, false, 0x78, 0);
        QCOMPARE(changes.size(), 6); QVERIFY(!changes.last().first().toBool());
        shortcuts.setTalkKeyPressed(true); shortcuts.setTalkKeyPressed(false);
        QCOMPARE(changes.size(), 8); QVERIFY(!changes.last().first().toBool());
        shortcuts.configure(false, false); shortcuts.setTalkKeyPressed(true); QCOMPARE(changes.size(), 8);
    }
    void shortcutRegistrationHasOwnershipAndReleasesKeys() {
        QVERIFY(microphoneMuted(true, true, true)); QVERIFY(microphoneMuted(false, true, false));
        QVERIFY(!microphoneMuted(false, true, true)); QVERIFY(!microphoneMuted(false, false, false));
        CallShortcuts first, second;
        QSignalSpy firstErrors(&first, &CallShortcuts::message), secondErrors(&second, &CallShortcuts::message);
        first.configure(true, false, 0x87); first.setActive(true); // F24: no ordinary text input.
        if (!firstErrors.isEmpty()) QSKIP("F24 is reserved by another application");
        second.configure(true, false, 0x87); second.setActive(true); QCOMPARE(secondErrors.size(), 1);
        first.setActive(false); second.setActive(false); secondErrors.clear(); second.setActive(true);
        QCOMPARE(secondErrors.size(), 0); second.setActive(false);
    }
    void notificationsRespectFocusNamesAndPreferences() {
        QVERIFY(mentionsName("oi @João!", "joão")); QVERIFY(!mentionsName("joãozinho", "joão"));
        QVERIFY(mentionsName("oi a.b", "a.b")); QVERIFY(!mentionsName("oi axb", "a.b"));
        QVERIFY(!mentionsName("qualquer texto", ""));
        DesktopNotifications notifications(nullptr, false); QSignalSpy delivered(&notifications, &DesktopNotifications::requested);
        const QJsonObject message{{"senderSocketId", "peer"}, {"senderName", "Amigo"}, {"text", "@camargo vem jogar"}};
        notifications.chatMessage(message, "self", "camargo", false); QCOMPARE(delivered.count(), 0);
        notifications.chatMessage(message, "peer", "camargo", true); QCOMPARE(delivered.count(), 0);
        notifications.chatMessage(message, "self", "camargo", true); QCOMPARE(delivered.count(), 1);
        notifications.chatMessage(message, "self", "camargo", true); QCOMPARE(delivered.count(), 1);
        notifications.memberEntered("Amigo", true); QCOMPARE(delivered.count(), 2);
        notifications.setEnabled(false); notifications.memberEntered("Outro", true); QCOMPARE(delivered.count(), 2);
    }
    void firstLaunchName() {
        QSettings().remove("username");
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected); window.show();
        QTRY_VERIFY(window.findChild<QDialog*>("welcomeDialog"));
        auto* name = window.findChild<QLineEdit*>("firstNameInput");
        auto* enter = window.findChild<QPushButton*>("continueButton");
        QVERIFY(!enter->isEnabled()); name->setText("   "); QVERIFY(!enter->isEnabled());
        name->setText("  Camargo  "); QVERIFY(enter->isEnabled()); enter->click();
        QCOMPARE(QSettings().value("username").toString(), QString("Camargo"));
        QTRY_VERIFY(!window.findChild<QDialog*>("welcomeDialog"));
    }
    void recoveredDiscordMarkdownGrammarTests() {
        // 1. Escaping
        {
            const auto nodes = parseDiscordMarkdown(QString::fromUtf8(R"(\*não itálico\*)"), { .inlineOnly = true });
            QVERIFY(!nodes.empty());
            QCOMPARE(nodes[0].type, MarkdownNodeType::Text);
            QCOMPARE(nodes[0].content, QString("*"));
        }

        // 2. Headings: 1-3 hashes allowed; 4 hashes is plain text in Discord
        {
            const auto h1 = parseDiscordMarkdown("# Titulo Principal");
            QVERIFY(!h1.empty());
            QCOMPARE(h1[0].type, MarkdownNodeType::Heading);
            QCOMPARE(h1[0].level, 1);
            QVERIFY(!h1[0].children.empty());
            QCOMPARE(h1[0].children[0].content, QString("Titulo Principal"));

            const auto h3 = parseDiscordMarkdown("### Subsecao");
            QVERIFY(!h3.empty());
            QCOMPARE(h3[0].type, MarkdownNodeType::Heading);
            QCOMPARE(h3[0].level, 3);

            const auto h4 = parseDiscordMarkdown("#### Quatro Nao Eh Heading");
            QVERIFY(!h4.empty());
            QVERIFY(h4[0].type != MarkdownNodeType::Heading);
        }

        // 3. Subtext (-# text)
        {
            const auto sub = parseDiscordMarkdown("-# mensagem em subtexto");
            QVERIFY(!sub.empty());
            QCOMPARE(sub[0].type, MarkdownNodeType::Subtext);
            QVERIFY(!sub[0].children.empty());
            QCOMPARE(sub[0].children[0].content, QString("mensagem em subtexto"));
        }

        // 4. Code Blocks and Inline Code
        {
            const auto cb = parseDiscordMarkdown("```cpp\nint main() { return 0; }\n```");
            QVERIFY(!cb.empty());
            QCOMPARE(cb[0].type, MarkdownNodeType::CodeBlock);
            QCOMPARE(cb[0].lang, QString("cpp"));
            QVERIFY(cb[0].content.contains("int main()"));

            const auto ic = parseDiscordMarkdown("use `triscord.exe` para rodar", { .inlineOnly = true });
            bool hasInline = false;
            for (const auto& n : ic) {
                if (n.type == MarkdownNodeType::InlineCode) {
                    hasInline = true;
                    QCOMPARE(n.content, QString("triscord.exe"));
                }
            }
            QVERIFY(hasInline);
        }

        // 5. BlockQuote (>>> multiline and > singleline)
        {
            const auto bq = parseDiscordMarkdown("> citacao simples\ncontinua");
            QVERIFY(!bq.empty());
            QCOMPARE(bq[0].type, MarkdownNodeType::BlockQuote);

            const auto multiBq = parseDiscordMarkdown(">>> linha 1\nlinha 2\nlinha 3");
            QVERIFY(!multiBq.empty());
            QCOMPARE(multiBq[0].type, MarkdownNodeType::BlockQuote);
        }

        // 6. Formatting Priority and Nesting (**bold**, *em*, __u__, ~~s~~)
        {
            const auto boldItalic = parseDiscordMarkdown("**negrito _e italico_**", { .inlineOnly = true });
            QVERIFY(!boldItalic.empty());
            QCOMPARE(boldItalic[0].type, MarkdownNodeType::Strong);
            bool hasInnerEm = false;
            for (const auto& child : boldItalic[0].children) {
                if (child.type == MarkdownNodeType::Em) hasInnerEm = true;
            }
            QVERIFY(hasInnerEm);

            const auto strike = parseDiscordMarkdown("~~tachado~~", { .inlineOnly = true });
            QVERIFY(!strike.empty());
            QCOMPARE(strike[0].type, MarkdownNodeType::Strikethrough);

            const auto underline = parseDiscordMarkdown("__sublinhado__", { .inlineOnly = true });
            QVERIFY(!underline.empty());
            QCOMPARE(underline[0].type, MarkdownNodeType::Underline);
        }

        // 7. Spoilers
        {
            const auto spoiler = parseDiscordMarkdown("||conteudo secreto||", { .inlineOnly = true });
            QVERIFY(!spoiler.empty());
            QCOMPARE(spoiler[0].type, MarkdownNodeType::Spoiler);
            QVERIFY(!spoiler[0].children.empty());
            QCOMPARE(spoiler[0].children[0].content, QString("conteudo secreto"));
        }

        // 8. Masked links (module 694403 validation)
        {
            const auto linkNode = parseDiscordMarkdown("[website](https://triscord.com)", { .inlineOnly = true });
            QVERIFY(!linkNode.empty());
            QCOMPARE(linkNode[0].type, MarkdownNodeType::Link);
            QCOMPARE(linkNode[0].target, QString("https://triscord.com"));

            const auto rejectedLink = parseDiscordMarkdown("[malicioso](javascript:alert(1))", { .inlineOnly = true });
            QVERIFY(!rejectedLink.empty());
            QCOMPARE(rejectedLink[0].type, MarkdownNodeType::Text);

            const auto nestedLink = parseDiscordMarkdown("[[nested]](https://triscord.com)", { .inlineOnly = true });
            QVERIFY(!nestedLink.empty());
        }

        // 9. Mentions and Custom Emojis
        {
            const auto mention = parseDiscordMarkdown("<@123456789> e @everyone", { .inlineOnly = true });
            bool hasUserMention = false, hasEveryone = false;
            for (const auto& n : mention) {
                if (n.type == MarkdownNodeType::Mention && n.id == "123456789") hasUserMention = true;
                if (n.type == MarkdownNodeType::Mention && n.content == "@everyone") hasEveryone = true;
            }
            QVERIFY(hasUserMention);
            QVERIFY(hasEveryone);

            const auto emoji = parseDiscordMarkdown("<a:blobparty:99887766>", { .inlineOnly = true });
            QVERIFY(!emoji.empty());
            QCOMPARE(emoji[0].type, MarkdownNodeType::CustomEmoji);
            QVERIFY(emoji[0].animated);
            QCOMPARE(emoji[0].id, QString("99887766"));
        }

        // 10. Incomplete / unclosed formatting gracefully treated as text
        {
            const auto unclosed = parseDiscordMarkdown("**negrito sem fechar texto", { .inlineOnly = true });
            QVERIFY(!unclosed.empty());
            QCOMPARE(markdownToPlainText(unclosed), QString("**negrito sem fechar texto"));
        }

        // 11. Visual Rendering and snapshot fixture in ChatPane
        {
            ChatPane chat; chat.resize(480, 400); chat.show();
            QJsonObject m1{{"id", "m1"}, {"senderUserId", "u1"}, {"senderName", "amigo"},
                           {"text", "# boas-vindas ao triscord\n-# cliente nativo c++\n**negrito**, *italico*, __sublinhado__ e ~~tachado~~\n```cpp\nint x = 42;\n```\n||spoiler oculto|| e [link seguro](https://triscord.com)"},
                           {"timestamp", 1770900000000.0}};
            chat.appendMessage(m1);
            QCoreApplication::processEvents();

            QCOMPARE(chat.count(), 1);
            QCOMPARE(chat.item(0)->data(Qt::UserRole).toJsonObject().value("text").toString(), m1.value("text").toString());
            QVERIFY(chat.item(0)->data(Qt::AccessibleTextRole).toString().contains("boas-vindas ao triscord"));

            QPixmap capture = chat.grab();
            QVERIFY(!capture.isNull());
            const QString path = QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-markdown.png");
            capture.save(path);
            QVERIFY(QFile::exists(path));
        }
    }
    void callCardsAndControlsConsolidation() {
        ParticipantPane pane; pane.resize(800, 450);
        const QJsonArray users{
            QJsonObject{{"socketId", "peer-voice"}, {"username", "Alice"}, {"avatar", "#5865f2"}, {"isMuted", false}, {"isDeafened", false}},
            QJsonObject{{"socketId", "peer-cam"}, {"username", "Bob"}, {"avatar", "#eb459e"}, {"isMuted", true}, {"isDeafened", false}},
            QJsonObject{{"socketId", "peer-deaf"}, {"username", "Charlie"}, {"avatar", "#fee75c"}, {"isMuted", true}, {"isDeafened", true}},
            QJsonObject{{"socketId", "peer-idle"}, {"username", "Dave"}, {"avatar", "#57f287"}, {"isMuted", false}, {"isDeafened", false}}
        };
        pane.setParticipants(users); pane.show();
        QCoreApplication::processEvents();

        // 1. Camera frame for Bob
        QImage camImage(640, 360, QImage::Format_RGB32); camImage.fill(QColor("#1a2b3c"));
        pane.setFrame("peer-cam", camImage);

        // 2. Speaking indicator for Alice
        pane.setSpeaking("peer-voice", true);
        QCoreApplication::processEvents();

        // Verify speaking green border on Alice (tile 0)
        const auto gridImage = pane.grab().toImage();
        const auto aliceTile = pane.tileRect("peer-voice");
        bool aliceSpeakingGreen = false;
        for (int x = aliceTile.left() + 10; x < aliceTile.right() - 10; ++x) {
            const auto c = gridImage.pixelColor(x, aliceTile.top() + 1);
            if (c.green() >= 140 && c.green() > c.red() + 40) { aliceSpeakingGreen = true; break; }
        }
        QVERIFY(aliceSpeakingGreen);

        // 3. Focus interaction on participant without camera (Charlie)
        QSignalSpy focusSpy(&pane, &ParticipantPane::focusChanged);
        const auto charlieTile = pane.tileRect("peer-deaf");
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, charlieTile.center());
        QCOMPARE(pane.focusedPeer(), QString("peer-deaf"));
        QCOMPARE(focusSpy.count(), 1);

        // Unfocus Charlie
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, QPoint(pane.width() / 2, 50));
        QVERIFY(pane.focusedPeer().isEmpty());

        // Focus Bob (with camera) and clear with Escape
        const auto bobTile = pane.tileRect("peer-cam");
        QTest::mouseClick(&pane, Qt::LeftButton, Qt::NoModifier, bobTile.center());
        QCOMPARE(pane.focusedPeer(), QString("peer-cam"));
        QTest::keyClick(&pane, Qt::Key_Escape);
        QVERIFY(pane.focusedPeer().isEmpty());

        // 4. Context menu requested via right click
        QSignalSpy menuSpy(&pane, &ParticipantPane::participantContextMenuRequested);
        QTest::mouseClick(&pane, Qt::RightButton, Qt::NoModifier, aliceTile.center());
        QCOMPARE(menuSpy.count(), 1);
        QCOMPARE(menuSpy.first().at(0).toString(), QString("peer-voice"));
        QCOMPARE(menuSpy.first().at(1).toString(), QString("Alice"));

        // Save call grid component fixture evidence
        const QString gridPath = QDir(QCoreApplication::applicationDirPath()).filePath("../native-calls-fixture-grid.png");
        QVERIFY(pane.grab().save(gridPath));
        QVERIFY(QFile::exists(gridPath));

        // 5. Test call footer controls
        auto* audioGroup = new QWidget;
        auto* audioLayout = new QHBoxLayout(audioGroup);
        auto* muteBtn = new QPushButton("Silenciar Microfone");
        auto* deafenBtn = new QPushButton("Silenciar Chamada");
        audioLayout->addWidget(muteBtn); audioLayout->addWidget(deafenBtn);

        auto* mediaGroup = new QWidget;
        auto* mediaLayout = new QHBoxLayout(mediaGroup);
        auto* camBtn = new QPushButton("Câmera");
        auto* shareBtn = new QPushButton("Compartilhar Tela");
        auto* soundBtn = new QPushButton("Sons");
        mediaLayout->addWidget(camBtn); mediaLayout->addWidget(shareBtn); mediaLayout->addWidget(soundBtn);

        auto* actionsGroup = new QWidget;
        auto* actionsLayout = new QHBoxLayout(actionsGroup);
        auto* leaveBtn = new QPushButton("Desconectar");
        leaveBtn->setObjectName("leaveCallButton");
        auto* settingsBtn = new QPushButton("Configurações");
        actionsLayout->addWidget(settingsBtn); actionsLayout->addWidget(leaveBtn);

        CallFooter footer(audioGroup, mediaGroup, actionsGroup);
        footer.resize(960, 64); footer.show();
        QCoreApplication::processEvents();

        const QString controlsPath = QDir(QCoreApplication::applicationDirPath()).filePath("../native-calls-fixture-controls.png");
        QVERIFY(footer.grab().save(controlsPath));
        QVERIFY(QFile::exists(controlsPath));

        delete audioGroup; delete mediaGroup; delete actionsGroup;
    }
    void discordIconsVectorValidation() {
        const QVector<DiscordIcons::IconType> types = {
            DiscordIcons::IconType::Microphone,
            DiscordIcons::IconType::MicrophoneMuted,
            DiscordIcons::IconType::Headphones,
            DiscordIcons::IconType::HeadphonesDeafened,
            DiscordIcons::IconType::Settings,
            DiscordIcons::IconType::Camera,
            DiscordIcons::IconType::ScreenShare,
            DiscordIcons::IconType::Disconnect,
            DiscordIcons::IconType::VoiceSpeaker,
            DiscordIcons::IconType::Close
        };

        for (auto type : types) {
            const auto path = DiscordIcons::path(type);
            QVERIFY(!path.isEmpty());
            QVERIFY(path.elementCount() >= 5);
            const auto bounds = path.boundingRect();
            QVERIFY(bounds.left() >= 0.0 && bounds.top() >= 0.0);
            QVERIFY(bounds.right() <= 24.5 && bounds.bottom() <= 24.5);

            const auto px = DiscordIcons::pixmap(type, QColor("#ffffff"), 24, 1);
            QCOMPARE(px.size(), QSize(24, 24));
            const auto img = px.toImage();
            int drawnPixels = 0;
            for (int y = 0; y < img.height(); ++y) {
                for (int x = 0; x < img.width(); ++x) {
                    if (img.pixelColor(x, y).alpha() > 100) drawnPixels++;
                }
            }
            // All icons must have substantial rasterization fill (> 30 pixels on 24x24)
            QVERIFY(drawnPixels > 30);

            const auto ic = DiscordIcons::icon(type, QColor("#b5bac1"), 20);
            QVERIFY(!ic.isNull());
        }
    }
    void channelComposerMultilineDynamicGrowth() {
        QWidget parent; parent.resize(600, 600); parent.show();
        auto* composer = new ChannelComposer(&parent); composer->resize(400, 56); composer->show();
        QCoreApplication::processEvents();

        // 1. Initial state: exactly 44px
        QCOMPARE(composer->height(), 56);

        // 2. Multiline growth: 3 lines
        composer->setText("linha 1\nlinha 2\nlinha 3");
        QCoreApplication::processEvents();
        const int h3 = composer->height();
        QVERIFY(h3 > 56);

        // 3. Multiline growth: 10 lines
        QString tenLines;
        for (int i = 1; i <= 10; ++i) tenLines += QString("parágrafo %1\n").arg(i);
        composer->setText(tenLines);
        QCoreApplication::processEvents();
        const int h10 = composer->height();
        QVERIFY(h10 > h3);

        // 4. Shrink back on clear
        composer->clear();
        QCoreApplication::processEvents();
        QCOMPARE(composer->height(), 56);

        // 5. Shift+Enter inserts newline, plain Enter emits returnPressed
        QSignalSpy sendSpy(composer, &ChannelComposer::returnPressed);
        composer->setText("teste");
        QTest::keyPress(composer, Qt::Key_Return, Qt::ShiftModifier);
        QCoreApplication::processEvents();
        QCOMPARE(sendSpy.count(), 0);
        QVERIFY(composer->toPlainText().contains("\n"));

        QTest::keyPress(composer, Qt::Key_Return, Qt::NoModifier);
        QCoreApplication::processEvents();
        QCOMPARE(sendSpy.count(), 1);

        // 6. Dedicated snapshot of composer in integrated channelTextArea container
        QWidget container; container.setObjectName("channelTextArea"); container.resize(500, 80);
        auto* lay = new QHBoxLayout(&container); lay->setContentsMargins(8, 4, 8, 4);
        auto* attach = new QPushButton("+", &container); attach->setObjectName("chatAttachButton"); attach->setFixedSize(24, 24); attach->setEnabled(false);
        auto* send = new QPushButton("Enviar", &container); send->setObjectName("chatSendButton");
        auto* testComposer = new ChannelComposer(&container);
        lay->addWidget(attach); lay->addWidget(testComposer, 1); lay->addWidget(send);
        container.setStyleSheet("QWidget#channelTextArea { background: #111214; border: 1px solid #1e1f22; border-radius: 8px; }"
                                "QPushButton#chatAttachButton { background: #2b2d31; border: 0; border-radius: 12px; color: #b5bac1; font-size: 14px; font-weight: bold; padding: 0; }"
                                "QPushButton#chatAttachButton:disabled { background: #1e1f22; border: 1px solid #282828; color: #4e5058; }"
                                "QPushButton#chatSendButton { background: #5865f2; color: #ffffff; border-radius: 4px; padding: 6px 12px; font-weight: bold; }");
        testComposer->setText("Olá mundo no Triscord!\nTestando expansão multiline e Shift+Enter fiel ao Discord.");
        container.show();
        QCoreApplication::processEvents();

        const QString composerSnapshot = QDir(QCoreApplication::applicationDirPath()).filePath("../native-chat-composer.png");
        QVERIFY(container.grab().save(composerSnapshot));
        QVERIFY(QFile::exists(composerSnapshot));
    }
    void composerShortcutsAndLimitsWorkAtBoundary() {
        ChannelComposer editor; editor.resize(400, 44); editor.show();
        editor.setMaxLength(5); editor.setText("abcde");
        auto cursor = editor.textCursor(); cursor.movePosition(QTextCursor::End); editor.setTextCursor(cursor);
        QCoreApplication::processEvents();

        // 1. Ctrl+A selects all text even when at limit
        QTest::keyClick(&editor, Qt::Key_A, Qt::ControlModifier);
        QCOMPARE(editor.textCursor().selectedText(), QString("abcde"));

        // 2. Typing with selection replaces text
        QTest::keyClicks(&editor, "x");
        QCOMPARE(editor.toPlainText(), QString("x"));

        // 3. Paste via clipboard respects remaining capacity
        editor.setText("ab");
        QApplication::clipboard()->setText("cdefgh");
        cursor = editor.textCursor(); cursor.movePosition(QTextCursor::End); editor.setTextCursor(cursor);
        QTest::keyClick(&editor, Qt::Key_V, Qt::ControlModifier);
        QCOMPARE(editor.toPlainText(), QString("abcde")); // clamped to max length 5
    }
    void voiceChatPanelFollowsObservedDiscord() {
        // Reference: desktop/out/claude-observations/CHAT.md ("Mostrar chat" in the Discord voice view).
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected);
        window.resize(1264, 892); window.show(); QCoreApplication::processEvents();
        auto* panel = window.findChild<QWidget*>("voiceChatPanel"); QVERIFY(panel);
        auto* toggle = window.findChild<QPushButton*>("voiceChatToggle"); QVERIFY(toggle);
        auto* composer = window.findChild<ChannelComposer*>("chatComposer"); QVERIFY(composer);
        QCOMPARE(toggle->toolTip(), QString("Mostrar chat"));
        QVERIFY(toggle->isHidden()); // before joining, triscord has no channel chat
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "chat-room"}, {"name", "Jogos"}, {"userCount", 1}, {"users", QJsonArray{}}}}})));
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "room-joined"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonObject{{"roomId", "chat-room"}, {"chatHistory", QJsonArray{}}}})));
        QCoreApplication::processEvents();
        QVERIFY(panel->isHidden()); // observed: the chat starts closed
        QCOMPARE(composer->placeholderText(), QString("Conversar em Jogos")); // observed without "#"
        QCOMPARE(window.findChild<QLabel*>("voiceChatTitle")->text(), QString("Jogos"));
        { QEvent enter(QEvent::Enter); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &enter); }
        QVERIFY(!toggle->isHidden());
        toggle->click(); QCoreApplication::processEvents();
        QVERIFY(!panel->isHidden()); QCOMPARE(panel->width(), 450);
        QVERIFY(toggle->isHidden()); // the panel covers the header area where the toggle sat
        QCOMPARE(composer->height(), 56);
        // Same structure as the observed Discord list (own messages, date separator, link): fixture content only.
        const qint64 t0 = QDateTime(QDate(2026, 9, 9), QTime(2, 9)).toMSecsSinceEpoch();
        for (const auto& m : {QJsonObject{{"id", "m1"}, {"senderName", "camargo"}, {"senderUserId", "ui-test-owner"}, {"text", "https://example.org/a"}, {"timestamp", t0}},
                              QJsonObject{{"id", "m2"}, {"senderName", "camargo"}, {"senderUserId", "ui-test-owner"}, {"text", "https://example.org/b"}, {"timestamp", t0 + 88 * 60000}}})
            QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "new-chat-message"), Q_ARG(QJsonArray, (QJsonArray{m})));
        QCoreApplication::processEvents();
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-voice-chat-panel.png")));
        window.findChild<QPushButton*>("voiceChatClose")->click(); QCoreApplication::processEvents();
        QVERIFY(panel->isHidden()); QVERIFY(!toggle->isHidden());
        toggle->click();
        QMetaObject::invokeMethod(&window, "leaveRoom");
        QVERIFY(panel->isHidden());
    }
    void accountPanelFollowsObservedDiscordStates() {
        // Reference: desktop/out/claude-observations/ACCOUNT_PANEL.md (Discord 1.0.9261, 1280x900, 96 DPI).
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected);
        window.resize(1280, 900); window.show(); QCoreApplication::processEvents();
        auto* mic = window.findChild<QPushButton*>("userMuteButton");
        auto* deaf = window.findChild<QPushButton*>("userDeafenButton");
        auto* micOptions = window.findChild<QPushButton*>("userMuteOptionsButton");
        auto* deafOptions = window.findChild<QPushButton*>("userDeafenOptionsButton");
        auto* panel = window.findChild<QWidget*>("userAccountPanel");
        auto* column = window.findChild<QWidget*>("leftColumn");
        QVERIFY(mic && deaf && micOptions && deafOptions && panel && column);

        QVERIFY(mic->isEnabled()); QVERIFY(deaf->isEnabled());
        QVERIFY(!mic->isChecked()); QVERIFY(!deaf->isChecked());
        QCOMPARE(mic->toolTip(), QString("Silenciar"));
        QCOMPARE(deaf->toolTip(), QString("Desativar áudio"));
        QCOMPARE(micOptions->toolTip(), QString("Opções de entrada"));
        QCOMPARE(deafOptions->toolTip(), QString("Opções de saída"));
        QCOMPARE(window.findChild<QPushButton*>("userSettingsButton")->toolTip(), QString("Configurações de usuário"));

        QCOMPARE(panel->height(), 58);
        QCOMPARE(panel->geometry().left(), 8);
        QCOMPARE(column->width() - panel->geometry().right() - 1, 8);
        QCOMPARE(column->height() - panel->geometry().bottom() - 1, 8);
        QCOMPARE(panel->width(), 359);
        QCOMPARE(mic->size(), QSize(32, 32)); QCOMPARE(micOptions->size(), QSize(16, 32));
        const auto micGroup = QRect(mic->parentWidget()->mapTo(panel, QPoint()), mic->parentWidget()->size());
        const auto deafGroup = QRect(deaf->parentWidget()->mapTo(panel, QPoint()), deaf->parentWidget()->size());
        auto* gearButton = window.findChild<QPushButton*>("userSettingsButton");
        const auto gear = QRect(gearButton->mapTo(panel, QPoint()), gearButton->size());
        QCOMPARE(micGroup.width(), 49);
        QCOMPARE(deafGroup.left() - micGroup.right() - 1, 8);
        QCOMPARE(gear.left() - deafGroup.right() - 1, 8);
        QCOMPARE(panel->width() - gear.right() - 1, 12);
        QCOMPARE(gear.top(), 13);

        mic->click(); QVERIFY(mic->isChecked()); QCOMPARE(mic->toolTip(), QString("Dessilenciar"));
        QCOMPARE(mic->parentWidget()->property("active").toBool(), true);
        deaf->click(); QVERIFY(deaf->isChecked()); QVERIFY(mic->isChecked()); QCOMPARE(deaf->toolTip(), QString("Reativar áudio"));
        deaf->click(); QVERIFY(!deaf->isChecked()); QVERIFY(mic->isChecked());
        mic->click(); QVERIFY(!mic->isChecked());
        deaf->click(); QVERIFY(mic->isChecked());
        deaf->click(); QVERIFY(!mic->isChecked());
        deaf->click(); QVERIFY(mic->isChecked() && deaf->isChecked());
        mic->click(); QVERIFY(!mic->isChecked()); QVERIFY(!deaf->isChecked());

        mic->click();
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "room-joined"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonObject{{"roomId", "panel-room"}, {"chatHistory", QJsonArray{}}}})));
        QVERIFY(mic->isChecked()); QVERIFY(mic->isEnabled());
        QMetaObject::invokeMethod(&window, "leaveRoom");
        QVERIFY(mic->isChecked()); QVERIFY(mic->isEnabled());
        mic->click();
        QVERIFY(panel->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-account-panel.png")));

        auto* settingsVolume = window.findChild<QSlider*>("outputVolumeSlider"); QVERIFY(settingsVolume);
        QStringList rows; int sliderMax = -1; bool chevronOpen = false;
        QTimer::singleShot(50, this, [&] {
            auto* menu = qobject_cast<QMenu*>(QApplication::activePopupWidget()); if (!menu) return;
            for (auto* action : menu->actions()) rows << (action->isSeparator() ? QString("-") : action->text());
            chevronOpen = deafOptions->property("open").toBool();
            if (auto* slider = menu->findChild<QSlider*>("audioOptionsVolume")) { sliderMax = slider->maximum(); slider->setValue(150); }
            menu->close();
        });
        deafOptions->click();
        QTRY_VERIFY(!rows.isEmpty());
        QCOMPARE(rows, (QStringList{"Dispositivo de saída", "-", "", "-", "Configurações de voz"}));
        QVERIFY(chevronOpen);
        QCOMPARE(sliderMax, 200);
        QCOMPARE(settingsVolume->value(), 150);
        QTRY_VERIFY(!deafOptions->property("open").toBool());
        settingsVolume->setValue(100);
    }
    void navigationChromeFollowsObservedDiscordLayout() {
        // Reference: desktop/out/claude-observations/NAVIGATION.md (Discord 1.0.9261, client 1264x892, 96 DPI).
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected);
        window.resize(1264, 892); window.show(); QCoreApplication::processEvents();
        QVERIFY(window.windowFlags().testFlag(Qt::FramelessWindowHint));
        auto* title = window.findChild<QWidget*>("titleBar"); QVERIFY(title);
        QCOMPARE(title->height(), 32); QCOMPARE(title->mapTo(&window, QPoint()).y(), 0);
        auto* close = window.findChild<QPushButton*>("windowCloseButton");
        auto* maximize = window.findChild<QPushButton*>("windowMaximizeButton");
        auto* minimize = window.findChild<QPushButton*>("windowMinimizeButton");
        QVERIFY(close && maximize && minimize);
        QCOMPARE(close->geometry(), QRect(title->width() - 32, 0, 32, 32));
        QCOMPARE(maximize->geometry().right() + 1 + 4, close->geometry().left());
        QCOMPARE(minimize->geometry().right() + 1 + 4, maximize->geometry().left());
        QCOMPARE(window.findChild<QLabel*>("titleBarName")->text(), QString("Triscord"));
        auto* rail = window.findChild<QWidget*>("serverRail"); QVERIFY(rail);
        auto* column = window.findChild<QWidget*>("leftColumn");
        auto* sidebar = window.findChild<QWidget*>("sidebar");
        QCOMPARE(rail->width(), 72); QCOMPARE(column->width(), 375); QCOMPARE(sidebar->width(), 303);
        QCOMPARE(column->mapTo(&window, QPoint()).y(), 32);
        const auto items = rail->findChildren<QAbstractButton*>("serverRailItem");
        QCOMPARE(items.size(), 1);
        QCOMPARE(items.first()->toolTip(), QString("Triscord"));
        QCOMPARE(items.first()->geometry().topLeft(), QPoint(0, 0));
        // "Adicionar um servidor" now has a function (hub server layer) and sits 8px under the last server.
        auto* add = rail->findChild<QAbstractButton*>("addServerButton"); QVERIFY(add);
        QCOMPARE(add->geometry(), QRect(0, 48, 72, 40));
        QCOMPARE(add->toolTip(), QString("Adicionar um servidor"));
        QVERIFY(window.findChild<QPushButton*>("serverInviteButton")->isHidden()); // legacy group: nobody owns it
        // No back/forward, inbox, help, home or discover controls without a triscord function.
        QCOMPARE(title->findChildren<QPushButton*>().size(), 3);
        // Sidebar and channel header (desktop/out/claude-observations/SIDEBAR.md).
        auto* serverHeader = window.findChild<QWidget*>("serverHeader"); QVERIFY(serverHeader);
        QCOMPARE(serverHeader->height(), 49); QCOMPARE(serverHeader->width(), sidebar->width());
        QCOMPARE(window.findChild<QLabel*>("serverTitle")->text(), QString("Triscord"));
        auto* channelHeader = window.findChild<QWidget*>("channelHeader"); QVERIFY(channelHeader);
        QCOMPARE(channelHeader->height(), 49); QCOMPARE(channelHeader->width(), window.findChild<QWidget*>("centerColumn")->width());
        QVERIFY(!window.findChild<QLabel*>("channelHeaderTopic"));
        auto* section = window.findChild<ChannelSectionHeader*>("channelSectionHeader"); QVERIFY(section);
        QCOMPARE(section->height(), 41);
        QCOMPARE(section->mapTo(sidebar, QPoint()).y(), 50); // 1px top border + 48px header + 1px divider (Discord rows 32, 33..80, 81)
        auto* rooms = window.findChild<QListWidget*>("roomList");
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 2}, {"users", QJsonArray{}}},
                                                     QJsonObject{{"id", "r2"}, {"name", "Jogos"}, {"userCount", 0}, {"users", QJsonArray{}}}}})));
        QCOMPARE(rooms->count(), 2);
        QCOMPARE(rooms->item(0)->text(), QString("Geral"));
        QVERIFY(rooms->item(0)->data(Qt::AccessibleTextRole).toString().contains("2"));
        QCOMPARE(rooms->visualItemRect(rooms->item(0)).height(), 32);
        QCOMPARE(rooms->visualItemRect(rooms->item(0)).top(), 1);
        QCOMPARE(rooms->visualItemRect(rooms->item(1)).top() - rooms->visualItemRect(rooms->item(0)).top(), 34);
        auto titleBrightness = [section] {
            const QImage image = section->grab().toImage(); int best = 0;
            for (int y = 19; y < 38; ++y) for (int x = 16; x < 110; ++x) best = std::max(best, qGray(image.pixel(x, y)));
            return best;
        };
        QVERIFY(titleBrightness() < 200);
        QEvent enter(QEvent::Enter); QCoreApplication::sendEvent(section->addButton(), &enter);
        QVERIFY(titleBrightness() > 210); // theme-midnight: hovering "Criar canal" turns the section title --text-strong #dcdcdf (qGray ~220), not pure white
        QEvent leave(QEvent::Leave); QCoreApplication::sendEvent(section->addButton(), &leave);
        QVERIFY(titleBrightness() < 200);
        QTest::mouseClick(section, Qt::LeftButton, Qt::NoModifier, QPoint(40, 28));
        QVERIFY(section->isCollapsed()); QVERIFY(rooms->isHidden());
        QTest::mouseClick(section, Qt::LeftButton, Qt::NoModifier, QPoint(40, 28));
        QVERIFY(!section->isCollapsed()); QVERIFY(!rooms->isHidden());
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-navigation-chrome.png")));
    }
    void voiceChannelPrejoinViewFollowsObservedDiscord() {
        // Reference: desktop/out/claude-observations/CALLS.md (Discord voice channel before joining).
        MainWindow window(nullptr, VoiceCall::AudioMode::Injected);
        window.resize(1264, 892); window.show(); QCoreApplication::processEvents();
        auto* prejoin = window.findChild<VoicePrejoinView*>("voicePrejoinView"); QVERIFY(prejoin);
        QVERIFY(prejoin->isVisible());
        QVERIFY(!window.findChild<QWidget*>("channelTextArea")->isVisible());
        QVERIFY(!window.findChild<QWidget*>("peoplePanel")->isVisible());
        QCOMPARE(window.findChild<QWidget*>("channelHeader")->property("prejoin").toBool(), true);
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}},
                                                     QJsonObject{{"id", "r2"}, {"name", "Jogos"}, {"userCount", 1}, {"users", QJsonArray{}}}}})));
        QCOMPARE(prejoin->findChild<QLabel*>("voicePrejoinTitle")->text(), QString("Geral"));
        QCOMPARE(prejoin->findChild<QLabel*>("voicePrejoinSubtitle")->text(), QString("Ninguém está em voz"));
        auto* join = prejoin->joinButton();
        QCOMPARE(join->text(), QString("Entrar na chamada de voz")); QCOMPARE(join->height(), 40);
        QVERIFY(!join->isEnabled()); // no signaling connection in this fixture
        QCOMPARE(window.findChild<QLabel*>("channelHeaderTitle")->text(), QString("Geral"));
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "room-joined"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonObject{{"roomId", "r2"}, {"chatHistory", QJsonArray{}}}})));
        QVERIFY(!prejoin->isVisible());
        QVERIFY(window.findChild<QWidget*>("callStage")->isVisible());
        QVERIFY(!window.findChild<QWidget*>("channelTextArea")->isVisible()); // observed: voice chat starts closed
        QVERIFY(!window.findChild<QWidget*>("peoplePanel")->isVisible()); // observed call view has no member list
        QCOMPARE(window.findChild<QWidget*>("channelHeader")->property("prejoin").toBool(), false);
        QMetaObject::invokeMethod(&window, "receiveEvent", Q_ARG(QString, "rooms-update"),
            Q_ARG(QJsonArray, (QJsonArray{QJsonArray{QJsonObject{{"id", "r1"}, {"name", "Geral"}, {"userCount", 0}, {"users", QJsonArray{}}},
                QJsonObject{{"id", "r2"}, {"name", "Jogos"}, {"userCount", 1}, {"users", QJsonArray{QJsonObject{{"socketId", "self"}, {"username", "camargo"}, {"isMuted", true}, {"isDeafened", true}}}}}}})));
        QCoreApplication::processEvents();
        { // Observed sidebar (CALLS.md): the participant row sits under its voice channel; the connected speaker is green.
          auto* roomList = window.findChild<QListWidget*>("roomList");
          QCOMPARE(roomList->visualItemRect(roomList->item(0)).height(), 32);
          QCOMPARE(roomList->visualItemRect(roomList->item(1)).height(), 32 + 2 + 30 + 4);
          QVERIFY(roomList->item(1)->data(ChannelRowDelegate::ConnectedRole).toBool());
          QVERIFY(!roomList->item(0)->data(ChannelRowDelegate::ConnectedRole).toBool());
          const QRect joined = roomList->visualItemRect(roomList->item(1));
          QTest::mouseClick(roomList->viewport(), Qt::LeftButton, {}, QPoint(joined.center().x(), joined.top() + 50));
          QCOMPARE(roomList->currentItem(), roomList->item(1));
          const QImage side = roomList->viewport()->grab().toImage();
          int nameInk = 0; for (int x = joined.left() + 76; x < joined.left() + 120; ++x) for (int y = joined.top() + 36; y < joined.top() + 64; ++y)
              if (qGray(side.pixel(x, y)) > 120) ++nameInk;
          QVERIFY(nameInk > 10); }
        { // Observed streaming and camera states (SHARE.md): stream section, green buttons, "Vídeo conectado", sidebar badges.
          auto* streamSection = window.findChild<QWidget*>("voiceStreamSection"); QVERIFY(streamSection); QVERIFY(streamSection->isHidden());
          auto* accountCard = window.findChild<QWidget*>("userAccountPanel"); QCOMPARE(accountCard->height(), 159);
          auto* panelCamera = window.findChild<QPushButton*>("rtcCameraButton"); auto* panelShare = window.findChild<QPushButton*>("rtcShareButton");
          auto* screenService = window.findChild<ScreenService*>(); auto* cameraService = window.findChild<CameraPublisher*>(); QVERIFY(screenService && cameraService);
          emit cameraService->publishingChanged(true); emit screenService->sharingChanged(true);
          emit window.findChild<ShareSession*>()->sharedSourceChanged("triscord teste", QPixmap(32, 32)); QCoreApplication::processEvents();
          QVERIFY(!streamSection->isHidden()); QCOMPARE(streamSection->height(), 57); QCOMPARE(accountCard->height(), 159 + 57);
          QCOMPARE(window.findChild<QLabel*>("voiceConnectedTitle")->text(), QString("Vídeo conectado"));
          QVERIFY(panelCamera->property("live").toBool()); QVERIFY(panelShare->property("live").toBool());
          QCOMPARE(window.findChild<QLabel*>("voiceStreamName")->text(), QString("triscord teste"));
          QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-streaming.png")));
          { // Same-state captures for the Discord comparison: the stream tile in the grid, then the focused viewer.
            QImage shot(784, 411, QImage::Format_RGB32); shot.fill(QColor("#1e1f22"));
            { QPainter paint(&shot); paint.setPen(QColor("#dcdcdf")); QFont label; label.setPixelSize(24); paint.setFont(label); paint.drawText(24, 44, "triscord - janela de teste"); }
            auto* cards = window.findChild<ParticipantPane*>("participantCards");
            emit screenService->frameReady("$local", shot); QCoreApplication::processEvents();
            QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-stream-grid.png")));
            QTest::mouseClick(cards, Qt::LeftButton, Qt::NoModifier, cards->tileRect(ParticipantPane::streamKey("$local")).center());
            QCoreApplication::processEvents();
            QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-stream-focused.png")));
            QTest::keyClick(cards, Qt::Key_Escape);
          }
          emit screenService->sharingChanged(false); emit window.findChild<ShareSession*>()->sharedSourceChanged({}, {}); emit cameraService->publishingChanged(false); QCoreApplication::processEvents();
          QVERIFY(streamSection->isHidden()); QCOMPARE(accountCard->height(), 159); QCOMPARE(window.findChild<QLabel*>("voiceConnectedTitle")->text(), QString("Voz conectada")); }
        // Observed: header title and control bar only while the pointer is over the call area.
        { QEvent leave(QEvent::Leave); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &leave); }
        QVERIFY(window.findChild<QWidget*>("callMediaGroup")->isHidden());
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-connected.png")));
        QVERIFY(window.findChild<QLabel*>("channelHeaderTitle")->isHidden());
        { QEvent enter(QEvent::Enter); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &enter); }
        QVERIFY(!window.findChild<QWidget*>("callMediaGroup")->isHidden());
        QVERIFY(!window.findChild<QLabel*>("channelHeaderTitle")->isHidden());
        auto* cards = window.findChild<ParticipantPane*>("participantCards");
        const QPoint cardCenter = cards->tileRect("self").center();
        { QMouseEvent move(QEvent::MouseMove, QPointF(cardCenter), cards->mapToGlobal(QPointF(cardCenter)), Qt::NoButton, Qt::NoButton, Qt::NoModifier);
          QCoreApplication::sendEvent(cards, &move); }
        QCoreApplication::processEvents();
        const QImage hoveredCard = cards->grab().toImage();
        const QRect tile = cards->tileRect("self");
        int nameInk = 0; // observed: hovering a card shows the name next to the status icon
        for (int x = tile.left() + 40; x < tile.left() + 100; ++x) for (int y = tile.bottom() - 40; y < tile.bottom() - 12; ++y)
            if (qGray(hoveredCard.pixel(x, y)) > 200) ++nameInk;
        QVERIFY(nameInk > 20);
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-call-connected-hover.png")));
        // Observed soundboard state (SOUNDBOARD.md): mic muted, audio on, popover opened from the voice panel button.
        window.findChild<QPushButton*>("userMuteButton")->setChecked(true);
        auto* panelSounds = window.findChild<QPushButton*>("rtcSoundboardButton"); QVERIFY(panelSounds->isEnabled());
        panelSounds->click(); QCoreApplication::processEvents();
        auto* board = window.findChild<Soundboard*>(); QVERIFY(board->isVisible());
        QCOMPARE(board->geometry().left(), panelSounds->mapToGlobal(QPoint()).x());
        QCOMPARE(board->geometry().bottom() + 1 + 8, panelSounds->mapToGlobal(QPoint()).y());
        { QPixmap shot = window.grab(); QPainter painter(&shot);
          painter.drawPixmap(board->mapToGlobal(QPoint()) - window.mapToGlobal(QPoint()), board->grab()); painter.end();
          QVERIFY(shot.save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-soundboard-open.png"))); }
        board->hide(); window.findChild<QPushButton*>("userMuteButton")->setChecked(false);
        { QEvent leave(QEvent::Leave); QCoreApplication::sendEvent(window.findChild<QWidget*>("centerColumn"), &leave); }
        QVERIFY(window.findChild<QWidget*>("callMediaGroup")->isHidden());
        QMetaObject::invokeMethod(&window, "leaveRoom");
        QVERIFY(prejoin->isVisible());
        QCOMPARE(prejoin->findChild<QLabel*>("voicePrejoinTitle")->text(), QString("Jogos"));
        QCOMPARE(prejoin->findChild<QLabel*>("voicePrejoinSubtitle")->text(), QString()); // occupied state not observed
        QVERIFY(window.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-voice-prejoin.png")));
    }
    void accountPopoverShowsOnlyRowsTriscordHasAndNoOthers() {
        QWidget anchor; anchor.resize(56, 42); anchor.show();
        int editCalls = 0, googleCalls = 0;
        auto* menu = buildAccountPopover(&anchor, "camargo", "@online", true, true,
                                         [&] { ++editCalls; }, [&] { ++googleCalls; });
        menu->show(); QCoreApplication::processEvents();
        QStringList rowTitles;
        for (auto* action : menu->actions()) if (!action->text().isEmpty()) rowTitles << action->text();
        // Only the rows that map to something real in triscord: editing the profile name and the Google
        // sign-in/out toggle. Discord's "200 Orbs" (virtual currency), "Mudar de conta" (multi-account) and
        // "Invisível" (manual presence) are deliberately absent — triscord has no backing feature for them.
        QCOMPARE(rowTitles, QStringList({"Editar perfil", "Sair da conta Google"}));
        for (auto* action : menu->actions()) if (action->text() == "Editar perfil") emit action->triggered();
        QCOMPARE(editCalls, 1);
        for (auto* action : menu->actions()) if (action->text() == "Sair da conta Google") emit action->triggered();
        QCOMPARE(googleCalls, 1);
        menu->close();
    }
    void accountPopoverSignedOutOffersGoogleSignIn() {
        QWidget anchor; anchor.resize(56, 42); anchor.show();
        auto* menu = buildAccountPopover(&anchor, "camargo", "@offline", false, false, [] {}, [] {});
        QStringList rowTitles;
        for (auto* action : menu->actions()) if (!action->text().isEmpty()) rowTitles << action->text();
        QCOMPARE(rowTitles, QStringList({"Editar perfil", "Entrar com Google"}));
        menu->close();
    }
    void notificationBadgeMatchesMeasuredGeometryForOneAndThreeDigits() {
        // Geometry measured on the real Discord client (desktop/out/claude-observations/BADGES.md):
        // one digit -> 16x16 circle; three digits -> 30x16 pill, both with corner radius = height/2.
        NotificationBadge oneDigit; oneDigit.setCount(5);
        QCOMPARE(oneDigit.size(), QSize(16, 16));
        NotificationBadge threeDigits; threeDigits.setCount(303);
        QCOMPARE(threeDigits.height(), 16);
        QCOMPARE(threeDigits.width(), 30);
        NotificationBadge hidden; hidden.setCount(0);
        QVERIFY(!hidden.isVisible());
        oneDigit.resize(oneDigit.size()); oneDigit.show(); QCoreApplication::processEvents();
        const QImage image = oneDigit.grab().toImage();
        // Measured fill: #d22d39/#cf2d39, kept over the declared --status-danger token #f23f43 (close but
        // not identical per BADGES.md) following the project's "measured beats token" precedent.
        QCOMPARE(image.pixelColor(1, 8).red() > 180 && image.pixelColor(1, 8).green() < 70, true);
        QCOMPARE(image.pixelColor(0, 0), QColor(0, 0, 0, 0)); // corner stays outside the rounded fill
    }
    void loginScreenShownOnlyWithoutAValidSession() {
        AuthSession session;
        session.clearSession();
        QVERIFY(shouldShowLogin(session));
        session.setSignedIn("tok", "id-1", "a@example.org", "Nick", "", QDateTime::currentDateTimeUtc().addDays(1));
        QVERIFY(!shouldShowLogin(session));
        session.clearSession();
    }
    void loginCardMatchesMeasuredGeometry() {
        // Measured in out/claude-observations/LOGIN.md: card 784x412, button 414x38.
        AuthSession session;
        LoginWindow login(&session);
        auto* card = login.findChild<QWidget*>("loginCard");
        QVERIFY(card);
        QCOMPARE(card->size(), QSize(784, 412));
        auto* button = login.findChild<QPushButton*>("loginGoogleButton");
        QVERIFY(button);
        QCOMPARE(button->size(), QSize(414, 38));
    }
    void loginScreenHasNoEmailPasswordOrQrControls() {
        // Discord's login card has e-mail/password fields, a "Esqueceu sua
        // senha?"/"Registre-se" footer and a QR column; triscord has none of
        // those auth methods, so none of it should exist on this screen.
        AuthSession session;
        LoginWindow login(&session);
        QVERIFY(login.findChildren<QLineEdit*>().isEmpty());
        for (auto* label : login.findChildren<QLabel*>()) {
            const auto text = label->text().toLower();
            QVERIFY(!text.contains("senha"));
            QVERIFY(!text.contains("e-mail"));
            QVERIFY(!text.contains("qr"));
            QVERIFY(!text.contains("registre-se"));
        }
    }
    void loginFailureSurfacesAnErrorInsteadOfStayingSilent() {
        AuthSession session;
        LoginWindow login(&session);
        login.show();
        auto* status = login.findChild<QLabel*>("loginStatus");
        QVERIFY(status);
        QVERIFY(!status->isVisible());
        login.showStatus("Não foi possível entrar com o Google. Verifique sua conexão e tente novamente.");
        QVERIFY(status->isVisible());
        QVERIFY(!status->text().isEmpty());
    }
    void profileEditDialogLoadsValuesFromStubbedMeAndHasNoNitroUpsell() {
        StubAuthServer stub;
        const QJsonObject account{
            {"display_name", "Camargo"}, {"pronouns", "ele/dele"}, {"bio", "Oi, tudo bem?"},
            {"note", "nota privada"}, {"nameplate", ""}, {"avatar_decoration_url", ""},
            {"banner_color", "#112233"}, {"display_name_style", ""},
            {"profile_theme_start", ""}, {"profile_theme_end", ""}
        };
        stub.respond = [&](const QString& method, const QString& path, const QJsonObject&) {
            if (method == "GET" && path == "/me") return qMakePair(200, QJsonObject{{"account", account}});
            return qMakePair(404, QJsonObject{{"error", "not_found"}});
        };
        qputenv("TRISCORD_AUTH_SERVER", stub.url().toUtf8());
        AuthSession session;
        session.setSignedIn("tok-profile", "id-profile", "a@example.org", "Camargo", "",
                             QDateTime::currentDateTimeUtc().addDays(1));

        QString displayNameRead, bioRead;
        bool hasNitroText = false;
        QTimer::singleShot(30, [&] {
            QDialog* dialog = nullptr;
            for (auto* w : QApplication::topLevelWidgets()) {
                if (w->objectName() == "profileEditDialog") dialog = qobject_cast<QDialog*>(w);
            }
            QVERIFY(dialog);
            auto* nameEdit = dialog->findChild<QLineEdit*>("profileEdit_display_name");
            auto* bioEdit = dialog->findChild<QPlainTextEdit*>("profileEdit_bio");
            QVERIFY(nameEdit); QVERIFY(bioEdit);
            displayNameRead = nameEdit->text();
            bioRead = bioEdit->toPlainText();
            // Live card beside the form; nameplate (a shop SKU in Discord) is no longer a free-text field.
            auto* card = dialog->findChild<QWidget*>("profilePreviewCard");
            QVERIFY(card); QCOMPARE(card->width(), 400);
            QVERIFY(!dialog->findChild<QLineEdit*>("profileEdit_nameplate"));
            QStringList mediaButtons;
            for (auto* b : dialog->findChildren<QPushButton*>()) if (b->objectName().startsWith("profileMedia")) mediaButtons << b->text();
            QVERIFY(mediaButtons.contains("Mudar avatar")); QVERIFY(mediaButtons.contains("Remover avatar"));
            QVERIFY(mediaButtons.contains("Alterar imagem da faixa")); QVERIFY(mediaButtons.contains("Remover faixa"));
            const QImage before = card->grab().toImage();
            QCOMPARE(QColor(before.pixel(200, 70)), QColor("#112233")); // banner_color painted on the 400x140 banner
            nameEdit->setText("Outro Nome");
            QCoreApplication::processEvents();
            QVERIFY(card->grab().toImage() != before); // re-rendered while typing
            nameEdit->setText("Camargo");
            QVERIFY(dialog->grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-profile-editor-preview.png")));
            // Discord gates display_name_style/profile_theme_* behind a purple
            // "Eleve seu visual, somente com Nitro" panel with a lock icon and
            // an "Obter o Nitro" CTA (PERFIL.md); triscord must not reproduce it.
            for (auto* label : dialog->findChildren<QLabel*>()) {
                if (label->text().contains("Nitro", Qt::CaseInsensitive)) hasNitroText = true;
            }
            for (auto* button : dialog->findChildren<QPushButton*>()) {
                if (button->text().contains("Nitro", Qt::CaseInsensitive)) hasNitroText = true;
            }
            dialog->reject();
        });
        openProfileEditDialog(nullptr, session);
        QCOMPARE(displayNameRead, QString("Camargo"));
        QCOMPARE(bioRead, QString("Oi, tudo bem?"));
        QVERIFY(!hasNitroText);
        qunsetenv("TRISCORD_AUTH_SERVER");
        session.clearSession();
    }
    void profileEditPatchBodyOnlyContainsChangedFields() {
        const QJsonObject original{{"display_name", "Camargo"}, {"bio", "Oi"}, {"pronouns", ""}};
        QJsonObject current = original;
        current["bio"] = "Oi, tudo bem?";
        const auto body = buildProfilePatchBody(original, current);
        QCOMPARE(body.size(), 1);
        QVERIFY(body.contains("bio"));
        QCOMPARE(body.value("bio").toString(), QString("Oi, tudo bem?"));
        QVERIFY(!body.contains("display_name"));
        QVERIFY(!body.contains("pronouns"));
    }
    void profileEditClearingAFieldSendsNull() {
        const QJsonObject original{{"note", "nota antiga"}};
        const QJsonObject current{{"note", ""}};
        const auto body = buildProfilePatchBody(original, current);
        QVERIFY(body.contains("note"));
        QVERIFY(body.value("note").isNull());
    }
    void profileEditTooLongBioBlockedClientSide() {
        QVERIFY(validateProfileField("bio", QString(190, 'a')).isEmpty());
        QVERIFY(!validateProfileField("bio", QString(191, 'a')).isEmpty());
    }
    void profileEditInvalidColourBlockedClientSide() {
        QVERIFY(!validateProfileField("banner_color", "not-a-color").isEmpty());
        QVERIFY(!validateProfileField("profile_theme_start", "#12345").isEmpty());
        QVERIFY(validateProfileField("banner_color", "#112233").isEmpty());
    }
    void profileEditInvalidAvatarDecorationUrlBlockedClientSide() {
        QVERIFY(!validateProfileField("avatar_decoration_url", "http://not-https.example/x.png").isEmpty());
        QVERIFY(validateProfileField("avatar_decoration_url", "https://example.org/x.png").isEmpty());
        QVERIFY(validateProfileField("avatar_decoration_url", "").isEmpty());
    }
    void profileEditServerErrorIsSurfacedToTheUser() {
        StubAuthServer stub;
        const QJsonObject account{{"display_name", "Camargo"}, {"bio", ""}, {"pronouns", ""}, {"note", ""},
            {"nameplate", ""}, {"avatar_decoration_url", ""}, {"banner_color", ""},
            {"display_name_style", ""}, {"profile_theme_start", ""}, {"profile_theme_end", ""}};
        stub.respond = [&](const QString& method, const QString& path, const QJsonObject&) {
            if (method == "GET" && path == "/me") return qMakePair(200, QJsonObject{{"account", account}});
            if (method == "PATCH" && path == "/profile") {
                return qMakePair(400, QJsonObject{{"error", "invalid_field"}, {"field", "display_name"}});
            }
            return qMakePair(404, QJsonObject{{"error", "not_found"}});
        };
        qputenv("TRISCORD_AUTH_SERVER", stub.url().toUtf8());
        AuthSession session;
        session.setSignedIn("tok-profile-2", "id-profile-2", "b@example.org", "Camargo", "",
                             QDateTime::currentDateTimeUtc().addDays(1));

        QString errorSeen;
        QTimer::singleShot(30, [&] {
            QDialog* dialog = nullptr;
            for (auto* w : QApplication::topLevelWidgets()) {
                if (w->objectName() == "profileEditDialog") dialog = qobject_cast<QDialog*>(w);
            }
            QVERIFY(dialog);
            auto* nameEdit = dialog->findChild<QLineEdit*>("profileEdit_display_name");
            auto* save = dialog->findChild<QPushButton*>("profileEditSave");
            QVERIFY(nameEdit); QVERIFY(save);
            nameEdit->setText("Novo Nome");
            QTest::mouseClick(save, Qt::LeftButton);
            auto* error = dialog->findChild<QLabel*>("profileEditError");
            QVERIFY(error);
            QVERIFY(error->isVisible());
            errorSeen = error->text();
            dialog->reject();
        });
        const bool saved = openProfileEditDialog(nullptr, session);
        QVERIFY(!saved);
        QVERIFY(!errorSeen.isEmpty());
        qunsetenv("TRISCORD_AUTH_SERVER");
        session.clearSession();
    }
    void createServerDialogFollowsObservedSteps() {
        // Reference: desktop/out/claude-observations/SERVIDORES.md (discord-server-create-step1/3.png).
        HubApi hub;
        ServerDialog dialog(&hub, "camargo");
        dialog.show(); QCoreApplication::processEvents();
        QCOMPARE(dialog.width(), 444);
        auto* pages = dialog.findChild<QStackedWidget*>(); QVERIFY(pages);
        QCOMPARE(pages->currentIndex(), 0);
        auto labelTexts = [](QWidget* page) { QStringList texts; for (auto* l : page->findChildren<QLabel*>()) texts << l->text(); return texts; };
        QVERIFY(labelTexts(pages->currentWidget()).contains("Criar seu servidor"));
        QVERIFY(labelTexts(pages->currentWidget()).contains("Já tem um convite?"));
        QPushButton* own = nullptr; QPushButton* toJoin = nullptr;
        for (auto* b : pages->currentWidget()->findChildren<QPushButton*>()) {
            if (b->text() == "Criar o meu") own = b;
            if (b->text() == "Entrar em um servidor") toJoin = b;
        }
        QVERIFY(own && toJoin);
        QCOMPARE(own->height(), 54); QCOMPARE(toJoin->height(), 40);
        // Unobserved outcomes are not offered: no template rows.
        for (const auto& text : labelTexts(pages->currentWidget())) QVERIFY(!text.contains("MOLDE", Qt::CaseInsensitive));
        // The modal surface must be opaque inside its rounded corners (a translucent top-level skips QSS backgrounds).
        QCOMPARE(QColor(dialog.grab().toImage().pixel(100, 100)), QColor("#0a0a0c"));
        QVERIFY(dialog.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-server-create-step1.png")));
        own->click(); QCoreApplication::processEvents();
        QCOMPARE(pages->currentIndex(), 1);
        auto* name = dialog.findChild<QLineEdit*>("serverNameInput"); QVERIFY(name);
        QCOMPARE(name->text(), QString("Servidor de camargo")); // pt-BR "Servidor de {username}", as observed prefilled
        QCOMPARE(name->height(), 40);
        QPushButton* create = nullptr;
        for (auto* b : pages->currentWidget()->findChildren<QPushButton*>()) if (b->text() == "Criar") create = b;
        QVERIFY(create); QVERIFY(create->width() >= 100); QCOMPARE(create->height(), 40);
        name->clear(); QVERIFY(!create->isEnabled());
        name->setText("Servidor de camargo"); QVERIFY(create->isEnabled());
        QVERIFY(dialog.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-server-create-step3.png")));
        // Without a session the hub is never called and the error is shown instead of a silent failure.
        create->click(); QCoreApplication::processEvents();
        auto* error = pages->currentWidget()->findChild<QLabel*>("serverDialogError");
        QVERIFY(error && error->isVisible());
        QVERIFY(dialog.isVisible());
    }
    void profilePreviewShowsUploadedImagesAndPlaysAnimatedGif() {
        ProfilePreviewCard card;
        card.setUsername("camargo");
        QImage photo(64, 64, QImage::Format_RGB32); photo.fill(QColor("#00ff00"));
        QByteArray png; { QBuffer b(&png); b.open(QIODevice::WriteOnly); photo.save(&b, "PNG"); }
        card.setAvatarImage(png);
        QImage shot = card.grab().toImage();
        QCOMPARE(QColor(shot.pixel(92, 140)).green(), 255); // centre of the 120px avatar
        card.setBannerImage(png);
        shot = card.grab().toImage();
        QCOMPARE(QColor(shot.pixel(200, 70)), QColor("#00ff00"));
        // Two-frame 2x2 GIF89a (generated with Pillow; Qt has no GIF writer).
        const QByteArray gif = QByteArray::fromHex("4749463839610200020081000000000000000000000000000021ff0b4e45545343415045322e30030100000021f904000a0000002c00000000020002000008060001080410100021f904010a0001002c000000000200020081ffff000000000000000000000806000108041010003b");
        card.setAvatarImage(gif);
        QVERIFY(card.avatarAnimated());
        auto* movie = card.findChild<QMovie*>();
        QVERIFY(movie);
        QSignalSpy frames(movie, &QMovie::frameChanged);
        // Two frames per cycle: five changes prove that a seekable QBuffer
        // still loops after removing QMovie's unbounded decoded-frame cache.
        QTRY_VERIFY_WITH_TIMEOUT(frames.count() >= 5, 2000);
        card.setAvatarImage({});
        QVERIFY(!card.avatarAnimated());
        QImage narrow(1, 4096, QImage::Format_RGB32); narrow.fill(QColor("#00ff00"));
        QByteArray narrowPng;
        { QBuffer b(&narrowPng); b.open(QIODevice::WriteOnly); narrow.save(&b, "PNG"); }
        card.setAvatarImage(narrowPng);
        card.setBannerImage(narrowPng);
        shot = card.grab().toImage();
        QCOMPARE(QColor(shot.pixel(92, 140)), QColor("#00ff00"));
        QCOMPARE(QColor(shot.pixel(200, 70)), QColor("#00ff00"));
    }
    void joinServerPageFollowsRecoveredDiscordSlide() {
        // Reference: REA_CLAUDE_20261016.md (JOIN_GUILD slide, assets/4be9909f40fba94b.js + 2d1f7e43168351af.css).
        HubApi hub;
        ServerDialog dialog(&hub, "camargo");
        dialog.show(); QCoreApplication::processEvents();
        auto* pages = dialog.findChild<QStackedWidget*>();
        for (auto* b : pages->widget(0)->findChildren<QPushButton*>()) if (b->text() == "Entrar em um servidor") b->click();
        QCoreApplication::processEvents();
        QCOMPARE(pages->currentIndex(), 2);
        QStringList texts; for (auto* l : pages->currentWidget()->findChildren<QLabel*>()) texts << l->text();
        QVERIFY(texts.contains("Insira um convite abaixo para entrar em um servidor existente"));
        QVERIFY(texts.contains("Convites devem ser mais ou menos assim"));
        QPushButton* join = nullptr; QPushButton* sample = nullptr;
        for (auto* b : pages->currentWidget()->findChildren<QPushButton*>()) {
            if (b->text() == "Entrar no servidor") join = b;
            if (b->objectName() == "serverDialogSample") sample = b;
        }
        QVERIFY(join && sample);
        auto* input = dialog.findChild<QLineEdit*>("inviteCodeInput");
        join->click(); QCoreApplication::processEvents();
        auto* error = pages->currentWidget()->findChild<QLabel*>("serverDialogError");
        QVERIFY(error->isVisible());
        QCOMPARE(error->text(), QString("Insira um link de convite ou um código de convite válido."));
        sample->click();
        QCOMPARE(input->text(), sample->text()); // samples fill the field, as in Discord
        QVERIFY(dialog.grab().save(QDir(QCoreApplication::applicationDirPath()).filePath("../native-server-join.png")));
    }
    void serverAcronymTileUsesDiscordAcronym() {
        const QImage tile = ServerRail::acronymTile("Servidor de camargo", 1.0).toImage();
        QCOMPARE(tile.size(), QSize(40, 40));
        QCOMPARE(QColor(tile.pixel(1, 1)), QColor("#1e1e20"));
        int bright = 0;
        for (int y = 0; y < 40; ++y) for (int x = 0; x < 40; ++x) if (qGray(tile.pixel(x, y)) > 150) ++bright;
        QVERIFY(bright > 20); // "Sdc" drawn in --text-default
    }
    void cleanupTestCase() { QSettings().clear(); }
};
QTEST_MAIN(UiTests)
#include "ui_tests.moc"
