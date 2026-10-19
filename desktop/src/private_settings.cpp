#include "private_settings.h"
#include <windows.h>
#include <wincrypt.h>
namespace triscord {
QByteArray protectSetting(const QString& value) {
    if (value.isEmpty()) return {};
    auto utf8 = value.toUtf8(); DATA_BLOB input{DWORD(utf8.size()), reinterpret_cast<BYTE*>(utf8.data())}, output{};
    if (!CryptProtectData(&input, L"Triscord group invite", nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) return {};
    QByteArray encrypted(reinterpret_cast<const char*>(output.pbData), qsizetype(output.cbData)); LocalFree(output.pbData); return encrypted;
}
QString unprotectSetting(const QByteArray& value) {
    if (value.isEmpty()) return {};
    DATA_BLOB input{DWORD(value.size()), reinterpret_cast<BYTE*>(const_cast<char*>(value.constData()))}, output{};
    if (!CryptUnprotectData(&input, nullptr, nullptr, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &output)) return {};
    const auto text = QString::fromUtf8(reinterpret_cast<const char*>(output.pbData), qsizetype(output.cbData)); LocalFree(output.pbData); return text;
}
}
