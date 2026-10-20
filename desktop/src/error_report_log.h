#pragma once
#include <QRegularExpression>
#include <QString>
#include <QStringList>
#include <QVersionNumber>

namespace triscord {
// What makes a session's log worth an error report (20/10): the app sends the previous run's log only when one of
// these shows up, so a session without trouble never leaves the computer. Each threshold sits above what a healthy
// call writes; the names are the signals the admin page groups by (cloudflare/src/error_reports.js).
inline constexpr char kLogClosedLine[] = "Triscord closed";
// The first version whose log ends with kLogClosedLine; an older log never does, so its end proves nothing.
inline constexpr char kFirstVersionWithClosedLine[] = "0.9.39";

inline QStringList logSignals(const QString& log) {
    QStringList found;
    auto add = [&](const char* name, bool hit) { if (hit) found << QString::fromLatin1(name); };
    auto sum = [&](const QRegularExpression& pattern) {
        qint64 total = 0;
        for (auto it = pattern.globalMatch(log); it.hasNext();) total += it.next().captured(1).toLongLong();
        return total;
    };
    const QRegularExpression header(QStringLiteral("^(?:\\S+ )?Triscord (\\d+\\.\\d+\\.\\d+),"));
    const auto version = header.match(log.left(200)).captured(1);
    const bool closedLineKnown = !version.isEmpty()
        && QVersionNumber::fromString(version) >= QVersionNumber::fromString(QString::fromLatin1(kFirstVersionWithClosedLine));
    add("unclean-exit", closedLineKnown && !log.trimmed().endsWith(QString::fromLatin1(kLogClosedLine)));
    add("crash", log.contains(QRegularExpression(QStringLiteral("(?:^|\\n)(?:\\S+ )?crash: "))));
    add("screen-start", log.contains(QStringLiteral("screen: start failed")));
    add("decoder", log.contains(QStringLiteral("keyframe: decoder:")));
    add("capture", log.contains(QRegularExpression(QStringLiteral("capture: [^\\n]*failed"))));
    // "video: asked the sender for a keyframe: frame backlog x12, incomplete frame x3", one line per 10 s at most.
    qint64 keyframes = 0;
    static const QRegularExpression times(QStringLiteral(" x(\\d+)(?=,|$)"));
    for (const auto& line : log.split(QLatin1Char('\n')))
        if (line.contains(QStringLiteral("asked the sender for a keyframe:")))
            for (auto it = times.globalMatch(line.trimmed()); it.hasNext();) keyframes += it.next().captured(1).toLongLong();
    add("keyframe-storm", keyframes >= 60);
    add("packet-loss", sum(QRegularExpression(QStringLiteral("(\\d+) unrecoverable"))) >= 50);
    add("signaling", log.count(QRegularExpression(QStringLiteral("(?:^|\\n)(?:\\S+ )?signaling: "))) >= 3);
    add("voice-reconnect", log.count(QStringLiteral("voice: connection restored")) >= 3);
    add("qt-error", log.contains(QRegularExpression(QStringLiteral("(?:^|\\n)(?:\\S+ )?error: "))));
    return found;
}

// What leaves the computer: the log's last `limit` characters (from a line start) after the header line, with
// anything shaped like a token or an e-mail address replaced. The log never holds message text or passwords.
inline QString reportText(const QString& log, qsizetype limit = 512 * 1024) {
    QString text = log;
    if (text.size() > limit) {
        const auto header = text.left(text.indexOf('\n') + 1);
        auto tail = text.right(limit - header.size() - 4);   // 4: the marker below
        tail = tail.mid(tail.indexOf('\n') + 1);
        text = header + QStringLiteral("[…]\n") + tail;
    }
    static const QRegularExpression hex(QStringLiteral("[0-9a-fA-F]{32,}"));
    static const QRegularExpression email(QStringLiteral("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"));
    return text.replace(hex, QStringLiteral("<hex>")).replace(email, QStringLiteral("<email>"));
}
}
