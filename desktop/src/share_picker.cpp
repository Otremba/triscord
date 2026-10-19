#include "share_picker.h"
#include "discord_icons.h"
#include "screen_quality.h"
#include <QButtonGroup>
#include <QEvent>
#include <QHBoxLayout>
#include <QLabel>
#include <QListWidget>
#include <QMouseEvent>
#include <QPainter>
#include <QPainterPath>
#include <QPushButton>
#include <QScrollBar>
#include <QResizeEvent>
#include <QSettings>
#include <QStackedWidget>
#include <QStyledItemDelegate>
#include <QVBoxLayout>
#include <algorithm>
#ifdef Q_OS_WIN
#include <windows.h>
#endif

namespace triscord {

namespace {

// Geometry and colours measured on Discord's picker at 96 DPI (SHARE.md): modal #0a0a0c, tab bar and SD/HD
// track #000000, gear #44454d (theme-midnight neutral-57).
constexpr int kTileWidth = 439, kTileHeight = 247, kCellWidth = 455, kCellHeight = 297;
constexpr int ThumbnailRole = Qt::UserRole + 1, IconRole = Qt::UserRole + 2;

QPixmap applicationIcon(quintptr handle) {
#ifdef Q_OS_WIN
    const auto hwnd = reinterpret_cast<HWND>(handle);
    DWORD_PTR result = 0;
    HICON icon = nullptr;
    // A hung window must not stall the picker.
    if (SendMessageTimeoutW(hwnd, WM_GETICON, ICON_SMALL2, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 50, &result) && result)
        icon = reinterpret_cast<HICON>(result);
    if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICONSM));
    if (!icon) icon = reinterpret_cast<HICON>(GetClassLongPtrW(hwnd, GCLP_HICON));
    if (icon) return QPixmap::fromImage(QImage::fromHICON(icon));
#else
    Q_UNUSED(handle);
#endif
    return {};
}

class SourceDelegate final : public QStyledItemDelegate {
public:
    SourceDelegate(QObject* parent, const bool* canStart) : QStyledItemDelegate(parent), canStart_(canStart) {}
    QSize sizeHint(const QStyleOptionViewItem&, const QModelIndex&) const override { return {kCellWidth, kCellHeight}; }
    void paint(QPainter* p, const QStyleOptionViewItem& option, const QModelIndex& index) const override {
        p->save();
        p->setRenderHint(QPainter::Antialiasing);
        p->setRenderHint(QPainter::SmoothPixmapTransform);
        const QRect tile(option.rect.topLeft(), QSize(kTileWidth, kTileHeight));
        QPainterPath clip; clip.addRoundedRect(QRectF(tile), 8, 8);
        p->fillPath(clip, Qt::black);
        const QImage thumbnail = index.data(ThumbnailRole).value<QImage>();
        if (!thumbnail.isNull()) {
            const QImage scaled = thumbnail.scaled(tile.size(), Qt::KeepAspectRatio, Qt::SmoothTransformation);
            p->setClipPath(clip);
            p->drawImage(tile.left() + (tile.width() - scaled.width()) / 2, tile.top() + (tile.height() - scaled.height()) / 2, scaled);
            p->setClipping(false);
        }
        const bool hovered = (option.state & QStyle::State_MouseOver) && *canStart_;
        if (hovered) {
            // Observed hover: thumbnail dimmed, 2px outline 2px outside it, white "Compartilhar tela" button.
            p->fillPath(clip, QColor(0, 0, 0, 102));
            p->setPen(QPen(QColor("#34353a"), 2)); p->setBrush(Qt::NoBrush);
            p->drawRoundedRect(QRectF(tile).adjusted(-3, -3, 3, 3), 10, 10);
            const QRect button(tile.center().x() - 77, tile.center().y() - 21 + 1, 155, 42);
            QPainterPath pill; pill.addRoundedRect(QRectF(button), 8, 8);
            p->fillPath(pill, Qt::white);
            QFont f = option.font; f.setPixelSize(14); f.setWeight(QFont::Medium);
            p->setFont(f); p->setPen(Qt::black);
            p->drawText(button, Qt::AlignCenter, "Compartilhar tela");
        }
        // Label: 16px icon at the tile's left edge, name 25px in, centred 17px below the thumbnail.
        const int labelCenter = tile.bottom() + 1 + 17;
        const QPixmap icon = index.data(IconRole).value<QPixmap>();
        if (!icon.isNull()) p->drawPixmap(QRect(tile.left(), labelCenter - 8, 16, 16), icon);
        QFont f = option.font; f.setPixelSize(16); f.setWeight(QFont::Medium);
        p->setFont(f); p->setPen(QColor("#dcdcdf"));
        const QRect text(tile.left() + 25, labelCenter - 11, tile.width() - 25, 22);
        p->drawText(text, Qt::AlignLeft | Qt::AlignVCenter, QFontMetrics(f).elidedText(index.data(Qt::DisplayRole).toString(), Qt::ElideRight, text.width()));
        p->restore();
    }
private:
    const bool* canStart_;
};

// Rows of the "Modo de transmissão" menu: title with optional subtitle and a radio or checkbox at the right.
class ModeRow final : public QWidget {
public:
    enum class Kind { Radio, Check };
    ModeRow(const QString& title, const QString& subtitle, Kind kind, QWidget* parent)
        : QWidget(parent), title_(title), subtitle_(subtitle), kind_(kind) {
        setFixedHeight(subtitle.isEmpty() ? 36 : 52);
        setCursor(Qt::PointingHandCursor);
    }
    void setChecked(bool checked) { checked_ = checked; update(); }
    void setSubtitle(const QString& subtitle) { subtitle_ = subtitle; update(); }
    std::function<void()> activated;
protected:
    void mouseReleaseEvent(QMouseEvent* event) override { if (event->button() == Qt::LeftButton && activated) activated(); }
    void paintEvent(QPaintEvent*) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        QFont title = font(); title.setPixelSize(14); title.setWeight(QFont::DemiBold);
        QFont detail = font(); detail.setPixelSize(12); detail.setWeight(QFont::Medium);
        const int mark = width() - 16 - 20;
        if (subtitle_.isEmpty()) {
            p.setFont(title); p.setPen(QColor("#dcdcdf"));
            p.drawText(QRect(17, 0, mark - 25, height()), Qt::AlignLeft | Qt::AlignVCenter, title_);
        } else {
            p.setFont(title); p.setPen(QColor("#dcdcdf"));
            p.drawText(QRect(17, 16, mark - 25, 20), Qt::AlignLeft | Qt::AlignVCenter, title_);
            p.setFont(detail); p.setPen(QColor("#96979e"));
            p.drawText(QRect(17, 35, mark - 25, 18), Qt::AlignLeft | Qt::AlignVCenter, subtitle_);
        }
        const QRectF box(mark, height() / 2.0 - 10, 20, 20);
        if (kind_ == Kind::Radio) {
            if (checked_) {
                p.setPen(Qt::NoPen); p.setBrush(QColor("#5865f2")); p.drawEllipse(box);
                p.setBrush(Qt::white); p.drawEllipse(box.center(), 4, 4);
            } else {
                p.setPen(QPen(QColor("#96979e"), 2)); p.setBrush(Qt::NoBrush); p.drawEllipse(box.adjusted(1, 1, -1, -1));
            }
        } else {
            QPainterPath square; square.addRoundedRect(box.adjusted(1, 1, -1, -1), 4, 4);
            if (checked_) {
                p.fillPath(square, QColor("#5865f2"));
                p.setPen(QPen(Qt::white, 2, Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin));
                p.drawPolyline(QPolygonF({box.topLeft() + QPointF(5, 10), box.topLeft() + QPointF(9, 14), box.topLeft() + QPointF(15, 6)}));
            } else {
                p.setPen(QPen(QColor("#96979e"), 2)); p.setBrush(Qt::NoBrush); p.drawPath(square);
            }
        }
    }
private:
    QString title_, subtitle_;
    Kind kind_;
    bool checked_ = false;
};

QString qualityLine(SharePicker::Mode mode, bool hd, bool parenthesised) {
    const auto config = mode == SharePicker::Mode::Game ? screenPreset(hd ? 1080 : 720, hd ? 60 : 30) : screenPreset(hd ? 1080 : 720, 15);
    const QString res = QString::number(config.size.height()) + "p", fps = QString::number(config.fps) + "fps";
    const QString lead = mode == SharePicker::Mode::Game ? "Vídeo mais suave" : "Texto mais claro";
    return parenthesised ? QString("%1 (%2, %3)").arg(lead, res, fps) : QString("%1 · %2 · %3").arg(lead, res, fps);
}

} // namespace

SharePicker::SharePicker(QWidget* parent) : QDialog(parent) {
    setObjectName("shareSourceDialog");
    setWindowTitle("Compartilhar Tela");
    setAttribute(Qt::WA_StyledBackground);
    QSettings settings;
    mode_ = settings.value("shareMode", "game").toString() == "screen" ? Mode::Screen : Mode::Game;
    hd_ = settings.value("shareResolution", 720).toInt() >= 1080;
    audioMuted_ = !settings.value("shareSystemAudio", false).toBool();

    setStyleSheet(
        "QDialog#shareSourceDialog { background: rgba(0,0,0,184); }"
        "QWidget#sharePickerPanel { background:#0a0a0c; border:1px solid #48484d; border-radius:8px; }"
        "QWidget#shareSourceTabs, QWidget#shareQualityToggle { background:#000000; border-radius:8px; }"
        "QWidget#shareSourceTabs QPushButton { background:transparent; border:none; border-radius:4px; color:#96979e; font-size:14px; font-weight:600; }"
        "QWidget#shareSourceTabs QPushButton:checked { background:#0a0a0c; color:#dcdcdf; }"
        "QWidget#shareQualityToggle QPushButton { background:transparent; border:none; border-radius:4px; color:#96979e; font-size:14px; font-weight:600; }"
        "QWidget#shareQualityToggle QPushButton:checked { background:#0a0a0c; color:#dcdcdf; }"
        "QPushButton#shareModeButton { background:#262629; border:none; border-radius:8px; }"
        "QListWidget { background:transparent; border:none; outline:none; }"
        "QListWidget QScrollBar:vertical { width:8px; background:transparent; margin:0; }"
        "QListWidget QScrollBar::handle:vertical { background:#48484d; border-radius:4px; min-height:32px; }"
        "QListWidget QScrollBar::add-line:vertical, QListWidget QScrollBar::sub-line:vertical { height:0; }"
        "QListWidget QScrollBar::add-page:vertical, QListWidget QScrollBar::sub-page:vertical { background:transparent; }"
        "QLabel#shareModeTitle { color:#dcdcdf; font-size:16px; font-weight:700; background:transparent; }"
        "QLabel#shareModeSubtitle { color:#81828a; font-size:12px; background:transparent; }");

    auto* panel = new QWidget(this);
    panel_ = panel;
    panel->setObjectName("sharePickerPanel");
    panel->setAttribute(Qt::WA_StyledBackground);

    auto* root = new QVBoxLayout(panel);
    root->setContentsMargins(0, 0, 0, 0);
    root->setSpacing(0);
    root->addSpacing(25);

    // Segmented tabs: 40px track, 4px inset, 32px selected segment; icon 16px, text 10px after it.
    auto* tabsRow = new QHBoxLayout;
    tabsRow->setContentsMargins(25, 0, 25, 0);
    auto* tabs = new QWidget(panel);
    tabs->setObjectName("shareSourceTabs");
    tabs->setAttribute(Qt::WA_StyledBackground);
    tabs->setFixedHeight(40);
    auto* tabsLayout = new QHBoxLayout(tabs);
    tabsLayout->setContentsMargins(4, 4, 4, 4);
    tabsLayout->setSpacing(0);
    auto* tabGroup = new QButtonGroup(this);
    const struct { const char* name; const char* text; DiscordIcons::IconType icon; } tabSpecs[] = {
        {"shareTabWindows", "Aplicativos", DiscordIcons::IconType::Browser},
        {"shareTabMonitors", "Tela Inteira", DiscordIcons::IconType::ScreenShare}};
    for (int n = 0; n < 2; ++n) {
        auto* tab = new QPushButton(QString::fromUtf8(tabSpecs[n].text), tabs);
        tab->setObjectName(tabSpecs[n].name);
        tab->setCheckable(true);
        tab->setFixedHeight(32);
        tab->setCursor(Qt::PointingHandCursor);
        tab->setIcon(DiscordIcons::icon(tabSpecs[n].icon, QColor("#96979e"), 16));
        tab->setIconSize(QSize(16, 16));
        tabGroup->addButton(tab, n);
        tabsLayout->addWidget(tab, 1);
    }
    tabGroup->button(0)->setChecked(true);
    tabsRow->addWidget(tabs);
    root->addLayout(tabsRow);
    root->addSpacing(24);

    pages_ = new QStackedWidget(panel);
    windows_ = new QListWidget(pages_);
    monitors_ = new QListWidget(pages_);
    windows_->setObjectName("shareWindows");
    monitors_->setObjectName("shareMonitors");
    for (auto* list : {windows_, monitors_}) {
        list->setViewMode(QListView::IconMode);
        list->setMovement(QListView::Static);
        list->setResizeMode(QListView::Adjust);
        list->setGridSize({kCellWidth, kCellHeight});
        list->setSpacing(0);
        list->setUniformItemSizes(true);
        list->setMouseTracking(true);
        list->viewport()->setAttribute(Qt::WA_Hover);
        list->setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
        list->setVerticalScrollMode(QAbstractItemView::ScrollPerPixel);
        list->setSelectionMode(QAbstractItemView::NoSelection);
        list->setItemDelegate(new SourceDelegate(list, &canStart_));
        list->viewport()->setCursor(Qt::PointingHandCursor);
        connect(list, &QListWidget::itemClicked, this, [this](QListWidgetItem* item) { start(item->data(Qt::UserRole).toInt()); });
        pages_->addWidget(list);
    }
    connect(tabGroup, &QButtonGroup::idClicked, pages_, &QStackedWidget::setCurrentIndex);
    auto* listRow = new QHBoxLayout;
    listRow->setContentsMargins(25, 0, 5, 0);
    listRow->addWidget(pages_);
    root->addLayout(listRow, 1);
    root->addSpacing(17);

    // Stream mode block: title and subtitle at the left, SD/HD and the mode menu button at the right.
    auto* bottom = new QHBoxLayout;
    bottom->setContentsMargins(25, 0, 25, 0);
    bottom->setSpacing(0);
    auto* text = new QVBoxLayout;
    text->setContentsMargins(0, 0, 0, 0);
    text->setSpacing(2);
    modeTitle_ = new QLabel(panel); modeTitle_->setObjectName("shareModeTitle"); modeTitle_->setFixedHeight(20);
    modeSubtitle_ = new QLabel(panel); modeSubtitle_->setObjectName("shareModeSubtitle"); modeSubtitle_->setFixedHeight(18);
    text->addWidget(modeTitle_);
    text->addWidget(modeSubtitle_);
    bottom->addLayout(text, 1);
    auto* quality = new QWidget(panel);
    quality->setObjectName("shareQualityToggle");
    quality->setAttribute(Qt::WA_StyledBackground);
    quality->setFixedSize(110, 40);
    auto* qualityLayout = new QHBoxLayout(quality);
    qualityLayout->setContentsMargins(5, 4, 5, 4);
    qualityLayout->setSpacing(0);
    auto* qualityGroup = new QButtonGroup(this);
    sd_ = new QPushButton("SD", quality); sd_->setObjectName("shareQualitySd");
    hdButton_ = new QPushButton("HD", quality); hdButton_->setObjectName("shareQualityHd");
    for (auto* button : {sd_, hdButton_}) {
        button->setCheckable(true); button->setFixedHeight(32); button->setCursor(Qt::PointingHandCursor);
        qualityGroup->addButton(button); qualityLayout->addWidget(button, 1);
    }
    connect(sd_, &QPushButton::clicked, this, [this] { setHd(false); });
    connect(hdButton_, &QPushButton::clicked, this, [this] { setHd(true); });
    bottom->addWidget(quality, 0, Qt::AlignTop);
    bottom->addSpacing(9);
    gear_ = new QPushButton(panel);
    gear_->setObjectName("shareModeButton");
    gear_->setFixedSize(40, 40);
    gear_->setCursor(Qt::PointingHandCursor);
    gear_->setIcon(DiscordIcons::icon(DiscordIcons::IconType::Settings, Qt::white, 20));
    gear_->setIconSize(QSize(20, 20));
    connect(gear_, &QPushButton::clicked, this, &SharePicker::showModeMenu);
    bottom->addWidget(gear_, 0, Qt::AlignTop);
    root->addLayout(bottom);
    root->addSpacing(73);
    refreshQuality();
}

QPixmap SharePicker::sourceIcon(const CaptureSource& source) {
    return source.kind == CaptureSource::Kind::Monitor ? DiscordIcons::pixmap(DiscordIcons::IconType::ScreenShare, QColor("#96979e"), 16)
                                                       : applicationIcon(source.handle);
}

void SharePicker::present(QWidget* window) {
    if (window && parentWidget() != window) {
        if (covered_) covered_->removeEventFilter(this);
        setParent(window, Qt::Widget);
        covered_ = window;
        window->installEventFilter(this);
    }
    if (covered_) setGeometry(covered_->rect());
    show();
    raise();
    setFocus(Qt::OtherFocusReason);
}

void SharePicker::resizeEvent(QResizeEvent* event) {
    QDialog::resizeEvent(event);
    // Observed: 960x746 centred over the window; smaller windows keep a 16px margin.
    const QSize size(std::min(960, std::max(0, width() - 32)), std::min(746, std::max(0, height() - 32)));
    panel_->setGeometry(QRect(QPoint((width() - size.width()) / 2, (height() - size.height()) / 2), size));
}

bool SharePicker::eventFilter(QObject* watched, QEvent* event) {
    if (watched == covered_ && event->type() == QEvent::Resize) setGeometry(covered_->rect());
    return QDialog::eventFilter(watched, event);
}

void SharePicker::setSources(const QVector<CaptureSource>& sources) {
    QSignalBlocker windowsBlock(windows_), monitorsBlock(monitors_);
    windows_->clear();
    monitors_->clear();
    const QPixmap monitorIcon = DiscordIcons::pixmap(DiscordIcons::IconType::ScreenShare, QColor("#96979e"), 16);
    int monitorNumber = 0;
    for (int n = 0; n < sources.size(); ++n) {
        const auto& source = sources[n];
        const bool monitor = source.kind == CaptureSource::Kind::Monitor;
        auto* item = new QListWidgetItem(monitor ? QString("Tela %1").arg(++monitorNumber) : source.name.mid(QStringLiteral("Janela — ").size()),
                                         monitor ? monitors_ : windows_);
        item->setData(Qt::UserRole, n);
        item->setData(IconRole, monitor ? monitorIcon : applicationIcon(source.handle));
        item->setSizeHint({kCellWidth, kCellHeight});
    }
}

void SharePicker::setThumbnail(int sourceIndex, const QImage& image) {
    for (auto* list : {windows_, monitors_})
        for (int n = 0; n < list->count(); ++n)
            if (list->item(n)->data(Qt::UserRole).toInt() == sourceIndex) { list->item(n)->setData(ThumbnailRole, image); return; }
}

void SharePicker::setCanStart(bool canStart) {
    canStart_ = canStart;
    windows_->viewport()->update();
    monitors_->viewport()->update();
}

VideoConfig SharePicker::config() const {
    return mode_ == Mode::Game ? screenPreset(hd_ ? 1080 : 720, hd_ ? 60 : 30) : screenPreset(hd_ ? 1080 : 720, 15);
}

QString SharePicker::subtitle() const { return qualityLine(mode_, hd_, false); }

void SharePicker::setMode(Mode mode) { mode_ = mode; refreshQuality(); }
void SharePicker::setHd(bool hd) { hd_ = hd; refreshQuality(); }

void SharePicker::refreshQuality() {
    modeTitle_->setText(mode_ == Mode::Game ? "Jogos" : "Compartilhamento de tela");
    modeSubtitle_->setText(subtitle());
    sd_->setChecked(!hd_);
    hdButton_->setChecked(hd_);
}

void SharePicker::showModeMenu() {
    auto* menu = new QFrame(this, Qt::Popup | Qt::FramelessWindowHint | Qt::NoDropShadowWindowHint);
    menu->setObjectName("shareModeMenu");
    menu->setAttribute(Qt::WA_DeleteOnClose);
    menu->setAttribute(Qt::WA_TranslucentBackground);
    menu->setFixedWidth(245);
    auto* outer = new QVBoxLayout(menu);
    outer->setContentsMargins(0, 0, 0, 0);
    auto* body = new QWidget(menu);
    body->setObjectName("shareModeMenuBody");
    body->setAttribute(Qt::WA_StyledBackground);
    body->setStyleSheet("QWidget#shareModeMenuBody { background:#0a0a0c; border:1px solid #48484d; border-radius:8px; }"
                        "QLabel { color:#96979e; font-size:14px; background:transparent; }"
                        "QWidget#shareModeSeparator { background:#262629; }");
    outer->addWidget(body);
    auto* layout = new QVBoxLayout(body);
    layout->setContentsMargins(0, 8, 0, 8);
    layout->setSpacing(0);
    auto* header = new QLabel("Modo de transmissão", body);
    header->setFixedHeight(27);
    header->setContentsMargins(17, 0, 0, 6);
    layout->addWidget(header);
    auto* game = new ModeRow("Jogos", qualityLine(Mode::Game, hd_, true), ModeRow::Kind::Radio, body);
    auto* screen = new ModeRow("Compartilhamento de tela", qualityLine(Mode::Screen, hd_, true), ModeRow::Kind::Radio, body);
    game->setObjectName("shareModeGame");
    screen->setObjectName("shareModeScreen");
    game->setChecked(mode_ == Mode::Game);
    screen->setChecked(mode_ == Mode::Screen);
    layout->addWidget(game);
    layout->addWidget(screen);
    layout->addSpacing(18);
    auto* separator = new QWidget(body);
    separator->setObjectName("shareModeSeparator");
    separator->setAttribute(Qt::WA_StyledBackground);
    separator->setFixedHeight(1);
    auto* separatorRow = new QHBoxLayout;
    separatorRow->setContentsMargins(8, 0, 8, 0);
    separatorRow->addWidget(separator);
    layout->addLayout(separatorRow);
    layout->addSpacing(7);
    auto* mute = new ModeRow("Silenciar áudio da transmissão", QString(), ModeRow::Kind::Check, body);
    mute->setObjectName("shareMuteStreamAudio");
    mute->setChecked(audioMuted_);
    layout->addWidget(mute);
    game->activated = [this, game, screen] { setMode(Mode::Game); game->setChecked(true); screen->setChecked(false); };
    screen->activated = [this, game, screen] { setMode(Mode::Screen); game->setChecked(false); screen->setChecked(true); };
    mute->activated = [this, mute] { audioMuted_ = !audioMuted_; mute->setChecked(audioMuted_); };
    menu->adjustSize();
    // Observed: right-aligned with the button, bottom 10px above it.
    menu->move(gear_->mapToGlobal(QPoint(gear_->width() - menu->width(), -10 - menu->height())));
    menu->show();
}

void SharePicker::start(int sourceIndex) {
    if (!canStart_ || sourceIndex < 0) return;
    QSettings settings;
    settings.setValue("shareMode", mode_ == Mode::Game ? "game" : "screen");
    settings.setValue("shareResolution", config().size.height());
    settings.setValue("shareFps", config().fps);
    settings.setValue("shareSystemAudio", !audioMuted_);
    emit startRequested(sourceIndex, !audioMuted_, config());
    accept();
}

} // namespace triscord
