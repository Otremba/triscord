#pragma once
#include <QByteArray>
#include <QString>
namespace triscord { QByteArray protectSetting(const QString& value); QString unprotectSetting(const QByteArray& value); }
