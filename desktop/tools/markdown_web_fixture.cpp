// Private headless fixture: real native parser/serializer, never opens URLs.
#include "markdown_web.h"
#include <QCoreApplication>
#include <QFile>
#include <QJsonDocument>
#include <cstdio>

int main(int argc, char** argv) {
    QCoreApplication app(argc, argv);
    if (argc != 2) return 2;
    QFile input(QString::fromLocal8Bit(argv[1]));
    if (!input.open(QIODevice::ReadOnly)) return 3;
    const auto texts = QJsonDocument::fromJson(input.readAll()).array();
    QJsonArray items;
    for (const auto& value : texts) items.append(triscord::discordMarkdownForWeb(value.toString()));
    const auto text = QStringLiteral("[safe](https://example.com/a) ||[secret](https://example.com/secret)|| [bad](javascript:alert(1)) <file:/tmp/a>");
    const auto nodes = triscord::parseDiscordMarkdown(text);
    const QList<QPair<QString, bool>> checks{{"https://example.com/a", true}, {"https://example.com/secret", true},
        {"https://example.com/other", false}, {"javascript:alert(1)", false}, {"file:/tmp/a", false},
        {"https://user:pass@example.com/a", false}, {"https://example.com/a\n", false}};
    for (const auto& check : checks) if (triscord::markdownHasWebLink(nodes, check.first) != check.second) return 4;
    QJsonArray relative;
    const auto now = QDateTime::fromString("2026-10-18T15:00:00Z", Qt::ISODate);
    for (const qint64 delta : {0LL, 44LL, 59LL, 60LL, 90LL, 3599LL, 3600LL, 79200LL, 86400LL, 2246400LL, 31536000LL, -60LL}) {
        triscord::MarkdownNode timestamp; timestamp.type = triscord::MarkdownNodeType::Timestamp;
        timestamp.id = QString::number(now.toSecsSinceEpoch() - delta); timestamp.lang = "R";
        relative.append(QJsonObject{{"seconds", timestamp.id}, {"now", now.toMSecsSinceEpoch()}, {"label", triscord::formatDiscordTimestamp(timestamp, now)}});
    }
    const QJsonObject result{{"items", items}, {"nativeLinkChecks", checks.size()}, {"relative", relative}};
    const auto encoded = QJsonDocument(result).toJson(QJsonDocument::Compact);
    return std::fwrite(encoded.data(), 1, encoded.size(), stdout) == size_t(encoded.size()) ? 0 : 5;
}
