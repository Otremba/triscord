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
// The version and system lines (system_info.h): every report says which build and computer it comes from.
constexpr int kHeadLines = 12;
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
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly) || !hub_->canCall()) { if (done) done(0, {}); return; }
    const auto end = file.size();
    // A log is named by its first line (version and start time); errorReports/sent is how much of it already went
    // out. An automatic report carries only what came after, so every line leaves once: the running log every 30
    // minutes, and at the next start what its last minutes left (a crash shows there).
    const auto name = QString::fromUtf8(file.readLine(1024)).trimmed();
    QSettings settings;
    const qint64 sent = automatic && settings.value("errorReports/log").toString() == name ? settings.value("errorReports/sent").toLongLong() : 0;
    file.seek(0);
    QByteArray headBytes;   // never past what was sent: in a short log the head would swallow the new lines
    for (int n = 0; n < kHeadLines && !file.atEnd() && (sent == 0 || file.pos() < sent); ++n) headBytes += file.readLine(1024);
    const auto head = QString::fromUtf8(headBytes);
    if (end == 0 || name.isEmpty() || (automatic && sent >= end)) { if (done) done(0, {}); return; }
    const auto start = std::max({sent, end - kMaxRead, qint64(headBytes.size())});
    file.seek(start);
    const auto fresh = QString::fromUtf8(file.read(end - start));
    const auto log = start > headBytes.size() ? head + QStringLiteral("[…]\n") + fresh : head + fresh;
    auto found = logSignals(log);
    if (running) found.removeAll(QStringLiteral("unclean-exit"));   // the running log has no closing line yet
    if (found.isEmpty()) found << QStringLiteral("none");
    // zlib stream (qCompress's 4-byte length prefix dropped): the Worker inflates it with DecompressionStream('deflate').
    const auto body = qCompress(reportText(log).toUtf8(), 9).mid(4);
    const QList<QPair<QByteArray, QByteArray>> headers{
        {"X-Triscord-Version", version_.toLatin1()}, {"X-Triscord-Signals", found.join(',').toLatin1()},
        {"X-Triscord-Reason", automatic ? "periodic" : "manual"}};
    hub_->upload("/logs", body, headers, [done, found, automatic, name, end](int status) {
        if (automatic && status == 201) {
            QSettings settings;
            settings.setValue("errorReports/log", name);
            settings.setValue("errorReports/sent", end);
        }
        std::printf("reports: %s report %s (%s)\n", automatic ? "periodic" : "manual",
                    status == 201 ? "sent" : qPrintable(QStringLiteral("not sent, HTTP %1").arg(status)), qPrintable(found.join(", ")));
        std::fflush(stdout);
        if (done) done(status, found);
    });
}
}
