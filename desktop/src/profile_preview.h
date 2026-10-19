#pragma once
#include <QByteArray>
#include <QDateTime>
#include <QPixmap>
#include <QString>
#include <QWidget>

class QBuffer;
class QMovie;

namespace triscord {

// Live profile card shown beside the "Editar perfil" form, rebuilt from Discord's editor
// (desktop/out/claude-observations/discord-profile-edit-modal.png, rea-css/PERFIL_BUNDLE.md):
//   - card 400px wide, 16px top radius; banner 400x140 (MODAL_V2 bannerWidth/bannerHeight);
//   - avatar 120px (MODAL_V2 avatarSize SIZE_120) inside an 8px ring of the card colour, outer box at
//     x 24 (avatarOffsetX) and centred on the banner's bottom edge. Measured on the capture: image
//     362..482 = 120px, ring 354..490 = 136px, which settles the "120 declared vs ~96 measured" note;
//   - display name 20px bold at baseline 247 and x 32; "username • pronouns" 14px at baseline 280;
//   - 12px bold section labels (--text-subtle) with 14px values; "Bio", "Membro desde", "Nota".
// Not reproduced (no triscord function): the "Mensagem" button row, "Conexões", the status bubble,
// the presence dot and the widgets column. Without the button row the sections move up by its 48px.
// Profile theme (two colours, ex-Nitro and free in triscord), recovered statically with REA from
// assets/96ee09de752e7ff4.css and the theme module: primary down to the banner height, then a gradient to
// the secondary colour, under a 60% black overlay (dark themes). Not compared against a themed capture. An unset
// banner colour falls back to --background-surface-higher (#121214): Discord derives it from the avatar.
class ProfilePreviewCard final : public QWidget {
    Q_OBJECT
public:
    explicit ProfilePreviewCard(QWidget* parent = nullptr);
    QSize sizeHint() const override { return {400, 560}; }

    void setDisplayName(const QString& value) { displayName_ = value; update(); }
    void setUsername(const QString& value) { username_ = value; update(); }
    void setPronouns(const QString& value) { pronouns_ = value; update(); }
    void setBio(const QString& value) { bio_ = value; update(); }
    void setNote(const QString& value) { note_ = value; update(); }
    void setBannerColor(const QString& value) { bannerColor_ = value; update(); }
    void setTheme(const QString& start, const QString& end) { themeStart_ = start; themeEnd_ = end; update(); }
    void setMemberSince(const QDateTime& when) { memberSince_ = when; update(); }
    // Uploaded/remote images; empty bytes clear them. An animated GIF plays here (the editor is open),
    // like Discord's editor preview; everywhere else triscord shows the first frame to keep idle CPU at 0.
    void setAvatarImage(const QByteArray& bytes) { setImage(avatar_, bytes); }
    void setBannerImage(const QByteArray& bytes) { setImage(banner_, bytes); }
    bool avatarAnimated() const;

    // "24 de jun. de 2026", the observed pt-BR format.
    static QString memberSinceText(const QDateTime& when);

protected:
    void paintEvent(QPaintEvent*) override;

private:
    struct Image {
        QPixmap still;
        QMovie* movie = nullptr;
        QBuffer* buffer = nullptr;
        QPixmap frame() const;
    };
    void setImage(Image& image, const QByteArray& bytes);
    Image avatar_, banner_;
    QString displayName_, username_, pronouns_, bio_, note_, bannerColor_, themeStart_, themeEnd_;
    QDateTime memberSince_;
};

} // namespace triscord
