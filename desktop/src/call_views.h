#pragma once

#include <QImage>
#include <QWidget>

class QLabel;
class QPushButton;

namespace triscord {

// Voice channel view before joining, observed in Discord (desktop/out/claude-observations/CALLS.md):
// centred ~30px bold channel name, 14px "Ninguém está em voz" 31px lower, and a white 40px
// "Entrar na chamada de voz" button (radius 8, hover #e0e0e3) 29px below the subtitle baseline.
// The blue gradient behind it was sampled on the real view (top #0d0d11 to #343997 at the bottom edge, with a
// brighter #6a77e0 glow at the bottom centre).
// Surface behind the centre column of the main window. Chat: #000000. Call: black (observed stage).
// Pre-join: the blue gradient sampled on the real view (top #0d0d11 to #343997 at the bottom edge, with a
// brighter #6a77e0 glow at the bottom centre), which also lies under the transparent header.
class CenterSurface : public QWidget {
public:
    enum class Mode { Chat, Prejoin, Call };
    explicit CenterSurface(QWidget* parent = nullptr) : QWidget(parent) {}
    void setMode(Mode mode) { if (mode != mode_) { mode_ = mode; update(); } }
    Mode mode() const { return mode_; }
protected:
    void paintEvent(QPaintEvent* event) override;
private:
    static QImage renderGradient(const QSize& size);
    Mode mode_ = Mode::Chat;
    QImage gradient_;
};

class VoicePrejoinView : public QWidget {
    Q_OBJECT
public:
    explicit VoicePrejoinView(QWidget* parent = nullptr);
    // occupants < 0: unknown. The occupied variant was not observed, so its subtitle is left empty.
    void setChannel(const QString& name, int occupants);
    QPushButton* joinButton() const { return join_; }

signals:
    void joinRequested();

private:
    QLabel* title_;
    QLabel* subtitle_;
    QPushButton* join_;
};

} // namespace triscord
