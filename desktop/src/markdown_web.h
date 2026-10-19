#pragma once

#include "markdown_parser.h"
#include <QJsonArray>
#include <QJsonObject>
#include <QUrl>

namespace triscord {
// A typed tree, never HTML. The WebView renderer owns the finite element/attribute vocabulary.
inline QJsonArray markdownNodesForWeb(const std::vector<MarkdownNode>& nodes, int depth = 0) {
    QJsonArray result;
    if (depth > 64) return {QJsonObject{{"type", "text"}, {"text", markdownToPlainText(nodes)}}};
    for (const auto& node : nodes) {
        const char* type = "text";
        switch (node.type) {
        case MarkdownNodeType::Paragraph: type = "paragraph"; break;
        case MarkdownNodeType::Heading: type = "heading"; break;
        case MarkdownNodeType::Subtext: type = "subtext"; break;
        case MarkdownNodeType::CodeBlock: type = "codeBlock"; break;
        case MarkdownNodeType::InlineCode: type = "inlineCode"; break;
        case MarkdownNodeType::BlockQuote: type = "quote"; break;
        case MarkdownNodeType::List: type = "list"; break;
        case MarkdownNodeType::Link: case MarkdownNodeType::Autolink: case MarkdownNodeType::Mailto:
        case MarkdownNodeType::Tel: case MarkdownNodeType::Url: type = "link"; break;
        case MarkdownNodeType::Strong: type = "strong"; break;
        case MarkdownNodeType::Em: type = "em"; break;
        case MarkdownNodeType::Underline: type = "underline"; break;
        case MarkdownNodeType::Strikethrough: type = "strike"; break;
        case MarkdownNodeType::Spoiler: type = "spoiler"; break;
        case MarkdownNodeType::Mention: case MarkdownNodeType::RoleMention: type = "mention"; break;
        case MarkdownNodeType::Timestamp: type = "timestamp"; break;
        case MarkdownNodeType::LineBreak: case MarkdownNodeType::Newline: type = "break"; break;
        default: break;
        }
        QJsonObject object{{"type", type}};
        if (!node.content.isEmpty()) object.insert("text", node.content);
        if (!node.children.empty()) object.insert("children", markdownNodesForWeb(node.children, depth + 1));
        if (node.type == MarkdownNodeType::Heading) object.insert("level", node.level);
        if (node.type == MarkdownNodeType::Link) { object.insert("href", node.target); if (!node.title.isEmpty()) object.insert("title", node.title); }
        if (node.type == MarkdownNodeType::CodeBlock && !node.lang.isEmpty()) object.insert("language", node.lang);
        if (node.type == MarkdownNodeType::List) {
            object.insert("ordered", node.ordered); object.insert("start", node.startNumber);
            QJsonArray items; for (const auto& item : node.listItems) items.append(markdownNodesForWeb(item, depth + 1));
            object.insert("items", items);
        }
        if (node.type == MarkdownNodeType::Timestamp) {
            object.insert("text", formatDiscordTimestamp(node)); object.insert("seconds", node.id); object.insert("format", node.lang);
        }
        result.append(object);
    }
    return result;
}
inline QJsonArray discordMarkdownForWeb(const QString& text) { return markdownNodesForWeb(parseDiscordMarkdown(text)); }
inline bool markdownHasWebLink(const std::vector<MarkdownNode>& nodes, const QString& target) {
    const QUrl url(target, QUrl::StrictMode);
    if (!url.isValid() || (url.scheme() != "https" && url.scheme() != "http") || url.host().isEmpty() || !url.userInfo().isEmpty()) return false;
    for (const auto character : target) if (character.unicode() <= 32 || character.unicode() == 127) return false;
    for (const auto& node : nodes) {
        if (node.type == MarkdownNodeType::Link && node.target == target) return true;
        if (markdownHasWebLink(node.children, target)) return true;
        for (const auto& item : node.listItems) if (markdownHasWebLink(item, target)) return true;
    }
    return false;
}
} // namespace triscord
