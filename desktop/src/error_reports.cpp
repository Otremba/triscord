#include "error_reports.h"
#include "error_report_log.h"
#include "hub_api.h"
#include <QDir>
#include <QFile>
#include <cstdio>

namespace triscord {
namespace {
// A day-long session writes far less; reading at most this much keeps a runaway log from costing time or memory.
constexpr qint64 kMaxRead = 4 * 1024 * 1024;

QString readLog(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) return {};
    const auto size = file.size();
    QByteArray head;
    if (size > kMaxRead) { head = file.readLine(512); file.seek(size - kMaxRead); }
    return QString::fromUtf8(head + file.read(kMaxRead));
}
}

ErrorReporter::ErrorReporter(HubApi* hub, QString version, QObject* parent) : QObject(parent), hub_(hub), version_(std::move(version)) {}

void ErrorReporter::sendPrevious(Done done) {
    if (previousHandled_) return;
    previousHandled_ = true;
    if (directory_.isEmpty()) { if (done) done(0, {}); return; }
    send(QDir(directory_).filePath("triscord.previous.log"), true, std::move(done));
}

void ErrorReporter::sendCurrent(Done done) {
    if (directory_.isEmpty()) { if (done) done(0, {}); return; }
    send(QDir(directory_).filePath("triscord.log"), false, std::move(done));
}

void ErrorReporter::send(const QString& path, bool automatic, Done done) {
    const auto log = readLog(path);
    auto found = log.isEmpty() ? QStringList{} : logSignals(log);
    if (log.isEmpty() || (automatic && found.isEmpty()) || !hub_->canCall()) { if (done) done(0, found); return; }
    if (found.isEmpty()) found << QStringLiteral("none");
    // zlib stream (qCompress's 4-byte length prefix dropped): the Worker inflates it with DecompressionStream('deflate').
    const auto body = qCompress(reportText(log).toUtf8(), 9).mid(4);
    const QList<QPair<QByteArray, QByteArray>> headers{
        {"X-Triscord-Version", version_.toLatin1()}, {"X-Triscord-Signals", found.join(',').toLatin1()},
        {"X-Triscord-Reason", automatic ? "auto" : "manual"}};
    hub_->upload("/logs", body, headers, [done, found, automatic](int status) {
        std::printf("reports: %s report %s (%s)\n", automatic ? "automatic" : "manual",
                    status == 201 ? "sent" : qPrintable(QStringLiteral("not sent, HTTP %1").arg(status)), qPrintable(found.join(", ")));
        std::fflush(stdout);
        if (done) done(status, found);
    });
}
}
