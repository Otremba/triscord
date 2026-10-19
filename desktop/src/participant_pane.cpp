#include "participant_pane.h"
#include "call_grid.h"
#include "discord_icons.h"
#include <QScrollArea>
#include <QPainter>
#include <QPainterPath>
#include <QKeyEvent>
#include <QJsonObject>
#include <QResizeEvent>
#include <algorithm>

namespace triscord {

namespace {
// Geometry measured on the real focused viewer (SHARE.md, 1264x892 client): filmstrip tiles 195x112 with 8px
// gaps whose top is 201px above the bottom of the stage area, the stage area shrinks by 119px while the
// filmstrip is open, the toggle is 62x32, the zoom button 30x30 13px from the stage corner, and the
// collapsed view keeps only the user's own tile as a 162x92 preview.
constexpr int kFilmWidth = 195, kFilmHeight = 112, kFilmGap = 8, kFilmTopFromBottom = 201, kFilmReserve = 119;
constexpr int kGridPadding = 15;
constexpr int kToggleWidth = 62, kToggleHeight = 32, kZoomSize = 30, kPreviewWidth = 162, kPreviewHeight = 92;

QString qualityText(const QImage& frame, int fps, bool lowercase) {
    if (frame.isNull()) return {};
    QString text = QString::number(frame.height()) + (lowercase ? "p" : "P");
    if (fps > 0) text += QString(" %1FPS").arg(fps);
    return text;
}

// Pill used for the badges: 16px tall, radius 4, 11px bold white text.
int drawBadge(QPainter& p, const QFont& base, int right, int top, const QString& text, const QColor& fill) {
    QFont f = base; f.setPixelSize(11); f.setWeight(QFont::Bold);
    const QFontMetrics fm(f);
    const int width = fm.horizontalAdvance(text) + 14;
    QPainterPath path; path.addRoundedRect(QRectF(right - width, top, width, 16), 4, 4);
    p.fillPath(path, fill);
    p.setFont(f); p.setPen(Qt::white);
    p.drawText(QRect(right - width, top, width, 16), Qt::AlignCenter, text);
    return width;
}
} // namespace

ParticipantPane::ParticipantPane(QWidget* parent) : QWidget(parent) {
    setObjectName("participantCards"); hide(); setFocusPolicy(Qt::StrongFocus); setMouseTracking(true);
    setSizePolicy(QSizePolicy::Expanding, QSizePolicy::Preferred);
    if (auto* scroll = qobject_cast<QScrollArea*>(parent)) {
        viewport_ = scroll->viewport(); viewport_->installEventFilter(this);
    }
}

bool ParticipantPane::eventFilter(QObject* watched, QEvent* event) {
    if (watched == viewport_ && event->type() == QEvent::Resize) { updateHeight(); update(); }
    return QWidget::eventFilter(watched, event);
}

void ParticipantPane::rebuildTiles() {
    tiles_.clear();
    for (int i = 0; i < streams_.size(); ++i) tiles_.push_back({streamKey(streams_[i].id), true, i});
    for (int i = 0; i < users_.size(); ++i) tiles_.push_back({users_[i].toObject().value("socketId").toString(), false, i});
    QSet<QString> live; for (const auto& tile : tiles_) live.insert(tile.key);
    for (auto it = frames_.begin(); it != frames_.end();) {
        if (!live.contains(it.key())) { rendered_.remove(it.key()); it = frames_.erase(it); } else ++it;
    }
    if (!live.contains(focused_)) clearFocusPeer();
    if (!live.contains(clicked_)) clicked_.clear();
    setVisible(!tiles_.isEmpty());
    updateHeight(); update();
}

void ParticipantPane::setParticipants(const QJsonArray& users) {
    if (users_ == users) return;
    users_ = users;
    QSet<QString> liveUsers; for (const auto& value : users_) liveUsers.insert(value.toObject().value("socketId").toString());
    speaking_.intersect(liveUsers);
    rebuildTiles();
}

void ParticipantPane::setStreams(const QVector<StreamTile>& streams) {
    bool same = streams.size() == streams_.size();
    for (int i = 0; same && i < streams.size(); ++i)
        same = streams[i].id == streams_[i].id && streams[i].name == streams_[i].name && streams[i].fps == streams_[i].fps;
    if (same) return;
    streams_ = streams;
    rebuildTiles();
}

void ParticipantPane::setFrame(const QString& peer, const QImage& image) {
    if (image.isNull()) return;
    for (int i = 0; i < tiles_.size(); ++i) if (!tiles_[i].stream && tiles_[i].key == peer) {
        auto& timer = rendered_[peer];
        if (timer.isValid() && timer.elapsed() < (focused_ == peer ? 33 : 200)) return;
        timer.start();
        const bool sizeChanged = frames_.value(peer).size() != image.size();
        frames_[peer] = image; update(); Q_UNUSED(sizeChanged); return;
    }
}

void ParticipantPane::setStreamFrame(const QString& streamId, const QImage& image) {
    const QString key = streamKey(streamId);
    if (image.isNull()) return;
    for (const auto& tile : tiles_) if (tile.key == key) {
        auto& timer = rendered_[key];
        if (timer.isValid() && timer.elapsed() < (focused_ == key ? 33 : 200)) return;
        timer.start();
        frames_[key] = image; update(); return;
    }
}

void ParticipantPane::removeFrame(const QString& peer) {
    rendered_.remove(peer);
    if (frames_.remove(peer)) update();
    if (focused_ == peer) clearFocusPeer();
    if (clicked_ == peer) clicked_.clear();
}

void ParticipantPane::removeStreamFrame(const QString& streamId) { removeFrame(streamKey(streamId)); }

void ParticipantPane::clearFocusPeer() {
    if (focused_.isEmpty()) return;
    focused_.clear(); updateHeight(); update(); emit focusChanged({});
}

QString ParticipantPane::nameFor(const Tile& tile) const {
    return tile.stream ? streams_[tile.index].name : users_[tile.index].toObject().value("username").toString();
}

QImage ParticipantPane::frameFor(const Tile& tile) const { return frames_.value(tile.key); }

QSize ParticipantPane::contentSize(const Tile& tile) const {
    const QImage image = frameFor(tile);
    return image.isNull() ? QSize(16, 9) : image.size();
}

ParticipantPane::FocusInfo ParticipantPane::focusInfo() const {
    for (const auto& tile : tiles_) if (tile.key == focused_) {
        FocusInfo info; info.stream = tile.stream;
        info.owner = nameFor(tile); info.color = QColor("#5865f2");
        for (const auto& value : users_) {
            const auto user = value.toObject();
            if (user.value("username").toString() != info.owner && user.value("socketId").toString() != tile.key) continue;
            const QColor color(user.value("avatar").toString()); if (color.isValid()) info.color = color;
            break;
        }
        info.title = tile.stream ? QString("Tela de %1").arg(info.owner) : info.owner;
        if (tile.stream) info.quality = qualityText(frameFor(tile), streams_[tile.index].fps, true);
        return info;
    }
    return {};
}

ParticipantPane::Layout ParticipantPane::computeLayout() const {
    Layout layout; layout.tiles.resize(tiles_.size());
    if (tiles_.isEmpty()) return layout;
    const int w = width(), h = height();
    int focusedIndex = -1;
    for (int i = 0; i < tiles_.size(); ++i) if (tiles_[i].key == focused_) focusedIndex = i;
    if (focusedIndex < 0) {
        // Measured on the real grid (SHARE.md): the cards live in a box 15px shorter at the top and the bottom,
        // and an incomplete last row is centred (cards of 643px with two items, 432px with three).
        const int n = tiles_.size(), padding = n > 25 ? 0 : kGridPadding;
        const auto grid = callGrid(n, w, std::max(1, h - 2 * padding));
        const int used = grid.columns * grid.tileWidth + (grid.columns - 1) * 8;
        const int left = std::max(8, (w - used + 1) / 2);
        for (int i = 0; i < tiles_.size(); ++i) {
            QRect slot = grid.tile(i);
            const int row = i / grid.columns, inRow = row == grid.rows - 1 ? n - row * grid.columns : grid.columns;
            slot.translate(left - grid.left + (grid.columns - inRow) * (grid.tileWidth + 8) / 2, padding);
            if (tiles_[i].stream) {
                // Observed: a shared screen keeps its own aspect ratio, centred inside its 16:9 slot.
                const QSize fitted = contentSize(tiles_[i]).scaled(slot.size(), Qt::KeepAspectRatio);
                slot = QRect(slot.left() + (slot.width() - fitted.width()) / 2, slot.top() + (slot.height() - fitted.height()) / 2, fitted.width(), fitted.height());
            }
            layout.tiles[i] = {slot, Role::Grid};
        }
        return layout;
    }
    const bool others = tiles_.size() > 1;
    layout.expanded = filmstripExpanded_;
    const int reserved = others && filmstripExpanded_ ? kFilmReserve : 0;
    const QSize area(w, std::max(1, h - reserved));
    const QSize size = contentSize(tiles_[focusedIndex]).scaled(area, Qt::KeepAspectRatio);
    const QRect stage((area.width() - size.width()) / 2, (area.height() - size.height()) / 2, size.width(), size.height());
    layout.tiles[focusedIndex] = {stage, Role::Stage};
    layout.zoom = QRect(stage.right() - 13 - (kZoomSize - 1), stage.bottom() - 13 - (kZoomSize - 1), kZoomSize, kZoomSize);
    if (!others) return layout;
    const int top = h - kFilmTopFromBottom;
    if (filmstripExpanded_) {
        const int fit = std::max(1, (w + kFilmGap) / (kFilmWidth + kFilmGap));
        const int count = std::min<int>(fit, tiles_.size());
        const int total = count * kFilmWidth + (count - 1) * kFilmGap;
        int x = (w - total) / 2;
        for (int i = 0; i < count; ++i) { layout.film.push_back({i, QRect(x, top, kFilmWidth, kFilmHeight)}); x += kFilmWidth + kFilmGap; }
        layout.toggle = QRect(w / 2 - kToggleWidth / 2, top + 8, kToggleWidth, kToggleHeight);
    } else {
        layout.toggle = QRect(w / 2 - kToggleWidth / 2, h - 188, kToggleWidth, kToggleHeight);
        for (int i = 0; i < tiles_.size(); ++i)
            if (i != focusedIndex && !tiles_[i].stream && tiles_[i].key == localId_)
                layout.tiles[i] = {QRect(w - 16 - kPreviewWidth, h - 20 - kPreviewHeight, kPreviewWidth, kPreviewHeight), Role::Preview};
    }
    return layout;
}

QRect ParticipantPane::tileRect(const QString& key) const {
    const auto layout = computeLayout();
    for (int i = 0; i < tiles_.size(); ++i) if (tiles_[i].key == key) {
        if (!layout.tiles[i].rect.isNull()) return layout.tiles[i].rect;
        for (const auto& entry : layout.film) if (entry.first == i) return entry.second;
    }
    return {};
}

QRect ParticipantPane::cardRect(int index) const {
    const auto layout = computeLayout();
    return index >= 0 && index < layout.tiles.size() ? layout.tiles[index].rect : QRect();
}

int ParticipantPane::tileIndexAt(const QPoint& position, const Layout& layout, bool* film) const {
    if (film) *film = false;
    for (const auto& entry : layout.film) if (entry.second.contains(position)) { if (film) *film = true; return entry.first; }
    for (Role role : {Role::Preview, Role::Stage, Role::Grid})
        for (int i = 0; i < layout.tiles.size(); ++i)
            if (layout.tiles[i].role == role && layout.tiles[i].rect.contains(position)) return i;
    return -1;
}

void ParticipantPane::setSpeaking(const QString& peer, bool speaking) {
    bool known = false; for (const auto& tile : tiles_) if (!tile.stream && tile.key == peer) { known = true; break; }
    if (!known || speaking_.contains(peer) == speaking) return;
    if (speaking) speaking_.insert(peer); else speaking_.remove(peer);
    update();
}

void ParticipantPane::updateHeight() {
    const int nextHeight = viewport_ ? std::max(1, viewport_->height()) : std::max(180, width() * 9 / 16);
    if (height() != nextHeight) { setFixedHeight(nextHeight); emit cardsHeightChanged(nextHeight); }
}

void ParticipantPane::resizeEvent(QResizeEvent* event) {
    QWidget::resizeEvent(event); updateHeight();
}

void ParticipantPane::mousePressEvent(QMouseEvent* event) {
    const Layout layout = computeLayout();
    if (event->button() == Qt::LeftButton) {
        clicked_.clear();
        if (!layout.toggle.isNull() && layout.toggle.contains(event->pos())) {
            filmstripExpanded_ = !filmstripExpanded_; update(); event->accept(); return;
        }
        if (!layout.zoom.isNull() && layout.zoom.contains(event->pos())) {
            // Inferred: the zoom button opens the enlarged viewer (its behaviour was not observed).
            for (const auto& tile : tiles_) if (tile.key == focused_ && frames_.contains(tile.key))
                emit fullscreenRequested(tile.key, nameFor(tile), frames_.value(tile.key));
            event->accept(); return;
        }
        bool film = false;
        const int i = tileIndexAt(event->pos(), layout, &film);
        if (i >= 0) {
            const auto& tile = tiles_[i];
            if (!tile.stream && !film && layout.tiles[i].role == Role::Grid && hovered_ == i && !layout.tiles[i].rect.isNull()) {
                const QRect more(layout.tiles[i].rect.right() - 13 - 29, layout.tiles[i].rect.bottom() - 13 - 29, 30, 30);
                if (more.contains(event->pos())) {
                    emit participantContextMenuRequested(tile.key, nameFor(tile), event->globalPosition().toPoint());
                    event->accept(); return;
                }
            }
            clicked_ = tile.key; setFocus();
            // Clicking the focused stage goes back to the grid; a filmstrip tile moves the focus to that tile.
            if (focused_ == tile.key && !film) clearFocusPeer();
            else if (focused_ != tile.key) { focused_ = tile.key; updateHeight(); update(); emit focusChanged(tile.key); }
            event->accept(); return;
        }
    }
    if (event->button() == Qt::RightButton) {
        const int i = tileIndexAt(event->pos(), layout);
        if (i >= 0 && !tiles_[i].stream) {
            emit participantContextMenuRequested(tiles_[i].key, nameFor(tiles_[i]), event->globalPosition().toPoint());
            return;
        }
    }
    QWidget::mousePressEvent(event);
}

void ParticipantPane::mouseDoubleClickEvent(QMouseEvent* event) {
    if (event->button() == Qt::LeftButton) {
        const Layout layout = computeLayout();
        const int at = tileIndexAt(event->pos(), layout);
        for (int i = 0; i < tiles_.size(); ++i) {
            const auto& tile = tiles_[i];
            if ((clicked_ == tile.key || (clicked_.isEmpty() && at == i)) && frames_.contains(tile.key)) {
                emit fullscreenRequested(tile.key, nameFor(tile), frames_.value(tile.key)); event->accept(); return;
            }
        }
    }
    QWidget::mouseDoubleClickEvent(event);
}

void ParticipantPane::mouseMoveEvent(QMouseEvent* event) {
    bool film = false;
    const int hovered = tileIndexAt(event->pos(), computeLayout(), &film);
    if (hovered != hovered_ || film != hoveredFilm_) { hovered_ = hovered; hoveredFilm_ = film; update(); }
    QWidget::mouseMoveEvent(event);
}

void ParticipantPane::leaveEvent(QEvent* event) {
    if (hovered_ != -1) { hovered_ = -1; update(); }
    QWidget::leaveEvent(event);
}

void ParticipantPane::keyPressEvent(QKeyEvent* event) {
    if (event->key() == Qt::Key_Escape) { clearFocusPeer(); event->accept(); return; }
    QWidget::keyPressEvent(event);
}

void ParticipantPane::drawUser(QPainter& p, const Tile& tile, const Placed& placed, bool hovered, bool stage) const {
    // Participant card observed in Discord (desktop/out/claude-observations/CALLS.md): 16:9, radius 8, no
    // border at rest, 80px avatar centred; status pill 32x28 (radius 4) 12px from the bottom-left corner,
    // which becomes a 32px pill with the name on hover. In the focused view every tile shows its name.
    const auto user = users_[tile.index].toObject();
    const QRect card = placed.rect;
    const bool small = placed.role == Role::Filmstrip || placed.role == Role::Preview;
    const bool speaking = speaking_.contains(tile.key) && !user.value("isMuted").toBool() && !user.value("isDeafened").toBool();
    const auto image = frames_.value(tile.key);
    const auto name = user.value("username").toString();
    // Fail closed: when the server does not say whether this user is
    // authenticated, we do not know that they are, so we must not imply it.
    // Against an older hub that never sends the field nobody is authenticated
    // anyway, so marking everyone unverified is also the accurate reading.
    const bool authenticated = user.value("authenticated").toBool(false);
    const bool isMuted = user.value("isMuted").toBool(), isDeafened = user.value("isDeafened").toBool();
    QPainterPath shape; shape.addRoundedRect(QRectF(card), stage ? 0 : 8, stage ? 0 : 8);
    if (!image.isNull()) {
        p.save(); p.setClipPath(shape); p.fillRect(card, Qt::black);
        const QSize size = image.size().scaled(card.size(), Qt::KeepAspectRatio);
        p.drawImage(QRect(card.center().x() - size.width() / 2, card.center().y() - size.height() / 2, size.width(), size.height()), image);
        p.restore();
    } else {
        p.fillPath(shape, QColor("#3a3a39"));
        const int avatarSize = std::min(80, std::max(24, card.height() - 32));
        const QRect avatar(card.center().x() - avatarSize / 2, card.center().y() - avatarSize / 2, avatarSize, avatarSize);
        QColor avatarColor(user.value("avatar").toString());
        if (!avatarColor.isValid()) avatarColor = QColor("#5865f2");
        p.setPen(Qt::NoPen); p.setBrush(avatarColor); p.drawEllipse(avatar);
        p.setPen(Qt::white);
        QFont textFont = font(); textFont.setPixelSize(std::max(12, avatarSize * 2 / 5)); textFont.setBold(true);
        p.setFont(textFont); p.drawText(avatar, Qt::AlignCenter, name.left(1).toUpper());
    }
    if (speaking) {
        p.setBrush(Qt::NoBrush); p.setPen(QPen(QColor("#23a55a"), 2));
        p.drawRoundedRect(QRectF(card).adjusted(1, 1, -1, -1), stage ? 0 : 8, stage ? 0 : 8);
    }
    const bool showName = hovered || stage || small;
    const bool hasStatus = isDeafened || isMuted;
    if (hasStatus || showName) {
        QFont nameFont = font(); nameFont.setPixelSize(small ? 14 : 16); nameFont.setWeight(QFont::Medium);
        const QFontMetrics fm(nameFont);
        const int pillHeight = small ? 28 : (showName ? 32 : 28);
        const int iconWidth = hasStatus ? (small ? 24 : 28) : 8;
        int pillWidth = hasStatus ? 32 : 8;
        QString shown;
        // Quiet "not verified" marker for guests the server could not match
        // to a signed-in account (authenticated: false); de-emphasised with
        // the theme's --text-muted token (#81828a), never an alarming color.
        const QString marker = (showName && !authenticated) ? QStringLiteral(" · não verificado") : QString();
        int markerWidth = marker.isEmpty() ? 0 : fm.horizontalAdvance(marker);
        if (showName) {
            const int available = std::max(0, card.width() - 24 - iconWidth - 8 - markerWidth);
            shown = fm.elidedText(name, Qt::ElideRight, available);
            pillWidth = iconWidth + fm.horizontalAdvance(shown) + markerWidth + 8;
        }
        const int margin = showName ? 12 : 14;
        const QRect pill(card.left() + 12, card.bottom() - margin - pillHeight + 1, pillWidth, pillHeight);
        p.setPen(Qt::NoPen); p.setBrush(QColor(0, 0, 0, 145)); p.drawRoundedRect(pill, 4, 4);
        if (hasStatus) {
            const int icon = small ? 16 : 20;
            DiscordIcons::paint(&p, isDeafened ? DiscordIcons::IconType::HeadphonesDeafened : DiscordIcons::IconType::MicrophoneMuted,
                                QRectF(pill.left() + 6, pill.top() + (pillHeight - icon) / 2.0, icon, icon), Qt::white);
        }
        if (showName) {
            p.setFont(nameFont); p.setPen(Qt::white);
            p.drawText(QRect(pill.left() + iconWidth, pill.top(), fm.horizontalAdvance(shown) + 1, pillHeight), Qt::AlignLeft | Qt::AlignVCenter, shown);
            if (!marker.isEmpty()) {
                p.setPen(QColor("#81828a"));
                p.drawText(QRect(pill.left() + iconWidth + fm.horizontalAdvance(shown), pill.top(), markerWidth + 1, pillHeight),
                           Qt::AlignLeft | Qt::AlignVCenter, marker);
            }
        }
    }
    if (hovered && placed.role == Role::Grid) {
        // Observed: a "..." button at the bottom-right opens the participant's menu (the same one as right-click).
        const QRect more(card.right() - 13 - 29, card.bottom() - 13 - 29, 30, 30);
        p.setPen(Qt::NoPen); p.setBrush(QColor(0, 0, 0, 145)); p.drawRoundedRect(more, 4, 4);
        DiscordIcons::paint(&p, DiscordIcons::IconType::MoreHorizontal, QRectF(more.left() + 5, more.top() + 5, 20, 20), Qt::white);
    }
}

void ParticipantPane::drawStream(QPainter& p, const Tile& tile, const Placed& placed, bool hovered) const {
    const QRect rect = placed.rect;
    const bool stage = placed.role == Role::Stage;
    const bool small = placed.role == Role::Filmstrip || placed.role == Role::Preview;
    const auto& stream = streams_[tile.index];
    const QImage image = frames_.value(tile.key);
    QPainterPath shape; shape.addRoundedRect(QRectF(rect), stage ? 0 : 8, stage ? 0 : 8);
    p.save(); p.setClipPath(shape);
    p.fillRect(rect, small ? QColor("#1b1c20") : QColor("#2c2d35"));
    if (!image.isNull()) {
        const QSize size = image.size().scaled(rect.size(), Qt::KeepAspectRatio);
        p.drawImage(QRect(rect.center().x() - size.width() / 2, rect.center().y() - size.height() / 2, size.width(), size.height()), image);
    }
    p.restore();
    if (small) {
        // Observed filmstrip thumbnail: the screen glyph centred over the picture.
        DiscordIcons::paint(&p, DiscordIcons::IconType::ScreenShare, QRectF(rect.center().x() - 14, rect.center().y() - 14, 28, 28), Qt::white);
    }
    const bool showName = hovered || stage || small;
    if (!stage) {
        const int liveWidth = drawBadge(p, font(), rect.right() - 8 + 1, rect.top() + 8, QStringLiteral("AO VIVO"), QColor("#d22d39"));
        // Observed: the quality pill appears before the badge while the tile is hovered.
        const QString quality = qualityText(image, stream.fps, false);
        if (hovered && !small && !quality.isEmpty()) drawBadge(p, font(), rect.right() - 8 + 1 - liveWidth - 6, rect.top() + 8, quality, QColor("#4f505a"));
    }
    if (showName) {
        QFont nameFont = font(); nameFont.setPixelSize(small ? 14 : 16); nameFont.setWeight(QFont::Medium);
        const QFontMetrics fm(nameFont);
        const int pillHeight = small ? 28 : 32, iconSize = small ? 16 : 16;
        const QString shown = fm.elidedText(stream.name, Qt::ElideRight, std::max(0, rect.width() - 24 - iconSize - 22));
        const int pillWidth = 8 + iconSize + 6 + fm.horizontalAdvance(shown) + 8;
        const QRect pill(rect.left() + 12, rect.bottom() - 12 - pillHeight + 1, pillWidth, pillHeight);
        p.setPen(Qt::NoPen); p.setBrush(QColor(0, 0, 0, 145)); p.drawRoundedRect(pill, 4, 4);
        DiscordIcons::paint(&p, DiscordIcons::IconType::ScreenShare, QRectF(pill.left() + 8, pill.top() + (pillHeight - iconSize) / 2.0, iconSize, iconSize), Qt::white);
        p.setFont(nameFont); p.setPen(Qt::white);
        p.drawText(QRect(pill.left() + 8 + iconSize + 6, pill.top(), fm.horizontalAdvance(shown) + 1, pillHeight), Qt::AlignLeft | Qt::AlignVCenter, shown);
    }
}

void ParticipantPane::paintEvent(QPaintEvent*) {
    QPainter p(this); p.setRenderHint(QPainter::Antialiasing);
    const Layout layout = computeLayout();
    for (Role role : {Role::Grid, Role::Stage, Role::Preview}) {
        for (int i = 0; i < tiles_.size(); ++i) {
            if (layout.tiles[i].role != role) continue;
            const bool hovered = hovered_ == i && !hoveredFilm_;
            if (tiles_[i].stream) drawStream(p, tiles_[i], layout.tiles[i], hovered);
            else drawUser(p, tiles_[i], layout.tiles[i], hovered, role == Role::Stage);
        }
    }
    for (const auto& entry : layout.film) {
        const Placed placed{entry.second, Role::Filmstrip};
        const bool hovered = hovered_ == entry.first && hoveredFilm_;
        if (tiles_[entry.first].stream) drawStream(p, tiles_[entry.first], placed, hovered);
        else drawUser(p, tiles_[entry.first], placed, hovered, false);
    }
    auto overlayButton = [&](const QRect& rect, int radius) {
        p.setPen(Qt::NoPen); p.setBrush(QColor(0, 0, 0, 145)); p.drawRoundedRect(rect, radius, radius);
    };
    if (!layout.zoom.isNull()) {
        overlayButton(layout.zoom, 4);
        DiscordIcons::paint(&p, DiscordIcons::IconType::MagnifyingGlassPlus, QRectF(layout.zoom.left() + 5, layout.zoom.top() + 5, 20, 20), Qt::white);
    }
    if (!layout.toggle.isNull()) {
        overlayButton(layout.toggle, 16);
        const QRectF chevron(layout.toggle.left() + 8, layout.toggle.top() + 6, 20, 20);
        DiscordIcons::paint(&p, layout.expanded ? DiscordIcons::IconType::ChevronSmallDown : DiscordIcons::IconType::ChevronSmallUp, chevron, Qt::white);
        DiscordIcons::paint(&p, DiscordIcons::IconType::Group, QRectF(layout.toggle.left() + 32, layout.toggle.top() + 6, 20, 20), Qt::white);
    }
}

}
