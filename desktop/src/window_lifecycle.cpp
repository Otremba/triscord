#include "window_lifecycle.h"

#include <QByteArray>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QLocalServer>
#include <QLocalSocket>
#include <QThread>

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace triscord {
namespace {
constexpr const char* kRunKey = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const QByteArray kShowMessage = QByteArrayLiteral("show");
} // namespace

bool launchedAtLogin(const QStringList& arguments) {
    return arguments.contains(QString::fromLatin1(kStartupArgument));
}

WindowPrefs WindowPrefs::load(const QSettings& settings) {
    WindowPrefs prefs;
    prefs.closeToTray = settings.value("closeToTray", true).toBool();
    prefs.startMinimized = settings.value("startMinimized", false).toBool();
    return prefs;
}

void WindowPrefs::save(QSettings& settings, const WindowPrefs& prefs) {
    settings.setValue("closeToTray", prefs.closeToTray);
    settings.setValue("startMinimized", prefs.startMinimized);
}

LoginItem::LoginItem(QSettings* store, QString valueName) : store_(store), name_(std::move(valueName)) {}

std::unique_ptr<QSettings> LoginItem::registryStore() {
    return std::make_unique<QSettings>(QString::fromLatin1(kRunKey), QSettings::NativeFormat);
}

QString LoginItem::command(const QString& executable) {
    // Quoted: Program Files and user names contain spaces.
    return QStringLiteral("\"%1\" %2").arg(QDir::toNativeSeparators(executable), QString::fromLatin1(kStartupArgument));
}

bool LoginItem::enabled(const QString& executable) const {
    return store_->value(name_).toString() == command(executable);
}

bool LoginItem::setEnabled(bool on, const QString& executable) {
    if (on) store_->setValue(name_, command(executable));
    else store_->remove(name_);
    store_->sync();
    return store_->status() == QSettings::NoError && enabled(executable) == on;
}

QString SingleInstance::keyFor(const QString& settingsPath) {
    const auto hash = QCryptographicHash::hash(settingsPath.toUtf8(), QCryptographicHash::Sha256).toHex().left(8);
    return QStringLiteral("TriscordWeb-%1").arg(QString::fromLatin1(hash));
}

SingleInstance::SingleInstance(const QString& key, QObject* parent) : QObject(parent), key_(key) {
    // Local\ : one per Windows session, so another signed-in user (fast user switching) is not blocked.
    const auto name = (QStringLiteral("Local\\") + key).toStdWString();
    mutex_ = CreateMutexW(nullptr, FALSE, name.c_str());
    const bool exists = GetLastError() == ERROR_ALREADY_EXISTS;
    // Without a mutex at all (rare) behave as the only instance rather than refuse to start.
    primary_ = mutex_ == nullptr || !exists;
}

SingleInstance::~SingleInstance() {
    if (mutex_) CloseHandle(static_cast<HANDLE>(mutex_));
}

bool SingleInstance::startListening() {
    if (!primary_ || server_) return false;
    server_ = new QLocalServer(this);
    server_->setSocketOptions(QLocalServer::UserAccessOption);
    QLocalServer::removeServer(key_);
    connect(server_, &QLocalServer::newConnection, this, [this] {
        while (auto* socket = server_->nextPendingConnection()) {
            connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
            // Only the exact word counts, and only a short one: nothing else is read from the other process.
            connect(socket, &QLocalSocket::readyRead, this, [this, socket] {
                const auto message = socket->read(16);
                if (message.startsWith(kShowMessage)) emit showRequested();
                socket->disconnectFromServer();
            });
        }
    });
    return server_->listen(key_);
}

bool SingleInstance::notifyPrimary(int timeoutMs) {
    if (primary_) return false;
    QElapsedTimer waited;
    waited.start();
    do {
        QLocalSocket socket;
        socket.connectToServer(key_);
        if (socket.waitForConnected(300)) {
            socket.write(kShowMessage);
            const bool sent = socket.waitForBytesWritten(1000);
            socket.disconnectFromServer();
            if (sent) return true;
        }
        QThread::msleep(100);
    } while (waited.elapsed() < timeoutMs);
    return false;
}

} // namespace triscord
