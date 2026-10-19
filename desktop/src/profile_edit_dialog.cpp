#include "profile_edit_dialog.h"
#include "auth_session.h"
#include "profile_preview.h"
#include "profile_media.h"
#include <QFile>
#include <QFileDialog>

#include <QDialog>
#include <QEventLoop>
#include <QFrame>
#include <QJsonDocument>
#include <QLabel>
#include <QLineEdit>
#include <QMap>
#include <QPlainTextEdit>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QPushButton>
#include <QScrollArea>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QRegularExpression>
#include <QUrl>

namespace triscord {
namespace {

// Limits mirrored exactly from cloudflare-auth/src/worker.js PROFILE_FIELDS
// so the user is never rejected server-side after passing client validation.
constexpr int kMaxDisplayName = 32;
constexpr int kMaxPronouns = 40;
constexpr int kMaxBio = 190;
constexpr int kMaxNote = 256;
constexpr int kMaxNameplate = 128;
constexpr int kMaxAvatarDecorationUrl = 512;

const QRegularExpression kHexColorRe("^#[0-9a-fA-F]{6}$");
const QRegularExpression kDisplayNameStyleRe("^[A-Za-z0-9_-]{1,32}$");

// Every editable field this screen exposes, in the order PERFIL.md observed
// them (nameplate/avatar/banner first as "painel esquerdo", then the
// display-name-style and profile-theme fields that are Nitro-gated in real
// Discord but free in triscord, then the central-card fields).
// "nameplate" is deliberately absent: the Discord bundle models it as a collectibles-shop item with its
// own SKU (nameplate_sku_id, EDIT_NAMEPLATE_MODAL, COLLECTIBLES_SHOP_...NAMEPLATES_TAB; see
// rea-css/PERFIL_BUNDLE.md), not free text. triscord has no catalogue of nameplates to pick from, so a
// free-text box only stored a string nothing renders. The editor no longer offers or sends it; the
// server column stays untouched for a future catalogue.
const QStringList kFieldOrder = {
    "avatar_decoration_url", "banner_color",
    "display_name_style", "profile_theme_start", "profile_theme_end",
    "display_name", "pronouns", "bio", "note"
};

QString postJson(const QString& sessionToken, const QString& method, const QString& path,
                  const QJsonObject& body, int* statusOut, QJsonObject* responseOut) {
    QNetworkAccessManager network;
    QNetworkRequest request(QUrl(authServerUrl() + path));
    request.setHeader(QNetworkRequest::ContentTypeHeader, "application/json");
    request.setRawHeader("Authorization", "Bearer " + sessionToken.toUtf8());
    QNetworkReply* reply = nullptr;
    const auto payload = QJsonDocument(body).toJson(QJsonDocument::Compact);
    if (method == "GET") {
        reply = network.get(request);
    } else {
        reply = network.sendCustomRequest(request, "PATCH", payload);
    }
    QEventLoop loop;
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    loop.exec();
    reply->deleteLater();
    if (statusOut) *statusOut = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const auto doc = QJsonDocument::fromJson(reply->readAll());
    if (responseOut) *responseOut = doc.object();
    if (reply->error() != QNetworkReply::NoError && *statusOut == 0) return "network_error";
    return {};
}

} // namespace

QString validateProfileField(const QString& key, const QString& value) {
    if (key == "display_name") {
        if (value.size() > kMaxDisplayName) return "Nome de exibição muito longo (máximo 32 caracteres).";
        return {};
    }
    if (key == "pronouns") {
        if (value.size() > kMaxPronouns) return "Pronomes muito longos (máximo 40 caracteres).";
        return {};
    }
    if (key == "bio") {
        if (value.size() > kMaxBio) return "Bio muito longa (máximo 190 caracteres).";
        return {};
    }
    if (key == "note") {
        if (value.size() > kMaxNote) return "Nota muito longa (máximo 256 caracteres).";
        return {};
    }
    if (key == "nameplate") {
        if (value.size() > kMaxNameplate) return "Placa de identificação muito longa (máximo 128 caracteres).";
        return {};
    }
    if (key == "avatar_decoration_url") {
        if (value.isEmpty()) return {};
        if (value.size() > kMaxAvatarDecorationUrl) return "Link muito longo (máximo 512 caracteres).";
        if (!value.startsWith("https://")) return "O link da decoração precisa começar com https://.";
        return {};
    }
    if (key == "banner_color" || key == "profile_theme_start" || key == "profile_theme_end") {
        if (value.isEmpty()) return {};
        if (!kHexColorRe.match(value).hasMatch()) return "Cor inválida. Use o formato #rrggbb.";
        return {};
    }
    if (key == "display_name_style") {
        if (value.isEmpty()) return {};
        if (!kDisplayNameStyleRe.match(value).hasMatch()) return "Estilo inválido.";
        return {};
    }
    return {};
}

QJsonObject buildProfilePatchBody(const QJsonObject& original, const QJsonObject& current) {
    QJsonObject body;
    for (const auto& key : kFieldOrder) {
        const auto before = original.value(key).toString();
        const auto after = current.value(key).toString();
        if (before != after) {
            body[key] = after.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(after);
        }
    }
    return body;
}

namespace {

QString serverErrorMessage(const QJsonObject& response) {
    const auto code = response.value("error").toString();
    if (code == "unknown_field") return "Campo não reconhecido pelo servidor.";
    if (code == "invalid_field") {
        const auto field = response.value("field").toString();
        return "Valor inválido para " + field + ".";
    }
    if (code.isEmpty()) return {};
    return "Não foi possível salvar o perfil. Tente novamente.";
}

} // namespace

bool openProfileEditDialog(QWidget* parent, AuthSession& session) {
    int status = 0;
    QJsonObject meResponse;
    const auto fetchError = postJson(session.session(), "GET", "/me", {}, &status, &meResponse);
    if (status == 401) {
        session.clearSession();
        return false;
    }
    const auto account = meResponse.value("account").toObject();
    if (!fetchError.isEmpty() && account.isEmpty()) {
        return false; // offline / unreachable: nothing to edit against, bail out quietly.
    }

    QDialog dialog(parent);
    dialog.setObjectName("profileEditDialog");
    dialog.setWindowTitle("Editar perfil");
    dialog.setModal(true);
    dialog.resize(880, 640);
    dialog.setStyleSheet(
        "QDialog#profileEditDialog { background:#000000; }"
        "QLabel { color:#dcdcdf; font-size:13px; }"
        "QLabel#profileEditSectionTitle { color:#96979e; font-size:11px; font-weight:600; text-transform:uppercase; }"
        "QLabel#profileEditCounter { color:#81828a; font-size:11px; }"
        "QLabel#profileEditError, QLabel#profileMediaError { color:#f39a96; font-size:12px; }"
        "QLineEdit, QPlainTextEdit { background:#0a0a0c; border:1px solid rgba(151,151,159,0.2);"
        "            border-radius:6px; padding:8px 10px; color:#d4d5d8; font-size:14px; }"
        "QPushButton#profileEditSave { background:#5865f2; color:#ffffff; border:0; border-radius:6px;"
        "                              padding:10px 18px; font-weight:600; }"
        "QPushButton#profileEditSave:disabled { background:#2c2d35; color:#81828a; }"
        "QPushButton#profileEditCancel { background:transparent; color:#dcdcdf; border:0; padding:10px 18px; }"
        "QPushButton#profileMediaButton { background:#5865f2; color:#ffffff; border:0; border-radius:6px; padding:8px 14px; font-weight:600; }"
        "QPushButton#profileMediaButton:disabled { background:#2c2d35; color:#81828a; }"
        "QPushButton#profileMediaRemove { background:transparent; color:#eb5f5e; border:0; padding:8px 10px; }"
        "QPushButton#profileMediaRemove:disabled { color:#4d505b; }");

    auto* outer = new QVBoxLayout(&dialog);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* columns = new QHBoxLayout();
    columns->setContentsMargins(0, 0, 24, 0);
    columns->setSpacing(0);
    outer->addLayout(columns, 1);
    auto* scroll = new QScrollArea(&dialog);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    auto* form = new QWidget(scroll);
    auto* layout = new QVBoxLayout(form);
    layout->setContentsMargins(24, 24, 24, 24);
    layout->setSpacing(14);

    // NOTE: real Discord gates "display_name_style" and the two
    // "profile_theme_*" fields behind a purple "Eleve seu visual, somente
    // com Nitro" upsell panel with a lock icon and an "Obter o Nitro"
    // button (see out/claude-observations/PERFIL.md). triscord does not
    // sell Nitro, so those fields are built here as plain, always-editable
    // inputs — no lock icon, no upsell panel, no CTA button are rendered.

    QMap<QString, QWidget*> editors;
    ProfilePreviewCard* preview = nullptr;
    ProfileMediaClient media;
    QString avatarUrl = account.value("avatar_url").toString(), bannerUrl = account.value("banner_url").toString();
    auto addLineEdit = [&](const QString& key, const QString& label, const QString& placeholder, int maxLen) {
        layout->addWidget(new QLabel(label, form));
        auto* edit = new QLineEdit(form);
        edit->setObjectName("profileEdit_" + key);
        edit->setPlaceholderText(placeholder);
        edit->setMaxLength(maxLen);
        edit->setText(account.value(key).toString());
        layout->addWidget(edit);
        editors[key] = edit;
    };

    layout->addWidget([&] {
        auto* title = new QLabel("Avatar e faixa", form);
        title->setObjectName("profileEditSectionTitle");
        return title;
    }());
    // Upload/remove go straight to PUT/DELETE /profile/avatar|banner (cloudflare-auth/BACKEND_HANDOFF.md);
    // the media is not part of the PATCH body. Texts recovered statically (REA, Discord cache chunks
    // f_0000bc/f_0000de): the editor's avatar tile opens a menu with "Mudar avatar" (change-avatar) and,
    // in the danger colour, "Remover avatar" (remove-avatar); the banner is a square tile that opens the
    // upload dialog, with a "Remover faixa" affordance when a banner exists. triscord shows them as
    // buttons in this form (no tiles/menu yet); "Alterar imagem da faixa" is a locale string whose
    // screen was not identified.
    auto* mediaStatus = new QLabel(form);
    mediaStatus->setObjectName("profileMediaError");
    mediaStatus->setWordWrap(true);
    mediaStatus->hide();
    auto addMediaRow = [&](ProfileMediaKind kind, const QString& label, const QString& change, const QString& removeText) {
        layout->addWidget(new QLabel(label, form));
        auto* row = new QHBoxLayout();
        auto* pick = new QPushButton(change, form);
        pick->setObjectName("profileMediaButton");
        pick->setProperty("mediaKind", kind == ProfileMediaKind::Avatar ? "avatar" : "banner");
        auto* clear = new QPushButton(removeText, form);
        clear->setObjectName("profileMediaRemove");
        clear->setEnabled(!(kind == ProfileMediaKind::Avatar ? avatarUrl : bannerUrl).isEmpty());
        row->addWidget(pick);
        row->addWidget(clear);
        row->addStretch();
        layout->addLayout(row);
        auto apply = [&, kind, pick, clear, mediaStatus](int status, const QJsonObject& updated, const QJsonObject& body, const QByteArray& bytes) {
            pick->setEnabled(true);
            const auto message = profileMediaErrorMessage(kind, status, body);
            if (!message.isEmpty()) {
                if (status == 401) session.clearSession();
                mediaStatus->setText(message); // the previous image stays: an error is never a finished upload
                mediaStatus->show();
                clear->setEnabled(!(kind == ProfileMediaKind::Avatar ? avatarUrl : bannerUrl).isEmpty());
                return;
            }
            mediaStatus->hide();
            auto& url = kind == ProfileMediaKind::Avatar ? avatarUrl : bannerUrl;
            url = updated.value(kind == ProfileMediaKind::Avatar ? "avatar_url" : "banner_url").toString();
            clear->setEnabled(!url.isEmpty());
            if (preview) {
                if (kind == ProfileMediaKind::Avatar) preview->setAvatarImage(bytes); else preview->setBannerImage(bytes);
            }
        };
        QObject::connect(pick, &QPushButton::clicked, form, [&, kind, pick, clear, apply, mediaStatus] {
            const auto path = QFileDialog::getOpenFileName(&dialog, pick->text(), {}, "Imagens (*.png *.jpg *.jpeg *.gif)");
            if (path.isEmpty()) return;
            QFile file(path);
            if (!file.open(QIODevice::ReadOnly)) { mediaStatus->setText("Não foi possível abrir o arquivo."); mediaStatus->show(); return; }
            const auto bytes = file.read(profileMediaMaxBytes(kind) + 1);
            pick->setEnabled(false); clear->setEnabled(false);
            media.upload(session.session(), kind, bytes, [apply, bytes](int status, const QJsonObject& updated, const QJsonObject& body) {
                apply(status, updated, body, bytes);
            });
        });
        QObject::connect(clear, &QPushButton::clicked, form, [&, kind, pick, clear, apply] {
            pick->setEnabled(false); clear->setEnabled(false);
            media.remove(session.session(), kind, [apply](int status, const QJsonObject& updated, const QJsonObject& body) {
                apply(status, updated, body, {});
            });
        });
    };
    addMediaRow(ProfileMediaKind::Avatar, "Avatar (PNG, JPEG ou GIF animado até 512 KB)", "Mudar avatar", "Remover avatar");
    addMediaRow(ProfileMediaKind::Banner, "Faixa (PNG, JPEG ou GIF animado até 1 MB)", "Alterar imagem da faixa", "Remover faixa");
    layout->addWidget(mediaStatus);
    addLineEdit("avatar_decoration_url", "Decoração do avatar (link https://)", "Sem decoração", kMaxAvatarDecorationUrl);
    addLineEdit("banner_color", "Cor da faixa (#rrggbb)", "#000000", 7);

    layout->addWidget([&] {
        auto* title = new QLabel("Estilo do nome e tema de perfil", form);
        title->setObjectName("profileEditSectionTitle");
        return title;
    }());
    addLineEdit("display_name_style", "Estilo do nome exibido", "Padrão", 32);
    addLineEdit("profile_theme_start", "Tema de perfil — cor inicial (#rrggbb)", "#000000", 7);
    addLineEdit("profile_theme_end", "Tema de perfil — cor final (#rrggbb)", "#000000", 7);

    layout->addWidget([&] {
        auto* title = new QLabel("Sobre você", form);
        title->setObjectName("profileEditSectionTitle");
        return title;
    }());
    addLineEdit("display_name", "Nome de exibição", "Nome de exibição", kMaxDisplayName);
    addLineEdit("pronouns", "Pronomes", "Adicionar pronomes", kMaxPronouns);

    layout->addWidget(new QLabel("Bio", form));
    auto* bio = new QPlainTextEdit(form);
    bio->setObjectName("profileEdit_bio");
    bio->setPlaceholderText("Escreva uma breve introdução");
    bio->setPlainText(account.value("bio").toString());
    bio->setFixedHeight(72);
    layout->addWidget(bio);
    editors["bio"] = bio;
    auto* bioCounter = new QLabel(form);
    bioCounter->setObjectName("profileEditCounter");
    bioCounter->setAlignment(Qt::AlignRight);
    auto updateBioCounter = [bioCounter, bio] {
        bioCounter->setText(QString("%1/%2").arg(bio->toPlainText().size()).arg(kMaxBio));
    };
    updateBioCounter();
    QObject::connect(bio, &QPlainTextEdit::textChanged, form, updateBioCounter);
    layout->addWidget(bioCounter);

    addLineEdit("note", "Nota (visível apenas para você)", "Clique para adicionar uma nota", kMaxNote);

    auto* error = new QLabel(form);
    error->setObjectName("profileEditError");
    error->setWordWrap(true);
    error->hide();
    layout->addWidget(error);
    layout->addStretch();

    scroll->setWidget(form);
    columns->addWidget(scroll, 1);

    // Live card, as in Discord's editor (the card re-renders while typing; see profile_preview.h).
    preview = new ProfilePreviewCard(&dialog);
    // Current images: downloaded once per url (public GET, no session) and shown when they arrive.
    auto& images = RemoteImageCache::instance();
    QObject::connect(&images, &RemoteImageCache::loaded, preview, [&images, preview, &avatarUrl, &bannerUrl](const QString& url) {
        if (url == avatarUrl) preview->setAvatarImage(images.bytes(url));
        if (url == bannerUrl) preview->setBannerImage(images.bytes(url));
    });
    images.fetch(avatarUrl);
    images.fetch(bannerUrl);
    auto* previewColumn = new QVBoxLayout();
    previewColumn->setContentsMargins(0, 24, 0, 0);
    previewColumn->addWidget(preview);
    previewColumn->addStretch();
    columns->addLayout(previewColumn);
    preview->setUsername(account.value("nick").toString().isEmpty() ? session.nick() : account.value("nick").toString());
    if (account.value("created_at").isDouble())
        preview->setMemberSince(QDateTime::fromMSecsSinceEpoch(static_cast<qint64>(account.value("created_at").toDouble())));
    auto lineText = [&](const QString& key) {
        auto* line = qobject_cast<QLineEdit*>(editors.value(key));
        return line ? line->text().trimmed() : QString();
    };
    auto refreshPreview = [&, preview, bio] {
        preview->setDisplayName(lineText("display_name"));
        preview->setPronouns(lineText("pronouns"));
        preview->setBio(bio->toPlainText());
        preview->setNote(lineText("note"));
        preview->setBannerColor(lineText("banner_color"));
        preview->setTheme(lineText("profile_theme_start"), lineText("profile_theme_end"));
    };
    refreshPreview();
    for (auto it = editors.begin(); it != editors.end(); ++it) {
        if (auto* line = qobject_cast<QLineEdit*>(it.value())) QObject::connect(line, &QLineEdit::textChanged, preview, refreshPreview);
    }
    QObject::connect(bio, &QPlainTextEdit::textChanged, preview, refreshPreview);

    auto* buttons = new QHBoxLayout();
    buttons->setContentsMargins(24, 12, 24, 20);
    buttons->addStretch();
    auto* cancel = new QPushButton("Cancelar", &dialog);
    cancel->setObjectName("profileEditCancel");
    auto* save = new QPushButton("Salvar", &dialog);
    save->setObjectName("profileEditSave");
    save->setDefault(true);
    buttons->addWidget(cancel);
    buttons->addWidget(save);
    outer->addLayout(buttons);

    QObject::connect(cancel, &QPushButton::clicked, &dialog, &QDialog::reject);

    bool saved = false;
    QObject::connect(save, &QPushButton::clicked, &dialog, [&] {
        QJsonObject current;
        for (auto it = editors.begin(); it != editors.end(); ++it) {
            QString value;
            if (auto* line = qobject_cast<QLineEdit*>(it.value())) value = line->text().trimmed();
            else if (auto* text = qobject_cast<QPlainTextEdit*>(it.value())) value = text->toPlainText().trimmed();
            current[it.key()] = value;
        }
        for (auto it = current.begin(); it != current.end(); ++it) {
            const auto message = validateProfileField(it.key(), it.value().toString());
            if (!message.isEmpty()) {
                error->setText(message);
                error->show();
                return;
            }
        }
        const auto body = buildProfilePatchBody(account, current);
        if (body.isEmpty()) {
            dialog.accept();
            return;
        }
        save->setEnabled(false);
        int patchStatus = 0;
        QJsonObject patchResponse;
        postJson(session.session(), "PATCH", "/profile", body, &patchStatus, &patchResponse);
        save->setEnabled(true);
        if (patchStatus == 401) {
            session.clearSession();
            dialog.reject();
            return;
        }
        if (patchStatus >= 200 && patchStatus < 300) {
            saved = true;
            dialog.accept();
            return;
        }
        const auto message = serverErrorMessage(patchResponse);
        error->setText(message.isEmpty() ? "Não foi possível salvar o perfil." : message);
        error->show();
    });

    dialog.exec();
    return saved;
}

} // namespace triscord
