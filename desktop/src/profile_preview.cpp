#include "profile_preview.h"
#include <QBuffer>
#include <QLinearGradient>
#include <QMovie>
#include <QPainter>
#include <QPainterPath>
#include <QRegularExpression>

namespace triscord {
namespace {

QColor validColor(const QString& value) {
    static const QRegularExpression hex("^#[0-9a-fA-F]{6}$");
    return hex.match(value).hasMatch() ? QColor(value) : QColor();
}

void drawCover(QPainter& painter, const QRectF& target, const QPixmap& image) {
    // Crop the source before drawing. Scaling an extremely thin image to
    // cover a square first can allocate a huge intermediate pixmap.
    const qreal scale = qMax(target.width() / image.width(), target.height() / image.height());
    const QSizeF size(target.width() / scale, target.height() / scale);
    const QRectF source((image.width() - size.width()) / 2, (image.height() - size.height()) / 2,
                        size.width(), size.height());
    painter.drawPixmap(target, image, source);
}

// theme-dark samples -> theme-midnight (rea-css/TOKENS.md)
const QColor kCard("#0a0a0c");      // #393a41 --background-surface-high
const QColor kBanner("#121214");    // --background-surface-higher (fallback, see header)
const QColor kStrong("#d4d5d8");    // #f3f3f4 --text-default (display name, values)
const QColor kSubtle("#96979e");    // #c5c6ca --text-subtle (labels)
const QColor kMuted("#81828a");     // --text-muted (placeholders, observed italic)

} // namespace

ProfilePreviewCard::ProfilePreviewCard(QWidget* parent) : QWidget(parent) {
    setObjectName("profilePreviewCard");
    setFixedSize(400, 560);
}

QPixmap ProfilePreviewCard::Image::frame() const {
    return movie ? movie->currentPixmap() : still;
}

bool ProfilePreviewCard::avatarAnimated() const {
    return avatar_.movie && avatar_.movie->frameCount() > 1;
}

void ProfilePreviewCard::setImage(Image& image, const QByteArray& bytes) {
    if (image.movie) { image.movie->stop(); image.movie->deleteLater(); image.movie = nullptr; }
    if (image.buffer) { image.buffer->deleteLater(); image.buffer = nullptr; }
    image.still = QPixmap();
    if (!bytes.isEmpty() && bytes.startsWith("GIF8")) {
        image.buffer = new QBuffer(this);
        image.buffer->setData(bytes);
        image.buffer->open(QIODevice::ReadOnly);
        image.movie = new QMovie(image.buffer, QByteArray(), this);
        // QBuffer is seekable, so GIFs can loop without retaining every
        // decoded frame (compressed upload size does not bound frame RAM).
        image.movie->setCacheMode(QMovie::CacheNone);
        connect(image.movie, &QMovie::frameChanged, this, [this] { update(); });
        image.movie->start();
    } else if (!bytes.isEmpty()) {
        image.still.loadFromData(bytes);
    }
    update();
}

QString ProfilePreviewCard::memberSinceText(const QDateTime& when) {
    static const char* months[] = {"jan.", "fev.", "mar.", "abr.", "mai.", "jun.", "jul.", "ago.", "set.", "out.", "nov.", "dez."};
    const auto date = when.toLocalTime().date();
    return QString("%1 de %2 de %3").arg(date.day()).arg(months[date.month() - 1]).arg(date.year());
}

void ProfilePreviewCard::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    p.setRenderHint(QPainter::TextAntialiasing);
    p.setRenderHint(QPainter::SmoothPixmapTransform);

    QPainterPath card;
    card.addRoundedRect(QRectF(rect()), 16, 16);
    const QColor start = validColor(themeStart_), end = validColor(themeEnd_);
    QColor cardColor = kCard;
    if (start.isValid() && end.isValid()) {
        // Discord (assets/96ee09de752e7ff4.css, .custom-user-profile-theme .profile__9c3be): primary down to the
        // banner height, then primary -> secondary; its ::before lays --profile-gradient-overlay-color on top,
        // which the theme module resolves to BLACK at 0.6 for the dark themes (PROFILE_GRADIENT_OVERLAY).
        QLinearGradient gradient(0, 0, 0, height());
        gradient.setColorAt(0, start);
        gradient.setColorAt(140.0 / height(), start);
        gradient.setColorAt(1, end);
        p.fillPath(card, gradient);
        p.fillPath(card, QColor(0, 0, 0, 153));
        cardColor = QColor(start.red() * 2 / 5, start.green() * 2 / 5, start.blue() * 2 / 5); // ring = card behind it
    } else {
        p.fillPath(card, kCard);
    }

    // Banner: clip to the card's rounded top.
    p.save();
    p.setClipPath(card);
    const QColor banner = validColor(bannerColor_);
    p.fillRect(QRect(0, 0, 400, 140), banner.isValid() ? banner : kBanner);
    const QPixmap bannerImage = banner_.frame();
    if (!bannerImage.isNull()) {
        // Cover the 400x140 banner, cropping the overflow around the centre.
        drawCover(p, QRectF(0, 0, 400, 140), bannerImage);
    }
    p.restore();

    // Avatar: 136px ring box at (24, 72), 120px image at (32, 80); centred on the banner edge (y 140).
    p.setPen(Qt::NoPen);
    p.setBrush(cardColor);
    p.drawEllipse(QRectF(24, 72, 136, 136));
    const QString shown = displayName_.trimmed().isEmpty() ? username_ : displayName_.trimmed();
    const QPixmap avatarImage = avatar_.frame();
    if (!avatarImage.isNull()) {
        p.save();
        QPainterPath circle; circle.addEllipse(QRectF(32, 80, 120, 120));
        p.setClipPath(circle);
        drawCover(p, QRectF(32, 80, 120, 120), avatarImage);
        p.restore();
    } else {
        p.setBrush(QColor("#5865f2"));
        p.drawEllipse(QRectF(32, 80, 120, 120));
        QFont initial = font();
        initial.setPixelSize(48);
        initial.setBold(true);
        p.setFont(initial);
        p.setPen(Qt::white);
        p.drawText(QRectF(32, 80, 120, 120), Qt::AlignCenter, shown.left(1).toUpper());
    }

    auto text = [&](int baseline, int px, bool bold, bool italic, const QColor& color, const QString& value) {
        QFont f = font();
        f.setPixelSize(px);
        f.setBold(bold);
        f.setItalic(italic);
        p.setFont(f);
        p.setPen(color);
        p.drawText(QPointF(32, baseline), QFontMetrics(f).elidedText(value, Qt::ElideRight, width() - 64));
    };

    text(247, 20, true, false, kStrong, shown);
    // "username • pronouns"; an empty pronoun slot shows the observed italic "Adicionar pronomes".
    {
        QFont f = font(); f.setPixelSize(14);
        p.setFont(f); p.setPen(kStrong);
        const QString lead = username_ + "  •  ";
        p.drawText(QPointF(32, 280), lead);
        const int x = 32 + QFontMetrics(f).horizontalAdvance(lead);
        const bool empty = pronouns_.trimmed().isEmpty();
        f.setItalic(empty); p.setFont(f); p.setPen(empty ? kMuted : kStrong);
        p.drawText(QPointF(x, 280), QFontMetrics(f).elidedText(empty ? QString("Adicionar pronomes") : pronouns_.trimmed(),
                                                               Qt::ElideRight, width() - 32 - x));
    }

    // Sections: observed 68px from one label baseline to the next, values 24px under their label.
    int label = 342;
    text(label, 12, true, false, kSubtle, "Bio");
    if (bio_.trimmed().isEmpty()) {
        text(label + 24, 14, false, true, kMuted, "Escreva uma breve introdução");
    } else {
        QFont f = font(); f.setPixelSize(14); p.setFont(f); p.setPen(kStrong);
        const QFontMetrics metrics(f);
        // First line sits on the observed value baseline (label + 24); extra lines push the next sections down.
        const QRect box(32, label + 24 - metrics.ascent(), width() - 64, metrics.lineSpacing() * 3);
        const QRect used = metrics.boundingRect(box, Qt::TextWordWrap, bio_.trimmed());
        p.drawText(box, Qt::TextWordWrap | Qt::AlignTop | Qt::AlignLeft, bio_.trimmed());
        label += qMax(0, qMin(used.height(), box.height()) - metrics.lineSpacing());
    }
    label += 68;
    if (memberSince_.isValid()) {
        text(label, 12, true, false, kSubtle, "Membro desde");
        text(label + 26, 14, false, false, kStrong, memberSinceText(memberSince_));
        label += 68;
    }
    text(label, 12, true, false, kSubtle, "Nota (visível apenas para você)");
    if (note_.trimmed().isEmpty()) text(label + 24, 14, false, true, kMuted, "Clique para adicionar uma nota");
    else text(label + 24, 14, false, false, kStrong, note_.trimmed());
}

} // namespace triscord
