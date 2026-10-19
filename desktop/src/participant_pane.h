#pragma once
#include <QWidget>
#include <QJsonArray>
#include <QSet>
#include <QImage>
#include <QHash>
#include <QElapsedTimer>
#include <QVector>
#include <QPair>
#include <QColor>

namespace triscord {

// A shared screen shown as a tile next to the participants (desktop/out/claude-observations/SHARE.md).
struct StreamTile {
    QString id;      // service stream id ("$local" for the user's own share)
    QString name;    // owner shown in the name pill
    int fps = 0;     // known only for the user's own share; 0 = unknown
};

// Static painted cards: no per-participant widgets, capture sessions or timers. Participants and shared
// screens are tiles of one grid; clicking a tile opens the focused view (large stage + filmstrip).
class ParticipantPane final : public QWidget {
    Q_OBJECT
public:
    explicit ParticipantPane(QWidget* parent = nullptr);
    void setParticipants(const QJsonArray& users);
    void setLocalId(const QString& socketId) { localId_ = socketId; update(); }
    void setStreams(const QVector<StreamTile>& streams);
    void setStreamFrame(const QString& streamId, const QImage& image);
    void removeStreamFrame(const QString& streamId);
    void setSpeaking(const QString& peer, bool speaking);
    void setFrame(const QString& peer, const QImage& image);
    void removeFrame(const QString& peer);
    // Focus keys: a participant's socket id, or "stream:<id>" for a shared screen.
    QString focusedPeer() const { return focused_; }
    static QString streamKey(const QString& streamId) { return QStringLiteral("stream:") + streamId; }
    static bool isStreamKey(const QString& key) { return key.startsWith(QLatin1String("stream:")); }
    // Details of the focused tile for the channel header ("Tela de camargo", "720p 30FPS"); empty when none.
    struct FocusInfo { bool stream = false; QString title; QString quality; QString owner; QColor color; };
    FocusInfo focusInfo() const;
    void clearFocusPeer();
    // Layout queries used by tests and by the header: the tile of a key, and the filmstrip toggle (null when absent).
    QRect tileRect(const QString& key) const;
    QRect filmstripToggleRect() const { return computeLayout().toggle; }
signals:
    void cardsHeightChanged(int height);
    void participantContextMenuRequested(const QString& socketId, const QString& username, const QPoint& globalPos);
    void focusChanged(const QString& key);
    void fullscreenRequested(const QString& key, const QString& name, const QImage& image);
protected:
    void paintEvent(QPaintEvent*) override;
    void resizeEvent(QResizeEvent*) override;
    void mousePressEvent(QMouseEvent*) override;
    void mouseDoubleClickEvent(QMouseEvent*) override;
    void keyPressEvent(QKeyEvent*) override;
    void mouseMoveEvent(QMouseEvent*) override;
    void leaveEvent(QEvent*) override;
    bool eventFilter(QObject*, QEvent*) override;
private:
    struct Tile { QString key; bool stream = false; int index = 0; };
    enum class Role { Grid, Stage, Filmstrip, Preview, Hidden };
    struct Placed { QRect rect; Role role = Role::Hidden; };
    struct Layout { QVector<Placed> tiles; QVector<QPair<int, QRect>> film; QRect toggle, zoom; bool expanded = true; };
    void rebuildTiles();
    Layout computeLayout() const;
    QSize contentSize(const Tile& tile) const;
    QImage frameFor(const Tile& tile) const;
    QString nameFor(const Tile& tile) const;
    // Index of the tile under the point; `film` tells whether it is the filmstrip copy of that tile.
    int tileIndexAt(const QPoint& position, const Layout& layout, bool* film = nullptr) const;
    void drawUser(QPainter& p, const Tile& tile, const Placed& placed, bool hovered, bool stage) const;
    void drawStream(QPainter& p, const Tile& tile, const Placed& placed, bool hovered) const;
    void updateHeight();
    QRect cardRect(int index) const;
    QJsonArray users_;
    QVector<StreamTile> streams_;
    QVector<Tile> tiles_;
    QSet<QString> speaking_;
    QHash<QString, QImage> frames_;       // keyed by tile key
    QHash<QString, QElapsedTimer> rendered_;
    QString focused_;
    QString clicked_;
    QString localId_;
    int hovered_ = -1;
    bool hoveredFilm_ = false;
    bool filmstripExpanded_ = true;
    QWidget* viewport_ = nullptr;
};
}
