#pragma once
#include "hub_api.h"
#include <QDialog>

class QLabel;
class QLineEdit;
class QPushButton;
class QStackedWidget;

namespace triscord {

// "Criar seu servidor" modal opened by the rail's "Adicionar um servidor" button
// (desktop/out/claude-observations/SERVIDORES.md, captures discord-server-create-step1/3.png).
//
// Observed and reproduced: step 1 (title, subtitle, "Criar o meu" row with chevron, "Já tem um convite?",
// full-width "Entrar em um servidor") and step 3 ("Personalize o seu servidor", "Nome do servidor *"
// prefilled with "Servidor de <nome>", "Voltar" and "Criar"). Geometry: 444px wide modal with a 1px border,
// 402x54 option rows, 40px inputs/buttons, 100x40 "Criar". Colours are the theme-dark samples translated
// to theme-midnight through the tokens in rea-css/TOKENS.md.
//
// Left out on purpose: step 2 (community/friends question - it configures nothing in triscord), the
// template list ("Começar de um molde": what each template creates was never observed), the icon upload
// circle (the hub has no server icon storage yet), the "diretrizes da comunidade" footer (no triscord
// document behind it) and the illustrated row icon (a Discord asset).
//
// Invite page ("JOIN_GUILD" slide): recovered statically with REA from Discord's own chunk
// assets/4be9909f40fba94b.js (SHA-256 e29aa67d...; module 812633, component H) and its stylesheet
// assets/2d1f7e43168351af.css (classes *__991a0), read from the Chromium disk cache, never executed:
//   header centred, close button 12px from the top/right, title heading-xl bold (margin 24 top, 8 bottom),
//   subtitle text-sm "Insira um convite abaixo para entrar em um servidor existente" (no final period);
//   required "Link de convite" field (error shown in the field, --text-feedback-critical), 16px under it
//   "Convites devem ser mais ou menos assim" (text-sm/medium, --text-subtle) and clickable sample chips
//   that fill the field (14px/18px, 4px padding and margin, radius 4, --background-mod-muted with a
//   --border-muted border); footer: primary "Entrar no servidor" + "Voltar".
//   Errors: empty -> "Insira um link de convite ou um código de convite válido."; dead invite ->
//   "O convite expirou ou não é mais válido."; anything else -> "Não foi possível aceitar o convite".
// Left out: the "Não tem um convite?" Discovery row (no triscord function). Discord's three samples are a
// bare code and two discord.gg links; triscord has no invite link host, so it shows one bare code.
// Not observed visually: this page was rebuilt from code + CSS, not from a capture.
class ServerDialog final : public QDialog {
    Q_OBJECT
public:
    ServerDialog(HubApi* hub, const QString& displayName, QWidget* parent = nullptr);

signals:
    // The account now belongs to `server` (created, or joined via invite: name may be empty then).
    void serverReady(const triscord::HubServer& server);

protected:
    void paintEvent(QPaintEvent* event) override;

private:
    void showError(QLabel* label, int status, bool invite);
    void fitToPage();
    HubApi* hub_;
    QStackedWidget* pages_;
    QLineEdit* name_;
    QLineEdit* invite_;
    QLabel* createError_;
    QLabel* joinError_;
    QPushButton* create_;
    QPushButton* join_;
};

} // namespace triscord
