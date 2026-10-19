#pragma once
#include <QDialog>
#include <QJsonArray>
#include <QTimer>
#include <QMap>
#include <QWidget>
#include <QLabel>
#include <QPushButton>

class QMediaPlayer;
class QAudioOutput;
class QFrame;
class QGridLayout;
class QLineEdit;
class QScrollArea;

namespace triscord {

QByteArray soundboardAudio(const QByteArray& original);

// Sound tile observed in Discord's soundboard popover (desktop/out/claude-observations/SOUNDBOARD.md):
// 148x40, radius 8, 14px semibold name centred.
class SoundCardWidget final : public QWidget {
    Q_OBJECT
public:
    explicit SoundCardWidget(const QString& id, const QString& name, QWidget* parent = nullptr);

    QString id() const { return id_; }
    QString name() const { return name_; }
    void setPlaying(bool playing);
    bool isPlaying() const { return playing_; }

signals:
    void clicked(const QString& id);
    void previewClicked(const QString& id);

protected:
    void enterEvent(QEnterEvent* event) override;
    void leaveEvent(QEvent* event) override;
    void mousePressEvent(QMouseEvent* event) override;
    void paintEvent(QPaintEvent* event) override;

private:
    QString id_;
    QString name_;
    bool isHovered_ = false;
    bool playing_ = false;
    QPushButton* previewBtn_ = nullptr;
};

// Section header: 16px icon, 14px semibold title and a chevron that collapses the section.
class SoundboardSectionHeader final : public QWidget {
    Q_OBJECT
public:
    SoundboardSectionHeader(const QPixmap& icon, const QString& title, QWidget* parent = nullptr);
    bool isCollapsed() const { return collapsed_; }
    QSize sizeHint() const override { return {460, 40}; }

signals:
    void toggled(bool collapsed);

protected:
    void mousePressEvent(QMouseEvent* event) override;
    void paintEvent(QPaintEvent* event) override;

private:
    QPixmap icon_;
    QString title_;
    bool collapsed_ = false;
};

// Left category rail: one 32px item per section, white 4x20 pill on the selected one.
class SoundboardRailItem final : public QWidget {
    Q_OBJECT
public:
    SoundboardRailItem(const QPixmap& icon, const QString& title, QWidget* parent = nullptr);
    void setSelected(bool selected) { selected_ = selected; update(); }
    bool isSelected() const { return selected_; }

signals:
    void clicked();

protected:
    void mousePressEvent(QMouseEvent* event) override;
    void paintEvent(QPaintEvent* event) override;

private:
    QPixmap icon_;
    bool selected_ = false;
};

// Popover anchored above the button that opened it; closes on outside click or Esc.
class Soundboard final : public QDialog {
    Q_OBJECT
public:
    explicit Soundboard(QWidget* parent = nullptr);
    void popupFor(QWidget* anchor);
    void play(const QString& id);
    void stop();
    void setOutput(const QByteArray& id);
    void setDeafened(bool muted);
    void setVolume(int percent);
    int volume() const { return volume_; }

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

signals:
    void playRequested(const QString& id);
    void message(const QString& text);

private:
    void applyFilter();
    void layoutCards();
    void updatePlayingHighlight(const QString& id, bool isPlaying);

    QJsonArray catalog_;
    QMediaPlayer* player_ = nullptr;
    QAudioOutput* audio_ = nullptr;
    QTimer deadline_;
    QByteArray output_;
    bool deafened_ = false;
    int volume_ = 70;
    QString currentPlayingId_;

    QFrame* searchFrame_ = nullptr;
    QLineEdit* search_ = nullptr;
    QScrollArea* scroll_ = nullptr;
    QGridLayout* grid_ = nullptr;
    SoundboardSectionHeader* serverHeader_ = nullptr;
    QWidget* section_ = nullptr;
    QList<SoundCardWidget*> cards_;
    QMap<QString, SoundCardWidget*> cardWidgets_;
};

} // namespace triscord
