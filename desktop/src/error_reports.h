#pragma once
#include <QObject>
#include <QString>
#include <QStringList>
#include <functional>

namespace triscord {
class HubApi;

// Error reports (20/10): sends the log to the hub's POST /logs (cloudflare/src/error_reports.js) so a bug no longer
// depends on asking someone for triscord.log. Every 30 minutes the part of the running log not sent yet goes out,
// whatever it holds, and at start what the previous run's last minutes left (CoreSession decides when, never during a
// call); each report carries the log's version and system lines and the signals it shows (error_report_log.h). The
// user can also send the whole running log by hand. One compressed request; the log never holds the bearer token.
class ErrorReporter final : public QObject {
    Q_OBJECT
public:
    // status: the HTTP answer, 0 when nothing could be sent (no log, offline); found: the signals that triggered the report.
    using Done = std::function<void(int status, const QStringList& found)>;
    ErrorReporter(HubApi* hub, QString version, QObject* parent = nullptr);

    // The folder holding triscord.log and triscord.previous.log; empty disables the reports.
    void setLogDirectory(const QString& directory) { directory_ = directory; }
    bool hasLog() const { return !directory_.isEmpty(); }
    // What the previous run's log has not sent yet. Only the first call of a run does anything.
    void sendPrevious(Done done = {});
    // The running session's log: automatic (only the part not sent yet) or by hand ("Enviar log agora", all of it).
    void sendCurrent(bool automatic, Done done = {});

private:
    void send(const QString& file, bool automatic, bool running, Done done);
    HubApi* hub_;
    QString version_, directory_;
    bool previousHandled_ = false;
};
}
