#pragma once
#include <QObject>
#include <QString>
#include <QStringList>
#include <functional>

namespace triscord {
class HubApi;

// Error reports (20/10): sends a log to the hub's POST /logs (cloudflare/src/error_reports.js) so a bug no longer
// depends on asking someone for triscord.log. Automatic reports carry the previous run's log, only when it shows a
// signal (error_report_log.h), at most once per run; the user can also send the current log by hand. One compressed
// request in the background, never during a call (CoreSession decides when), never the bearer token in the log.
class ErrorReporter final : public QObject {
    Q_OBJECT
public:
    // status: the HTTP answer, 0 when nothing could be sent (no log, offline); found: the signals that triggered the report.
    using Done = std::function<void(int status, const QStringList& found)>;
    ErrorReporter(HubApi* hub, QString version, QObject* parent = nullptr);

    // The folder holding triscord.log and triscord.previous.log; empty disables the reports.
    void setLogDirectory(const QString& directory) { directory_ = directory; }
    bool hasLog() const { return !directory_.isEmpty(); }
    // The previous run's log, when it shows a signal. Only the first call of a run does anything.
    void sendPrevious(Done done = {});
    // The running session's log ("Enviar log agora" in the settings).
    void sendCurrent(Done done);

private:
    void send(const QString& file, bool automatic, Done done);
    HubApi* hub_;
    QString version_, directory_;
    bool previousHandled_ = false;
};
}
