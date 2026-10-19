#include "server_dialog.h"
#include "discord_icons.h"
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QStackedWidget>
#include <QVBoxLayout>

namespace triscord {
namespace {

// theme-dark samples -> theme-midnight (rea-css/TOKENS.md):
//   modal #393a41 (--background-surface-high)        -> #0a0a0c
//   modal border #4c4c54 (--border-normal over modal) -> #2c2c2f
//   option row #414148 (--interactive-background-default over modal) -> #151517, its 1px border -> #2f2f31
//   secondary button #44454c (--background-mod-normal over modal)     -> #262629
//   text #f3f3f4 (--text-default) -> #d4d5d8; headings #ffffff (--text-strong) -> #dcdcdf
//   input #35353c: no token composites to it; kept one step below the modal surface (#050506), inferred.
constexpr auto kStyle = R"(
QDialog#serverDialog { background:transparent; }
QLabel { color:#d4d5d8; font-size:16px; background:transparent; }
QLabel#serverDialogTitle { color:#dcdcdf; font-size:24px; font-weight:700; }
QLabel#serverDialogQuestion { color:#dcdcdf; font-size:20px; font-weight:700; }
QLabel#serverDialogLabel { color:#dcdcdf; font-size:16px; font-weight:600; }
QLabel#serverDialogHint { color:#96979e; font-size:12px; }
QLabel#serverDialogError { color:#eb5f5e; font-size:14px; }
QLabel#serverDialogSampleTitle { color:#96979e; font-size:14px; font-weight:500; }
QPushButton#serverDialogSample { background:rgba(151,151,159,0.078); border:1px solid rgba(151,151,159,0.161); border-radius:4px;
    color:#dcdcdf; font-size:14px; padding:4px; text-align:left; }
QPushButton#serverDialogOption { background:#151517; border:1px solid #2f2f31; border-radius:8px; color:#dcdcdf;
    font-size:16px; font-weight:500; text-align:left; padding:0 16px; }
QPushButton#serverDialogOption:hover { background:#1c1c1f; }
QPushButton#serverDialogSecondary { background:#262629; border:1px solid #2c2c2f; border-radius:8px; color:#dcdcdf;
    font-size:16px; font-weight:500; }
QPushButton#serverDialogSecondary:hover { background:#2e2e31; }
QPushButton#serverDialogPrimary { background:#5865f2; border:0; border-radius:8px; color:#ffffff; font-size:16px; font-weight:500; }
QPushButton#serverDialogPrimary:hover { background:#4752c4; }
QPushButton#serverDialogPrimary:disabled { background:#2c2d35; color:#81828a; }
QPushButton#serverDialogBack { background:transparent; border:0; color:#dcdcdf; font-size:16px; font-weight:600; padding:0; }
QPushButton#serverDialogClose { background:transparent; border:0; }
QLineEdit { background:#050506; border:1px solid #2c2c2f; border-radius:8px; color:#d4d5d8; font-size:16px; padding:0 12px; }
QLineEdit:focus { border:2px solid #5865f2; padding:0 11px; }
)";

QLabel* centred(const QString& text, const char* name, QWidget* parent) {
    auto* label = new QLabel(text, parent);
    label->setObjectName(name);
    label->setAlignment(Qt::AlignHCenter);
    label->setWordWrap(true);
    return label;
}

// Title block shared by every page. Observed in the 444px modal: X (24px glyph) at x 398, y 16, on the
// title's row; 24px heading starting 16px from the top; 16px subtitle 8px under it. Content padding is 24px
// on the left and 16px on the right (the right side keeps the scroll gutter).
QVBoxLayout* pageLayout(QWidget* page, QDialog* dialog, const QString& title, const QString& subtitle) {
    auto* layout = new QVBoxLayout(page);
    layout->setContentsMargins(24, 16, 16, 16);
    layout->setSpacing(8);
    layout->addWidget(centred(title, "serverDialogTitle", page));
    layout->addWidget(centred(subtitle, "serverDialogSubtitle", page));
    auto* close = new QPushButton(page);
    close->setObjectName("serverDialogClose");
    close->setFixedSize(24, 24);
    close->setIconSize(QSize(24, 24));
    close->setIcon(DiscordIcons::icon(DiscordIcons::IconType::Close, QColor("#96979e"), 24));
    close->setCursor(Qt::PointingHandCursor);
    close->move(397, 15); // modal (398,16) minus the 1px border around the pages
    close->raise();
    QObject::connect(close, &QPushButton::clicked, dialog, &QDialog::reject);
    return layout;
}

QHBoxLayout* footer(QWidget* page, QPushButton* back, QPushButton* primary) {
    auto* row = new QHBoxLayout;
    row->setContentsMargins(0, 0, 0, 0);
    back->setObjectName("serverDialogBack");
    back->setCursor(Qt::PointingHandCursor);
    primary->setObjectName("serverDialogPrimary");
    primary->setCursor(Qt::PointingHandCursor);
    primary->setMinimumSize(100, 40);
    row->addWidget(back);
    row->addStretch(1);
    row->addWidget(primary);
    Q_UNUSED(page);
    return row;
}

} // namespace

ServerDialog::ServerDialog(HubApi* hub, const QString& displayName, QWidget* parent) : QDialog(parent), hub_(hub) {
    setObjectName("serverDialog");
    setWindowTitle("Criar seu servidor");
    setWindowFlags(Qt::Dialog | Qt::FramelessWindowHint);
    setAttribute(Qt::WA_StyledBackground);
    setAttribute(Qt::WA_TranslucentBackground); // lets the stylesheet's 8px radius show at the corners
    setModal(true);
    setFixedWidth(444);
    setStyleSheet(kStyle);
    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(1, 1, 1, 1);
    pages_ = new QStackedWidget(this);
    outer->addWidget(pages_);

    // Step 1 - "Criar seu servidor" (observed).
    auto* start = new QWidget(pages_);
    auto* startLayout = pageLayout(start, this, "Criar seu servidor",
        "Seu servidor é onde você e seus amigos se reúnem. Crie o seu e comece a interagir.");
    startLayout->addSpacing(32);
    auto* own = new QPushButton("Criar o meu", start);
    own->setObjectName("serverDialogOption");
    own->setFixedHeight(54);
    own->setCursor(Qt::PointingHandCursor);
    own->setLayoutDirection(Qt::RightToLeft); // chevron at the right edge, as observed
    own->setIcon(DiscordIcons::icon(DiscordIcons::IconType::ChevronSmallRight, QColor("#96979e"), 24));
    own->setIconSize(QSize(24, 24));
    startLayout->addWidget(own);
    startLayout->addSpacing(16);
    startLayout->addWidget(centred("Já tem um convite?", "serverDialogQuestion", start));
    auto* toJoin = new QPushButton("Entrar em um servidor", start);
    toJoin->setObjectName("serverDialogSecondary");
    toJoin->setFixedHeight(40);
    toJoin->setCursor(Qt::PointingHandCursor);
    startLayout->addWidget(toJoin);
    startLayout->addStretch(1);
    pages_->addWidget(start);

    // Step 3 - "Personalize o seu servidor" (observed; icon upload and guidelines footer left out).
    auto* customize = new QWidget(pages_);
    auto* customizeLayout = pageLayout(customize, this, "Personalize o seu servidor",
        "Deixe seu novo servidor com a sua cara dando um nome e um ícone a ele. Se quiser, é possível mudar depois.");
    customizeLayout->addSpacing(24);
    auto* nameLabel = new QLabel("Nome do servidor <span style='color:#eb5f5e'>*</span>", customize);
    nameLabel->setObjectName("serverDialogLabel");
    nameLabel->setTextFormat(Qt::RichText);
    customizeLayout->addWidget(nameLabel);
    name_ = new QLineEdit(customize);
    name_->setObjectName("serverNameInput");
    name_->setFixedHeight(40);
    name_->setMaxLength(32); // sanitizeRoomName limit on the hub
    // Discord pt-BR "Servidor de {username}" (locale keys Y6Qfju / xhgNd0).
    name_->setText(QString("Servidor de %1").arg(displayName).left(32));
    customizeLayout->addWidget(name_);
    createError_ = new QLabel(customize); createError_->setObjectName("serverDialogError"); createError_->setWordWrap(true); createError_->hide();
    customizeLayout->addWidget(createError_);
    customizeLayout->addSpacing(24);
    auto* backFromCreate = new QPushButton("Voltar", customize);
    create_ = new QPushButton("Criar", customize);
    customizeLayout->addLayout(footer(customize, backFromCreate, create_));
    customizeLayout->addStretch(1);
    pages_->addWidget(customize);

    // Invite page - recovered from Discord's JOIN_GUILD slide (see server_dialog.h for the sources).
    auto* joinPage = new QWidget(pages_);
    auto* joinLayout = pageLayout(joinPage, this, "Entrar em um servidor",
        "Insira um convite abaixo para entrar em um servidor existente");
    joinPage->findChild<QPushButton*>("serverDialogClose")->move(399, 11); // closeButton__991a0: 12px top/right
    joinLayout->insertSpacing(0, 8); // title__991a0 margin-top 24 (layout top margin is 16)
    joinLayout->addSpacing(16);
    auto* inviteLabel = new QLabel("Link de convite <span style='color:#eb5f5e'>*</span>", joinPage);
    inviteLabel->setObjectName("serverDialogLabel");
    inviteLabel->setTextFormat(Qt::RichText);
    joinLayout->addWidget(inviteLabel);
    invite_ = new QLineEdit(joinPage);
    invite_->setObjectName("inviteCodeInput");
    invite_->setFixedHeight(40);
    invite_->setMaxLength(256);
    const QString sampleCode = "3f9c2a7e5b1d4c8fa06e2b9d7c1f4a53";
    invite_->setPlaceholderText(sampleCode); // Discord: the sample link as placeholder
    joinLayout->addWidget(invite_);
    joinError_ = new QLabel(joinPage); joinError_->setObjectName("serverDialogError"); joinError_->setWordWrap(true); joinError_->hide();
    joinLayout->addWidget(joinError_);
    joinLayout->addSpacing(8); // inputForm margin-bottom 16 with the 8px layout spacing
    auto* sampleTitle = new QLabel("Convites devem ser mais ou menos assim", joinPage);
    sampleTitle->setObjectName("serverDialogSampleTitle");
    joinLayout->addWidget(sampleTitle);
    auto* samples = new QHBoxLayout(); samples->setContentsMargins(0, 4, 0, 4); // sampleLinks padding 8 0, chip margin 4
    auto* sample = new QPushButton(sampleCode, joinPage);
    sample->setObjectName("serverDialogSample");
    sample->setCursor(Qt::PointingHandCursor);
    connect(sample, &QPushButton::clicked, this, [this, sampleCode] { invite_->setText(sampleCode); invite_->setFocus(); });
    samples->addWidget(sample);
    samples->addStretch(1);
    joinLayout->addLayout(samples);
    joinLayout->addSpacing(16);
    auto* backFromJoin = new QPushButton("Voltar", joinPage);
    join_ = new QPushButton("Entrar no servidor", joinPage);
    join_->setMinimumWidth(150);
    joinLayout->addLayout(footer(joinPage, backFromJoin, join_));
    joinLayout->addStretch(1);
    pages_->addWidget(joinPage);

    auto showPage = [this](int index) {
        // A QStackedWidget sizes to its largest page; ignore the hidden ones so the modal hugs the visible page.
        for (int i = 0; i < pages_->count(); ++i)
            pages_->widget(i)->setSizePolicy(QSizePolicy::Preferred, i == index ? QSizePolicy::Preferred : QSizePolicy::Ignored);
        pages_->setCurrentIndex(index);
        fitToPage();
        if (index == 1) { name_->setFocus(); name_->selectAll(); }
        if (index == 2) invite_->setFocus();
    };
    connect(own, &QPushButton::clicked, this, [showPage] { showPage(1); });
    connect(toJoin, &QPushButton::clicked, this, [showPage] { showPage(2); });
    connect(backFromCreate, &QPushButton::clicked, this, [showPage] { showPage(0); });
    connect(backFromJoin, &QPushButton::clicked, this, [showPage] { showPage(0); });
    connect(name_, &QLineEdit::textChanged, this, [this](const QString& text) { create_->setEnabled(!text.trimmed().isEmpty()); });
    connect(name_, &QLineEdit::returnPressed, create_, &QPushButton::click);
    connect(invite_, &QLineEdit::returnPressed, join_, &QPushButton::click);

    connect(create_, &QPushButton::clicked, this, [this] {
        const auto name = name_->text().trimmed();
        if (name.isEmpty()) return;
        create_->setEnabled(false);
        createError_->hide();
        hub_->createServer(name, [this](int status, const HubServer& server) {
            create_->setEnabled(true);
            if (status != 201 || server.id.isEmpty()) { showError(createError_, status, false); return; }
            emit serverReady(server);
            accept();
        });
    });
    connect(join_, &QPushButton::clicked, this, [this] {
        const auto code = HubApi::extractInviteCode(invite_->text());
        joinError_->hide();
        if (invite_->text().trimmed().isEmpty()) { showError(joinError_, -1, true); return; }
        if (code.isEmpty()) { showError(joinError_, 410, true); return; }
        join_->setEnabled(false);
        hub_->acceptInvite(code, [this](int status, const QString& serverId) {
            join_->setEnabled(true);
            if (status != 200 || serverId.isEmpty()) { showError(joinError_, status, true); return; }
            emit serverReady(HubServer{serverId, {}, {}});
            accept();
        });
    });
    showPage(0);
}

void ServerDialog::paintEvent(QPaintEvent*) {
    // A translucent top-level does not paint its stylesheet background, so the rounded modal surface
    // (#0a0a0c, 1px #2c2c2f border, radius 8) is painted here.
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    QPainterPath path; path.addRoundedRect(QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5), 8, 8);
    p.fillPath(path, QColor("#0a0a0c"));
    p.setPen(QPen(QColor("#2c2c2f"), 1));
    p.drawPath(path);
}

void ServerDialog::fitToPage() {
    // Wrapped labels need the real width to report their height; the modal width is fixed at 444.
    layout()->invalidate();
    layout()->activate();
    setFixedHeight(layout()->hasHeightForWidth() ? layout()->totalHeightForWidth(width()) : layout()->totalSizeHint().height());
}

void ServerDialog::showError(QLabel* label, int status, bool invite) {
    QString text;
    // Invite texts are the JOIN_GUILD slide's own messages (locale IRq5ah, GEYI+Z, dDZRdy).
    if (invite && status == -1) text = "Insira um link de convite ou um código de convite válido.";
    else if (invite && (status == 410 || status == 400)) text = "O convite expirou ou não é mais válido.";
    else if (invite && status != 404 && status != 401 && status != 0) text = "Não foi possível aceitar o convite";
    else if (status == 401) text = "Sua sessão expirou. Entre com o Google de novo.";
    else if (status == 404) text = "O servidor de sinalização publicado ainda não oferece servidores. Atualize o Worker do hub.";
    else if (status == 0) text = "Sem conexão com o servidor. Tente novamente.";
    else text = "Não foi possível concluir agora. Tente novamente.";
    label->setText(text);
    label->show();
    fitToPage();
}

} // namespace triscord
