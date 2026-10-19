#include "soundboard.h"
#include "discord_icons.h"
#include <QAudioOutput>
#include <QMediaPlayer>
#include <QMediaDevices>
#include <QAudioDevice>
#include <QFile>
#include <QSaveFile>
#include <QCryptographicHash>
#include <QJsonDocument>
#include <QJsonObject>
#include <QGridLayout>
#include <QLineEdit>
#include <QScrollArea>
#include <QScrollBar>
#include <QStyle>
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QSettings>
#include <QStandardPaths>
#include <QDir>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QTextLayout>
#include <algorithm>

static void initializeSounds() { static const bool initialized = [] { Q_INIT_RESOURCE(soundboard); return true; }(); Q_UNUSED(initialized); }

namespace triscord {

// Geometry measured on Discord's soundboard popover at 96 DPI (desktop/out/claude-observations/SOUNDBOARD.md);
// surfaces use the sampled Discord colours (popover #000000, search and rail #000000,
// tile #3e3f47 with a #3d3e44 border).
namespace {
constexpr int kPopoverWidth = 532, kPopoverHeight = 522, kAnchorGap = 8;
constexpr int kTileWidth = 148, kTileHeight = 40, kTileGap = 8, kColumns = 3;

QPixmap circular(const QPixmap& source, int size) {
    QPixmap out(size, size); out.fill(Qt::transparent);
    QPainter p(&out); p.setRenderHint(QPainter::Antialiasing); p.setRenderHint(QPainter::SmoothPixmapTransform);
    QPainterPath clip; clip.addEllipse(0, 0, size, size); p.setClipPath(clip);
    if (!source.isNull()) p.drawPixmap(0, 0, source.scaled(size, size, Qt::KeepAspectRatioByExpanding, Qt::SmoothTransformation));
    return out;
}

// Up to two centred lines, the second elided, as the observed tiles wrap long names.
void drawTwoLines(QPainter* p, const QRect& box, const QString& text) {
    const QFontMetrics fm(p->font());
    QTextLayout layout(text, p->font());
    layout.beginLayout();
    QStringList lines;
    while (lines.size() < 2) {
        QTextLine line = layout.createLine();
        if (!line.isValid()) break;
        line.setLineWidth(box.width());
        lines << text.mid(line.textStart(), line.textLength()).trimmed();
    }
    const bool more = layout.createLine().isValid();
    layout.endLayout();
    if (lines.size() == 2 && more) lines[1] = fm.elidedText(lines[1] + QString(QChar(0x2026)), Qt::ElideRight, box.width());
    const int lineHeight = fm.height();
    int y = box.center().y() - lines.size() * lineHeight / 2 + 1;
    for (const auto& line : lines) {
        p->drawText(QRect(box.left(), y, box.width(), lineHeight), Qt::AlignCenter, line);
        y += lineHeight;
    }
}
} // namespace

QByteArray soundboardAudio(const QByteArray& original) {
    if (original.size() < 10 || !original.startsWith("ID3")) return original;
    qsizetype length = 0;
    for (int n = 6; n < 10; ++n) {
        const auto byte = static_cast<unsigned char>(original[n]);
        if (byte & 0x80) return original;
        length = (length << 7) | byte;
    }
    length += 10;
    if (original[3] == 4 && (static_cast<unsigned char>(original[5]) & 0x10)) length += 10;
    return length < original.size() ? original.mid(length) : original;
}

SoundCardWidget::SoundCardWidget(const QString& id, const QString& name, QWidget* parent)
    : QWidget(parent), id_(id), name_(name) {
    setObjectName("soundButton");
    setFixedSize(kTileWidth, kTileHeight);
    setCursor(Qt::PointingHandCursor);
    setToolTip(name_);

    // Preview for the local user only (REA soundButton evidence, module 817232); shown while hovered.
    previewBtn_ = new QPushButton(this);
    previewBtn_->setObjectName("soundPreviewButton");
    previewBtn_->setGeometry(width() - 26, (height() - 22) / 2, 22, 22);
    previewBtn_->setIcon(DiscordIcons::icon(DiscordIcons::IconType::VoiceSpeaker, QColor("#96979e"), 14));
    previewBtn_->setIconSize(QSize(14, 14));
    previewBtn_->setCursor(Qt::PointingHandCursor);
    previewBtn_->setToolTip("Prévia (apenas para você)");
    previewBtn_->setStyleSheet(
        "QPushButton { background: transparent; border: none; border-radius: 4px; }"
        "QPushButton:hover { background: rgba(151,151,159,0.200); }");
    previewBtn_->hide();
    connect(previewBtn_, &QPushButton::clicked, this, [this] { emit previewClicked(id_); });
}

void SoundCardWidget::setPlaying(bool playing) {
    playing_ = playing;
    update();
}

void SoundCardWidget::enterEvent(QEnterEvent*) {
    isHovered_ = true;
    previewBtn_->show();
    update();
}

void SoundCardWidget::leaveEvent(QEvent*) {
    isHovered_ = false;
    previewBtn_->hide();
    update();
}

void SoundCardWidget::mousePressEvent(QMouseEvent* event) {
    if (event->button() == Qt::LeftButton) emit clicked(id_);
    QWidget::mousePressEvent(event);
}

void SoundCardWidget::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    const QRectF tile = QRectF(rect()).adjusted(0.5, 0.5, -0.5, -0.5);
    QPainterPath path; path.addRoundedRect(tile, 8, 8);
    p.fillPath(path, isHovered_ ? QColor("#121213") : QColor("#3e3f47"));
    // Playing: positive status border (REA CSS, modules 817232 + 948611).
    p.setPen(QPen(playing_ ? QColor("#23a55a") : QColor("#3d3e44"), 1));
    p.drawPath(path);
    QFont f = font(); f.setPixelSize(14); f.setWeight(QFont::DemiBold);
    p.setFont(f); p.setPen(QColor("#d4d5d8"));
    drawTwoLines(&p, rect().adjusted(10, 0, isHovered_ ? -30 : -10, 0), name_);
}

SoundboardSectionHeader::SoundboardSectionHeader(const QPixmap& icon, const QString& title, QWidget* parent)
    : QWidget(parent), icon_(circular(icon, 16)), title_(title) {
    setObjectName("soundboardSectionHeader");
    setFixedHeight(40);
    setCursor(Qt::PointingHandCursor);
}

void SoundboardSectionHeader::mousePressEvent(QMouseEvent* event) {
    if (event->button() != Qt::LeftButton) return;
    collapsed_ = !collapsed_;
    update();
    emit toggled(collapsed_);
}

void SoundboardSectionHeader::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    // Observed: text centre 24px below the header top, icon at x 0, text at x 20, chevron 4px after it.
    const int cy = 24;
    p.drawPixmap(0, cy - 8, icon_);
    QFont f = font(); f.setPixelSize(14); f.setWeight(QFont::DemiBold);
    p.setFont(f); p.setPen(QColor("#96979e"));
    const QFontMetrics fm(f);
    const QString text = fm.elidedText(title_, Qt::ElideRight, width() - 44);
    const int textWidth = fm.horizontalAdvance(text);
    p.drawText(QRect(20, cy - 10, textWidth + 2, 20), Qt::AlignLeft | Qt::AlignVCenter, text);
    DiscordIcons::paint(&p, collapsed_ ? DiscordIcons::IconType::ChevronSmallRight : DiscordIcons::IconType::ChevronSmallDown,
                        QRectF(20 + textWidth + 4, cy - 8, 16, 16), QColor("#96979e"));
}

SoundboardRailItem::SoundboardRailItem(const QPixmap& icon, const QString& title, QWidget* parent)
    : QWidget(parent), icon_(circular(icon, 32)) {
    setObjectName("soundboardRailItem");
    setFixedSize(47, 40);
    setCursor(Qt::PointingHandCursor);
    setToolTip(title);
}

void SoundboardRailItem::mousePressEvent(QMouseEvent* event) {
    if (event->button() == Qt::LeftButton) emit clicked();
}

void SoundboardRailItem::paintEvent(QPaintEvent*) {
    QPainter p(this);
    p.setRenderHint(QPainter::Antialiasing);
    const QRect item(7, 4, 32, 32);
    if (selected_) {
        // Observed: selected item over the popover surface, white pill 4x20 at the rail edge.
        QPainterPath bg; bg.addRoundedRect(QRectF(item), 8, 8);
        p.fillPath(bg, QColor("#000000"));
        QPainterPath pill; pill.addRoundedRect(QRectF(-4, item.center().y() - 9.5, 8, 20), 4, 4);
        p.fillPath(pill, Qt::white);
    }
    p.drawPixmap(item.topLeft(), icon_);
}

Soundboard::Soundboard(QWidget* parent) : QDialog(parent) {
    initializeSounds();
    setObjectName("soundboardDialog");
    setWindowTitle("Painel de efeitos sonoros");
    setWindowFlags(Qt::Popup | Qt::FramelessWindowHint | Qt::NoDropShadowWindowHint);
    setAttribute(Qt::WA_TranslucentBackground);
    setFixedSize(kPopoverWidth, kPopoverHeight);
    volume_ = std::clamp(QSettings().value("soundboardVolume", 70).toInt(), 0, 100);

    QFile manifest(":/soundboard/catalog.json");
    if (manifest.open(QIODevice::ReadOnly)) catalog_ = QJsonDocument::fromJson(manifest.readAll()).array();

    auto* outer = new QVBoxLayout(this);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* popover = new QWidget(this);
    popover->setObjectName("soundboardPopover");
    popover->setAttribute(Qt::WA_StyledBackground);
    outer->addWidget(popover);
    setStyleSheet(
        "QWidget#soundboardPopover { background:#000000; border:1px solid rgba(151,151,159,0.439); border-radius:8px; }"
        "QFrame#soundboardSearch { background:#000000; border:2px solid transparent; border-radius:8px; }"
        "QFrame#soundboardSearch[focused=\"true\"] { border-color:#5865f2; }"
        "QLineEdit#soundboardSearchInput { background:transparent; border:none; color:#d4d5d8; font-size:16px; padding:0; }"
        "QWidget#soundboardDivider { background:#28292e; }"
        "QWidget#soundboardRail { background:#000000; border-bottom-left-radius:7px; }"
        "QScrollArea#soundboardScroll, QWidget#soundboardContent, QWidget#soundboardList { background:transparent; border:none; }"
        "QScrollArea#soundboardScroll QScrollBar:vertical { width:8px; background:transparent; margin:0; }"
        "QScrollArea#soundboardScroll QScrollBar::handle:vertical { background:rgba(151,151,159,0.439); border-radius:4px; min-height:24px; }"
        "QScrollArea#soundboardScroll QScrollBar::add-line:vertical, QScrollArea#soundboardScroll QScrollBar::sub-line:vertical { height:0; }"
        "QScrollArea#soundboardScroll QScrollBar::add-page:vertical, QScrollArea#soundboardScroll QScrollBar::sub-page:vertical { background:transparent; }");

    auto* root = new QVBoxLayout(popover);
    root->setContentsMargins(1, 1, 1, 1);
    root->setSpacing(0);

    // Header: 40px search field 12px from the left and 13px from the top; 64px tall, then a 1px divider.
    auto* header = new QWidget(popover);
    header->setFixedHeight(64);
    searchFrame_ = new QFrame(header);
    searchFrame_->setObjectName("soundboardSearch");
    searchFrame_->setGeometry(11, 12, 471, 40);
    auto* searchLayout = new QHBoxLayout(searchFrame_);
    searchLayout->setContentsMargins(10, 0, 10, 0);
    searchLayout->setSpacing(10);
    auto* searchIcon = new QLabel(searchFrame_);
    searchIcon->setPixmap(DiscordIcons::pixmap(DiscordIcons::IconType::MagnifyingGlass, QColor("#96979e"), 18));
    searchIcon->setFixedSize(18, 18);
    searchIcon->setStyleSheet("background:transparent;");
    searchLayout->addWidget(searchIcon);
    search_ = new QLineEdit(searchFrame_);
    search_->setObjectName("soundboardSearchInput");
    search_->setPlaceholderText("Encontre o som perfeito");
    search_->installEventFilter(this);
    searchLayout->addWidget(search_, 1);
    root->addWidget(header);
    auto* divider = new QWidget(popover);
    divider->setObjectName("soundboardDivider");
    divider->setAttribute(Qt::WA_StyledBackground);
    divider->setFixedHeight(1);
    root->addWidget(divider);

    auto* body = new QHBoxLayout;
    body->setContentsMargins(0, 0, 0, 0);
    body->setSpacing(0);
    auto* rail = new QWidget(popover);
    rail->setObjectName("soundboardRail");
    rail->setAttribute(Qt::WA_StyledBackground);
    rail->setFixedWidth(47);
    auto* railLayout = new QVBoxLayout(rail);
    railLayout->setContentsMargins(0, 4, 0, 4);
    railLayout->setSpacing(0);
    body->addWidget(rail);

    scroll_ = new QScrollArea(popover);
    scroll_->setObjectName("soundboardScroll");
    scroll_->setWidgetResizable(true);
    scroll_->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    scroll_->setVerticalScrollBarPolicy(Qt::ScrollBarAlwaysOn);
    auto* content = new QWidget(scroll_);
    content->setObjectName("soundboardContent");
    auto* contentLayout = new QVBoxLayout(content);
    contentLayout->setContentsMargins(8, 0, 6, 12);
    contentLayout->setSpacing(0);

    // triscord has one server and every catalogued sound belongs to it, so the server section is the only real one.
    const QPixmap serverIcon(":/triscord/icon.png");
    serverHeader_ = new SoundboardSectionHeader(serverIcon, "Triscord", content);
    contentLayout->addWidget(serverHeader_);
    section_ = new QWidget(content);
    section_->setObjectName("soundboardList");
    grid_ = new QGridLayout(section_);
    grid_->setContentsMargins(0, 0, 0, 0);
    grid_->setHorizontalSpacing(kTileGap);
    grid_->setVerticalSpacing(kTileGap);
    grid_->setAlignment(Qt::AlignLeft | Qt::AlignTop);
    contentLayout->addWidget(section_);
    contentLayout->addStretch(1);
    scroll_->setWidget(content);
    body->addWidget(scroll_, 1);
    root->addLayout(body, 1);

    auto* serverRailItem = new SoundboardRailItem(serverIcon, "Triscord", rail);
    serverRailItem->setSelected(true);
    railLayout->addWidget(serverRailItem);
    railLayout->addStretch(1);
    connect(serverRailItem, &SoundboardRailItem::clicked, this, [this] { scroll_->verticalScrollBar()->setValue(serverHeader_->y()); });
    connect(serverHeader_, &SoundboardSectionHeader::toggled, section_, [this](bool collapsed) { section_->setVisible(!collapsed); });

    for (const auto& value : catalog_) {
        const auto clip = value.toObject();
        const QString id = clip.value("id").toString();
        auto* card = new SoundCardWidget(id, clip.value("name").toString(), section_);
        cards_ << card;
        cardWidgets_[id] = card;
        connect(card, &SoundCardWidget::clicked, this, &Soundboard::playRequested);
        connect(card, &SoundCardWidget::previewClicked, this, &Soundboard::play);
    }
    layoutCards();

    connect(search_, &QLineEdit::textChanged, this, [this] { applyFilter(); });
    deadline_.setSingleShot(true);
    connect(&deadline_, &QTimer::timeout, this, &Soundboard::stop);
}

bool Soundboard::eventFilter(QObject* watched, QEvent* event) {
    if (watched == search_ && (event->type() == QEvent::FocusIn || event->type() == QEvent::FocusOut)) {
        searchFrame_->setProperty("focused", event->type() == QEvent::FocusIn);
        searchFrame_->style()->unpolish(searchFrame_);
        searchFrame_->style()->polish(searchFrame_);
    }
    return QDialog::eventFilter(watched, event);
}

void Soundboard::popupFor(QWidget* anchor) {
    // Observed: left edge aligned with the button, bottom edge 8px above it.
    QPoint topLeft = anchor ? anchor->mapToGlobal(QPoint(0, -kAnchorGap - height())) : pos();
    if (anchor) {
        const QRect bounds = anchor->window()->geometry();
        topLeft.setX(std::clamp(topLeft.x(), bounds.left(), std::max(bounds.left(), bounds.right() - width())));
        topLeft.setY(std::max(topLeft.y(), bounds.top()));
    }
    search_->clear();
    move(topLeft);
    show();
    raise();
    activateWindow();
    search_->setFocus(Qt::PopupFocusReason);
}

void Soundboard::layoutCards() {
    while (grid_->count()) delete grid_->takeAt(0);
    int index = 0;
    for (auto* card : cards_) {
        if (card->isHidden()) continue;
        grid_->addWidget(card, index / kColumns, index % kColumns);
        ++index;
    }
}

void Soundboard::applyFilter() {
    const QString query = search_->text().trimmed();
    for (auto* card : cards_) card->setVisible(query.isEmpty() || card->name().contains(query, Qt::CaseInsensitive));
    layoutCards();
}

void Soundboard::setVolume(int percent) {
    volume_ = std::clamp(percent, 0, 100);
    if (audio_) audio_->setVolume(volume_ / 100.f);
}

void Soundboard::updatePlayingHighlight(const QString& id, bool isPlaying) {
    if (id.isEmpty()) return;
    auto it = cardWidgets_.find(id);
    if (it != cardWidgets_.end() && it.value()) {
        it.value()->setPlaying(isPlaying);
    }
}

void Soundboard::play(const QString& id) {
    if (deafened_) return;
    const auto known = std::find_if(catalog_.begin(), catalog_.end(), [&id](const QJsonValue& value) { return value.toObject().value("id").toString() == id; });
    if (known == catalog_.end()) return;
    const QString cache = QStandardPaths::writableLocation(QStandardPaths::AppLocalDataLocation) + "/soundboard";
    const QString path = cache + "/" + id + ".mp3";
    QFile asset(":/soundboard/" + id + ".mp3");
    if (!asset.open(QIODevice::ReadOnly)) return;
    const auto original = asset.readAll();
    if (original.isEmpty() || original.size() > 1048576 || QCryptographicHash::hash(original, QCryptographicHash::Sha256).toHex() != id.toLatin1()) return;
    const auto bytes = soundboardAudio(original);
    const auto digest = QCryptographicHash::hash(bytes, QCryptographicHash::Sha256);
    QFile existing(path);
    const bool cached = existing.open(QIODevice::ReadOnly) && existing.size() == bytes.size()
        && QCryptographicHash::hash(existing.readAll(), QCryptographicHash::Sha256) == digest;
    existing.close();
    if (!cached) {
        QDir().mkpath(cache); QSaveFile file(path);
        if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() || !file.commit()) {
            emit message("não foi possível abrir esse som"); return;
        }
    }
    if (!player_) {
        player_ = new QMediaPlayer(this); audio_ = new QAudioOutput(this); player_->setAudioOutput(audio_);
        audio_->setVolume(volume_ / 100.f); setOutput(output_);
        connect(player_, &QMediaPlayer::errorOccurred, this, [this] { stop(); emit message("não foi possível reproduzir esse som"); });
        connect(player_, &QMediaPlayer::mediaStatusChanged, this, [this](QMediaPlayer::MediaStatus state) {
            if (state == QMediaPlayer::LoadedMedia) player_->setActiveVideoTrack(-1);
            if (state == QMediaPlayer::EndOfMedia) stop();
        });
    }

    // Stop current sound and clear highlight
    stop();

    // Set new playing ID and activate green border highlight (#23a55a)
    currentPlayingId_ = id;
    updatePlayingHighlight(currentPlayingId_, true);

    player_->setSource(QUrl::fromLocalFile(path));
    player_->play();
    deadline_.start(10500);
}

void Soundboard::stop() {
    deadline_.stop();
    if (!currentPlayingId_.isEmpty()) {
        updatePlayingHighlight(currentPlayingId_, false);
        currentPlayingId_.clear();
    }
    if (player_) { player_->stop(); player_->setSource(QUrl()); }
}

void Soundboard::setOutput(const QByteArray& id) {
    output_ = id;
    if (!audio_) return;
    auto selected = QMediaDevices::defaultAudioOutput();
    for (const auto& device : QMediaDevices::audioOutputs()) if (device.id() == id) { selected = device; break; }
    audio_->setDevice(selected);
}

void Soundboard::setDeafened(bool muted) {
    deafened_ = muted;
    if (audio_) audio_->setMuted(muted);
    if (muted) stop();
}

} // namespace triscord

