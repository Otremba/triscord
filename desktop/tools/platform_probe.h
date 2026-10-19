#pragma once
#include <QJsonObject>
#include <QString>

namespace triscord {
QJsonObject processMetrics();
QJsonObject probeGraphics();
QJsonObject probeMicrophone();
QJsonObject probeDesktopFrame();
}
