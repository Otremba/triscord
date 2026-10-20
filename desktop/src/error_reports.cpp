#include "error_reports.h"
#include "error_report_log.h"
#include "hub_api.h"
#include <QDir>
#include <QFile>
#include <QSettings>
#include <algorithm>
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
    send(QDir(directory_).filePath("triscord.previous.log"), true, false, std::move(done));
}

void ErrorReporter::sendCurrent(bool automatic, Done done) {
    if (directory_.isEmpty()) { if (done) done(0, {}); return; }
    send(QDir(directory_).filePath("triscord.log"), automatic, true, std::move(done));
}

void ErrorReporter::send(const QString& path, bool automatic, bool running, Done done) {
    const auto log = readLog(path);
    auto found = log.isEmpty() ? QStringList{} : logSignals(log);
    if (running) found.removeAll(QStringLiteral("unclean-exit"));   // the running log has no closing line yet
    // What was already reported for this log (its first line, with the start time, names it): the running log is the
    // next start's previous log, so a problem reported during the session is not sent again then.
    const auto header = log.left(log.indexOf('\n'));
    QSettings settings;
    const auto reported = settings.value("errorReports/log").toString() == header ? settings.value("errorReports/signals").toStringList() : QStringList{};
    const bool fresh = std::any_of(found.begin(), found.end(), [&](const QString& signal) { return !reported.contains(signal); });
    if (log.isEmpty() || (automatic && !fresh) || !hub_->canCall()) { if (done) done(0, found); return; }
    if (found.isEmpty()) found << QStringLiteral("none");
    // zlib stream (qCompress's 4-byte length prefix dropped): the Worker inflates it with DecompressionStream('deflate').
    const auto body = qCompress(reportText(log).toUtf8(), 9).mid(4);
    const QList<QPair<QByteArray, QByteArray>> headers{
        {"X-Triscord-Version", version_.toLatin1()}, {"X-Triscord-Signals", found.join(',').toLatin1()},
        {"X-Triscord-Reason", automatic ? "auto" : "manual"}};
    hub_->upload("/logs", body, headers, [done, found, automatic, header, reported](int status) {
        if (automatic && status == 201) {
            QSettings settings;
            auto all = reported;
            for (const auto& signal : found) if (!all.contains(signal)) all << signal;
            settings.setValue("errorReports/log", header);
            settings.setValue("errorReports/signals", all);
        }
        std::printf("reports: %s report %s (%s)\n", automatic ? "automatic" : "manual",
                    status == 201 ? "sent" : qPrintable(QStringLiteral("not sent, HTTP %1").arg(status)), qPrintable(found.join(", ")));
        std::fflush(stdout);
        if (done) done(status, found);
    });
}
}
