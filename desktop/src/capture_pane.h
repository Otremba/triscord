#pragma once
#include "capture_service.h"
#include <QWidget>

class QComboBox;
class QPushButton;
namespace triscord {
class CapturePane final : public QWidget {
    Q_OBJECT
public:
    explicit CapturePane(CaptureService* service, QWidget* parent = nullptr);
private:
    void refreshSources();
    CaptureService* service_;
    QVector<CaptureSource> sources_;
    QComboBox* source_;
    QPushButton* start_;
};
}
