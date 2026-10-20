#pragma once
#include <QObject>
#include <QString>
#include <QStringList>
#include <functional>

namespace triscord {
class HubApi;

// Error reports (20/10): sends a log to the hub's POST /logs (cloudflare/src/error_reports.js) so a bug no longer
// depends on asking someone for triscord.log. An automatic report goes out only when the log shows a signal
// (error_report_log.h) that was not reported for that log yet, so each problem is sent once: the running log every
// 30 minutes and the previous run's log at start (CoreSession decides when, never during a call). The user can also
// send the running log by hand. One compressed request in the background; the log never holds the bearer token.
class ErrorReporter final : public QObject {
    Q_OBJECT
public:
    // status: the HTTP answer, 0 when nothing could be sent (no log, offline); found: the signals that triggered the report.
    using Done = std::function<void(int status, const QStringList& found)>;
    ErrorReporter(HubApi* hub, QString version, QObject* parent = nullptr);

    // The folder holding triscord.log and triscord.previous.log; empty disables the reports.
    void setLogDirectory(const QString& directory) { directory_ = directory; }
    bool hasLog() const { return !directory_.isEmpty(); }
    // The previous run's log, when it shows a new signal. Only the first call of a run does anything.
    void sendPrevious(Done done = {});
    // The running session's log: automatic (only with a new signal) or by hand ("Enviar log agora", always).
    void sendCurrent(bool automatic, Done done = {});

private:
    void send(const QString& file, bool automatic, bool running, Done done);
    HubApi* hub_;
    QString version_, directory_;
    bool previousHandled_ = false;
};
}
