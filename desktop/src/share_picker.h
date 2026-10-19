#pragma once
#include "capture_types.h"
#include "video_codec.h"
#include <QDialog>
#include <QPixmap>
#include <QPointer>

class QButtonGroup;
class QLabel;
class QListWidget;
class QPushButton;
class QStackedWidget;

namespace triscord {

// Screen share picker observed in Discord (desktop/out/claude-observations/SHARE.md): a 960x746 modal over
// the darkened window with segmented "Aplicativos" / "Tela Inteira" tabs, a two-column grid of 439x247
// thumbnails whose hover shows "Compartilhar tela", and the stream mode block (title, subtitle, SD/HD and
// the "Modo de transmissão" menu). Choosing a source starts the stream; there is no separate confirm.
class SharePicker final : public QDialog {
    Q_OBJECT
public:
    enum class Mode { Game, Screen };
    explicit SharePicker(QWidget* parent = nullptr);
    // Window icon (or the monitor glyph) used by the picker legend and by the voice panel stream section.
    static QPixmap sourceIcon(const CaptureSource& source);
    void present(QWidget* window);
    void setSources(const QVector<CaptureSource>& sources);
    void setThumbnail(int sourceIndex, const QImage& image);
    void setCanStart(bool canStart);
    VideoConfig config() const;
    Mode mode() const { return mode_; }
    bool hd() const { return hd_; }
    bool streamAudioMuted() const { return audioMuted_; }
    QString subtitle() const;

signals:
    void startRequested(int sourceIndex, bool shareAudio, const triscord::VideoConfig& config);

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;
    void resizeEvent(QResizeEvent* event) override;

private:
    void setMode(Mode mode);
    void setHd(bool hd);
    void refreshQuality();
    void showModeMenu();
    void start(int sourceIndex);

    QWidget* panel_ = nullptr;
    QListWidget* windows_ = nullptr;
    QListWidget* monitors_ = nullptr;
    QStackedWidget* pages_ = nullptr;
    QLabel* modeTitle_ = nullptr;
    QLabel* modeSubtitle_ = nullptr;
    QPushButton* sd_ = nullptr;
    QPushButton* hdButton_ = nullptr;
    QPushButton* gear_ = nullptr;
    QPointer<QWidget> covered_;
    Mode mode_ = Mode::Game;
    bool hd_ = false;
    bool audioMuted_ = true;
    bool canStart_ = false;
};

} // namespace triscord
