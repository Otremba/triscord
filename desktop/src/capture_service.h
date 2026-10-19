#pragma once
#include "capture_native.h"
#include <QObject>
#include <QThread>
#include <QTimer>

namespace triscord {
class CaptureWorker final : public QObject {
    Q_OBJECT
public:
    explicit CaptureWorker(QObject* parent = nullptr);
    void start(const CaptureSource& source, quint64 generation);
    void stop(quint64 generation);
signals:
    void frame(const CapturePreview& preview);
    void activeChanged(bool active, quint64 generation);
    void pausedChanged(bool paused, quint64 generation);
    void message(const QString& message, quint64 generation);
private:
    void tick();
    QTimer timer_;
    CaptureSource source_;
    std::unique_ptr<NativeCapture> capture_;
    quint64 generation_ = 0;
    bool paused_ = false;
};
class CaptureService final : public QObject {
    Q_OBJECT
public:
    explicit CaptureService(QObject* parent = nullptr);
    ~CaptureService() override;
    void start(const CaptureSource& source);
    void stop();
signals:
    void previewReady(const CapturePreview& preview);
    void activeChanged(bool active);
    void pausedChanged(bool paused);
    void message(const QString& message);
private:
    QThread thread_;
    CaptureWorker* worker_;
    std::shared_ptr<PreviewMailbox> mailbox_;
    quint64 generation_ = 0;
};
}
