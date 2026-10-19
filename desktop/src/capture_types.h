#pragma once
#include <QImage>
#include <QMetaType>
#include <QString>
#include <QVector>
#include <QMutex>
#include <QMutexLocker>
#include <optional>

namespace triscord {
struct CaptureSource {
    enum class Kind { Window, Monitor };
    Kind kind = Kind::Window;
    quintptr handle = 0;
    quint32 processId = 0;
    QString name;
};
QVector<CaptureSource> captureSources();
QSize previewSize(QSize source);
struct CapturePreview { QImage image; QSize sourceSize; qint64 time100ns = 0; quint64 generation = 0; };
// One latest frame and one notification. A slow UI never queues video history.
class PreviewMailbox {
public:
    void select(quint64 generation) { QMutexLocker lock(&mutex_); generation_ = generation; latest_.reset(); }
    bool publish(CapturePreview preview) {
        QMutexLocker lock(&mutex_);
        if (preview.generation != generation_) return false;
        latest_ = std::move(preview);
        if (scheduled_) return false;
        scheduled_ = true; return true;
    }
    std::optional<CapturePreview> take() {
        QMutexLocker lock(&mutex_);
        scheduled_ = false; auto result = std::move(latest_); latest_.reset(); return result;
    }
private:
    QMutex mutex_;
    quint64 generation_ = 0;
    bool scheduled_ = false;
    std::optional<CapturePreview> latest_;
};
}
Q_DECLARE_METATYPE(triscord::CaptureSource)
Q_DECLARE_METATYPE(triscord::CapturePreview)
