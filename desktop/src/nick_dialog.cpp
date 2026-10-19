#include "nick_dialog.h"
#include "auth_session.h"

#include <QDialog>
#include <QEventLoop>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPushButton>
#include <QVBoxLayout>

namespace triscord {
namespace {

// Posts a candidate nick to /nick. Returns the server's error code (e.g.
// "nick_taken") on failure, or an empty string on success.
QString postNick(const QString& sessionToken, const QString& nick) {
    QNetworkAccessManager network;
    QNetworkRequest request(QUrl(authServerUrl() + "/nick"));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Authorization", "Bearer " + sessionToken.toUtf8());
    QJsonObject body; body["nick"] = nick;
    auto* reply = network.post(request, QJsonDocument(body).toJson(QJsonDocument::Compact));
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    reply->deleteLater();
    const auto doc = QJsonDocument::fromJson(reply->readAll());
    const auto object = doc.object();
    if (reply->error() == QNetworkReply::NoError && !object.value("account").toObject().isEmpty()) {
        return {};
    }
    const auto error = object.value("error").toString();
    return error.isEmpty() ? QStringLiteral("unknown_error") : error;
}

QString errorMessage(const QString& code) {
    if (code == "nick_taken") return "Esse nome já está em uso. Escolha outro.";
    if (code.isEmpty()) return {};
    return "Não foi possível salvar o nome. Tente novamente.";
}

} // namespace

QString chooseNickDialog(QWidget* parent, const QString& sessionToken, const QString& suggestedNick) {
    QDialog dialog(parent);
    dialog.setObjectName("nickChooserDialog");
    dialog.setWindowTitle("Escolha seu nome no Triscord");
    dialog.setModal(true);
    dialog.setStyleSheet(
        "QDialog#nickChooserDialog { background:#1e1f22; }"
        "QLabel { color:#dcdcdf; font-size:14px; }"
        "QLabel#nickChooserError { color:#f39a96; font-size:12px; }"
        "QLineEdit { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px;"
        "            padding:8px 12px; color:#d4d5d8; font-size:16px; }"
        "QPushButton#nickChooserContinue { background:#5865f2; color:#ffffff; border:0; border-radius:8px;"
        "                                  padding:10px; font-weight:600; }"
        "QPushButton#nickChooserContinue:disabled { background:#3b3d44; color:#8e8e93; }");
    auto* layout = new QVBoxLayout(&dialog);
    layout->setContentsMargins(24, 24, 24, 24);
    layout->addWidget(new QLabel("Como você quer ser chamado?", &dialog));
    auto* name = new QLineEdit(&dialog);
    name->setObjectName("nickChooserInput");
    name->setPlaceholderText("Seu nome");
    name->setMaxLength(32);
    name->setText(suggestedNick);
    layout->addWidget(name);
    auto* error = new QLabel(&dialog);
    error->setObjectName("nickChooserError");
    error->hide();
    layout->addWidget(error);
    auto* enter = new QPushButton("Continuar", &dialog);
    enter->setObjectName("nickChooserContinue");
    enter->setDefault(true);
    enter->setEnabled(name->text().trimmed().size() >= 2);
    layout->addWidget(enter);

    QObject::connect(name, &QLineEdit::textChanged, enter, [enter](const QString& text) {
        enter->setEnabled(text.trimmed().size() >= 2);
    });

    QString chosen;
    QObject::connect(enter, &QPushButton::clicked, &dialog, [&] {
        const auto candidate = name->text().trimmed();
        if (candidate.size() < 2) return;
        enter->setEnabled(false);
        const auto errorCode = postNick(sessionToken, candidate);
        enter->setEnabled(true);
        if (errorCode.isEmpty()) {
            chosen = candidate;
            dialog.accept();
            return;
        }
        error->setText(errorMessage(errorCode));
        error->show();
    });

    dialog.exec();
    return chosen;
}

} // namespace triscord
