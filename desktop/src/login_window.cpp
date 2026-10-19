#include "login_window.h"
#include "auth_session.h"
#include "google_auth.h"
#include "nick_dialog.h"

#include <QDateTime>
#include <QHBoxLayout>
#include <QLabel>
#include <QLinearGradient>
#include <QPainter>
#include <QPushButton>
#include <QVBoxLayout>

namespace triscord {

bool shouldShowLogin(const AuthSession& session) {
    return !session.isValid();
}

LoginWindow::LoginWindow(AuthSession* session, QWidget* parent)
    : QWidget(parent), session_(session) {
    setObjectName("loginWindow");
    setWindowTitle("Triscord");
    resize(1280, 900);
    setMinimumSize(560, 480);

    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    outer->addStretch(1);

    // Card: 784x412, fill #242429, 8px corner radius — measured in
    // out/claude-observations/LOGIN.md ("Cartão central").
    card_ = new QWidget(this);
    card_->setObjectName("loginCard");
    card_->setFixedSize(784, 412);
    card_->setStyleSheet("QWidget#loginCard { background:#242429; border-radius:8px; }");

    auto* cardLayout = new QVBoxLayout(card_);
    cardLayout->setContentsMargins(185, 100, 185, 100);
    cardLayout->setSpacing(12);
    cardLayout->addStretch(1);

    // Title/subtitle colours and centring per LOGIN.md's "Coluna esquerda":
    // #f2f2f2 title, #bababc subtitle, both centred. No e-mail/password
    // fields are built below: triscord authenticates only with Google.
    auto* title = new QLabel("Bem-vindo de volta!", card_);
    title->setObjectName("loginTitle");
    title->setAlignment(Qt::AlignCenter);
    title->setWordWrap(true);
    title->setStyleSheet("color:#f2f2f2; font-size:20px; font-weight:600;");
    cardLayout->addWidget(title);

    auto* subtitle = new QLabel("Entre com sua conta Google para continuar.", card_);
    subtitle->setObjectName("loginSubtitle");
    subtitle->setAlignment(Qt::AlignCenter);
    subtitle->setWordWrap(true);
    subtitle->setStyleSheet("color:#bababc; font-size:14px;");
    cardLayout->addWidget(subtitle);

    cardLayout->addSpacing(8);

    status_ = new QLabel(card_);
    status_->setObjectName("loginStatus");
    status_->setAlignment(Qt::AlignCenter);
    status_->setWordWrap(true);
    status_->setStyleSheet("color:#f39a96; font-size:12px;");
    status_->hide();
    cardLayout->addWidget(status_);

    // Button: 414x38, #5865f2 (= --brand-500), ~6px radius — the one control
    // this card actually needs, filling the role Discord's "Entrar" button
    // plays, but wired to the Google OAuth flow triscord actually has.
    googleButton_ = new QPushButton("Entrar com Google", card_);
    googleButton_->setObjectName("loginGoogleButton");
    googleButton_->setFixedSize(414, 38);
    googleButton_->setCursor(Qt::PointingHandCursor);
    googleButton_->setStyleSheet(
        "QPushButton#loginGoogleButton { background:#5865f2; color:#ffffff; border:0; border-radius:6px; font-weight:600; }"
        "QPushButton#loginGoogleButton:hover { background:#4752c4; }"
        "QPushButton#loginGoogleButton:disabled { background:#3b3d44; color:#8e8e93; }");
    connect(googleButton_, &QPushButton::clicked, this, &LoginWindow::beginGoogleSignIn);
    cardLayout->addWidget(googleButton_, 0, Qt::AlignHCenter);

    cardLayout->addStretch(1);

    auto* cardRow = new QHBoxLayout();
    cardRow->addStretch(1);
    cardRow->addWidget(card_);
    cardRow->addStretch(1);
    outer->addLayout(cardRow);
    outer->addStretch(1);
}

void LoginWindow::paintEvent(QPaintEvent*) {
    // The background is documented in LOGIN.md as an animated gradient but
    // the capture is only a single frame (#18004d left, #2b3dc4 right); the
    // animation itself is listed there as unknown. A static horizontal
    // gradient between those two measured samples is used instead of
    // inventing motion.
    QPainter painter(this);
    QLinearGradient gradient(QPointF(0, 0), QPointF(width(), 0));
    gradient.setColorAt(0.0, QColor("#18004d"));
    gradient.setColorAt(1.0, QColor("#2b3dc4"));
    painter.fillRect(rect(), gradient);
}

void LoginWindow::showStatus(const QString& message) {
    status_->setText(message);
    status_->show();
}

void LoginWindow::beginGoogleSignIn() {
    status_->hide();
    googleButton_->setEnabled(false);
    googleButton_->setText("Conectando...");

    auto* flow = new GoogleAuthFlow(this);
    connect(flow, &GoogleAuthFlow::succeeded, this, [this, flow](const GoogleIdentity& identity) {
        flow->deleteLater();
        googleButton_->setEnabled(true);
        googleButton_->setText("Entrar com Google");
        auto nick = identity.nick;
        if (identity.isNew) {
            const auto suggested = identity.email.section('@', 0, 0).left(32);
            nick = chooseNickDialog(this, identity.session, nick.isEmpty() ? suggested : nick);
            if (nick.isEmpty()) nick = suggested; // user cancelled the dialog but is already signed in.
        }
        session_->setSignedIn(identity.session, identity.id, identity.email, nick, identity.avatarUrl,
                               QDateTime::fromString(identity.expiresAt, Qt::ISODate));
        emit signedIn();
    });
    connect(flow, &GoogleAuthFlow::failed, this, [this, flow](const QString& reason) {
        flow->deleteLater();
        googleButton_->setEnabled(true);
        googleButton_->setText("Entrar com Google");
        if (reason == "missing-client-secret") {
            showStatus("Login com Google indisponível: configuração ausente (TRISCORD_GOOGLE_CLIENT_SECRET).");
        } else if (reason == "cancelled") {
            showStatus("Login cancelado.");
        } else {
            showStatus("Não foi possível entrar com o Google. Verifique sua conexão e tente novamente.");
        }
    });
    flow->start();
}

} // namespace triscord
