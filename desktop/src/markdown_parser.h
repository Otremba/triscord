#pragma once

#include <QString>
#include <QStringList>
#include <QFont>
#include <QTextLayout>
#include <QTextCharFormat>
#include <vector>
#include <memory>
#include <QSet>
#include <QDateTime>

namespace triscord {

enum class MarkdownNodeType {
    Text,
    Paragraph,
    Heading,
    Subtext,
    CodeBlock,
    InlineCode,
    BlockQuote,
    List,
    Link,
    Autolink,
    Mailto,
    Tel,
    Url,
    Strong,
    Em,
    Underline,
    Strikethrough,
    Spoiler,
    Mention,
    RoleMention,
    SilentPrefix,
    Timestamp,
    CustomEmoji,
    Emoticon,
    LineBreak,
    Newline
};

struct MarkdownNode {
    MarkdownNodeType type{MarkdownNodeType::Text};
    QString content;
    QString target;
    QString title;
    QString lang;
    int level{0};
    bool ordered{false};
    qint64 startNumber{1};
    QString id;
    bool animated{false};
    std::vector<MarkdownNode> children;
    std::vector<std::vector<MarkdownNode>> listItems;
};

struct MarkdownParseOptions {
    bool inlineOnly{false};
    bool disableAutoBlockNewlines{false};
    bool allowHeading{true};
    bool allowSubtext{true};
    bool allowLinks{true};
    bool allowEscape{true};
    bool inQuote{false};
    int parseDepth{0};
    int listLevel{0};
};

struct FormattedMarkdown {
    struct SpoilerRange { int start; int length; int id; bool revealed; };
    QString plainText;
    QList<QTextLayout::FormatRange> formats;
    QList<SpoilerRange> spoilers;
};

std::vector<MarkdownNode> parseDiscordMarkdown(const QString& input, const MarkdownParseOptions& options = {});
QString markdownToPlainText(const std::vector<MarkdownNode>& nodes);
QString formatDiscordTimestamp(const MarkdownNode& node, const QDateTime& now = QDateTime::currentDateTime());
FormattedMarkdown buildFormattedMarkdown(const std::vector<MarkdownNode>& nodes, const QFont& baseFont, const QSet<int>& revealed = {});

} // namespace triscord
