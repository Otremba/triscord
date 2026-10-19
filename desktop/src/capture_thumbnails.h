#pragma once
#include "capture_native.h"
#include <QObject>
#include <QTimer>
#include <QElapsedTimer>
namespace triscord {
class CaptureThumbnails final : public QObject {
    Q_OBJECT
public:
    explicit CaptureThumbnails(QObject* parent = nullptr);
    void request(QVector<CaptureSource> sources, quint64 generation);
    void cancel();
signals:
    void ready(quint64 generation, int index, const QImage& image);
private:
    void tick();
    QVector<CaptureSource> sources_;
    std::unique_ptr<NativeCapture> capture_;
    QTimer timer_;
    QElapsedTimer age_;
    quint64 generation_ = 0;
    int index_ = 0;
};
}
