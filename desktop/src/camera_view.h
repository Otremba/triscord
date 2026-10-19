#pragma once
#include <QDialog>
#include <QImage>
namespace triscord {
class VideoStageLabel;
class CameraView final : public QDialog {
    Q_OBJECT
public:
    explicit CameraView(QWidget* parent = nullptr);
    void openPeer(const QString& id, const QString& name, const QImage& image);
    void setFrame(const QString& id, const QImage& image);
    void removePeer(const QString& id);
    QString peer() const { return peer_; }
signals:
    void focusChanged(const QString& id);
    void returnToGridRequested();
private:
    VideoStageLabel* stage_;
    QString peer_;
};
}
