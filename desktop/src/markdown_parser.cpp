#include "markdown_parser.h"
#include <QRegularExpression>
#include <algorithm>
#include <functional>
#include <QLocale>
#include <cmath>
#include <unordered_map>

namespace triscord {
namespace {

struct RuleMatch {
    bool matched{false};
    int length{0};
    QStringList captures;
    double quality{0.0};
};

using MatchFn = std::function<RuleMatch(const QString& text, const MarkdownParseOptions& options, const QString& prevCapture)>;
using ParseFn = std::function<std::vector<MarkdownNode>(const QStringList& captures, const MarkdownParseOptions& options, const std::function<std::vector<MarkdownNode>(const QString&, const MarkdownParseOptions&)>& recurse)>;

struct Rule {
    QString name;
    int order{0};
    bool hasQuality{false};
    QList<QChar> requiredFirstCharacters;
    MatchFn match;
    ParseFn parse;
};

QString normalizeInput(QString input) {
    input.replace("\r\n", "\n");
    input.replace('\r', '\n');
    input.remove('\f');
    input.replace("\t", "    ");
    return input;
}

QString balanceUrlParentheses(QString url) {
    int searchPos = 0;
    for (int i = url.length() - 1; i >= 0 && url[i] == ')'; --i) {
        int openIdx = url.indexOf('(', searchPos);
        if (openIdx == -1) {
            url.chop(1);
            break;
        }
        searchPos = openIdx + 1;
    }
    return url;
}
std::vector<Rule> buildDiscordRules() {
    std::vector<Rule> rules;

    // 0. heading: order 0, required [' ', '#'], matches 1 to 3 hashes
    rules.push_back({
        "heading", 0, false, {' ', '#'},
        [](const QString& text, const MarkdownParseOptions& options, const QString& prevCapture) -> RuleMatch {
            if (!options.allowHeading) return {};
            const bool atNewline = prevCapture.isEmpty() || prevCapture.endsWith('\n');
            if (!atNewline) return {};
            static const QRegularExpression re(R"(^ *(#{1,3})(?:\s+)((?!\s*#{1,3}\s)[^\n]+?)#*\s*(?:\n|$))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Heading;
            node.level = cap.value(1).length();
            auto subOpts = options;
            subOpts.inlineOnly = true;
            node.children = recurse(cap.value(2).trimmed(), subOpts);
            return {node};
        }
    });

    // 0. subtext: order 0, required ['-'], matches -# text
    rules.push_back({
        "subtext", 0, false, {'-'},
        [](const QString& text, const MarkdownParseOptions& options, const QString& prevCapture) -> RuleMatch {
            if (!options.allowSubtext) return {};
            const bool atNewline = prevCapture.isEmpty() || prevCapture.endsWith('\n');
            if (!atNewline) return {};
            static const QRegularExpression re(R"(^ *-# +((?!-#)[^\n]+)(?:\n|$))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Subtext;
            auto subOpts = options;
            subOpts.inlineOnly = true;
            subOpts.allowSubtext = false;
            node.children = recurse(cap.value(1).trimmed(), subOpts);
            return {node};
        }
    });

    // 4. codeBlock: order 4, required ['`'], matches ```lang\ncode\n```
    rules.push_back({
        "codeBlock", 4, false, {'`'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^```(?:([a-z0-9_+\-.#]+?)\n)?\n*([^\n][\s\S]*?)\n*```)", QRegularExpression::CaseInsensitiveOption);
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::CodeBlock;
            node.lang = cap.value(1);
            node.content = cap.value(2);
            return {node};
        }
    });

    // 4. customEmoji: order 4, required ['<'], matches <a?:name:id>
    rules.push_back({
        "customEmoji", 4, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<(a)?:(\w+):(\d+)>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::CustomEmoji;
            node.animated = (cap.value(1) == "a");
            node.content = QString(":%1:").arg(cap.value(2));
            node.id = cap.value(3);
            return {node};
        }
    });

    // 6. blockQuote: order 6, required [' ', '>']
    rules.push_back({
        "blockQuote", 6, false, {' ', '>'},
        [](const QString& text, const MarkdownParseOptions& options, const QString& prevCapture) -> RuleMatch {
            if (options.inQuote) return {};
            if (!prevCapture.isEmpty() && !prevCapture.endsWith('\n')) return {};
            static const QRegularExpression re(R"(^(?:(?: *>>> +([\s\S]*))|(?: *>(?!>>) +[^\n]*(?:\n *>(?!>>) +[^\n]*)*\n?)))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::BlockQuote;
            const QString full = cap.value(0);
            static const QRegularExpression multilineRe(R"(^ *>>> ?)");
            static const QRegularExpression singlelineRe(R"(^ *> ?)", QRegularExpression::MultilineOption);
            const bool isMulti = multilineRe.match(full).hasMatch();
            QString stripped = full;
            if (isMulti) {
                stripped.remove(multilineRe);
            } else {
                stripped.replace(singlelineRe, "");
            }
            auto subOpts = options;
            subOpts.inQuote = true;
            if (!isMulti) subOpts.inlineOnly = true;
            node.children = recurse(stripped, subOpts);
            if (node.children.empty()) {
                MarkdownNode spaceNode;
                spaceNode.type = MarkdownNodeType::Text;
                spaceNode.content = " ";
                node.children.push_back(spaceNode);
            }
            return {node};
        }
    });

    // 7. list: order 7
    rules.push_back({
        "list", 7, false, {'\n', ' ', '*', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'},
        [](const QString& text, const MarkdownParseOptions& options, const QString& prevCapture) -> RuleMatch {
            if (options.listLevel >= 11) return {};
            if (text.startsWith('\n')) {
                if (prevCapture.isEmpty() || prevCapture.endsWith("\n *")) return {};
                static const QRegularExpression fnRe(R"(^\n^( *)(?:[*-]|\d+\.) [\s\S]+?(?:\n(?! )(?:[*-]|\d+\.) |$))", QRegularExpression::MultilineOption);
                auto match = fnRe.match(text);
                if (match.hasMatch() && match.capturedStart() == 0) {
                    return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
                }
            } else {
                if (!prevCapture.isEmpty() && !prevCapture.endsWith('\n')) return {};
                static const QRegularExpression hnRe(R"(^( *)([*-]|\d+\.) [\s\S]+?(?:\n(?! )(?!\1(?:[*-]|\d+\.) )|$))");
                auto match = hnRe.match(text);
                if (match.hasMatch() && match.capturedStart() == 0) {
                    return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
                }
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::List;
            QString body = cap.value(0);
            if (body.startsWith('\n')) body.remove(0, 1);
            static const QRegularExpression leadRe(R"(^ *(?:([*-])|(\d+)\.) )");
            auto leadMatch = leadRe.match(body);
            if (leadMatch.hasMatch()) {
                if (!leadMatch.captured(2).isEmpty()) {
                    node.ordered = true;
                    node.startNumber = leadMatch.captured(2).toLongLong();
                } else {
                    node.ordered = false;
                }
            }
            const auto lines = body.split('\n', Qt::SkipEmptyParts);
            auto itemOpts = options;
            itemOpts.allowHeading = false;
            itemOpts.listLevel = options.listLevel + 1;
            itemOpts.inlineOnly = true;
            for (const auto& line : lines) {
                QString itemText = line;
                itemText.remove(leadRe);
                node.listItems.push_back(recurse(itemText.trimmed(), itemOpts));
            }
            return {node};
        }
    });
    // 10. newline: order 10, required ['\n']
    rules.push_back({
        "newline", 10, false, {'\n'},
        [](const QString& text, const MarkdownParseOptions& options, const QString&) -> RuleMatch {
            if (options.inlineOnly) return {};
            static const QRegularExpression re(R"(^(?:\n *)*\n)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList&, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Newline;
            return {node};
        }
    });

    // 11. paragraph: order 11
    rules.push_back({
        "paragraph", 11, false, {},
        [](const QString& text, const MarkdownParseOptions& options, const QString&) -> RuleMatch {
            if (options.inlineOnly) return {};
            static const QRegularExpression re(R"(^((?:[^\n]|\n(?! *\n))+)(?:\n *)+\n)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Paragraph;
            auto subOpts = options;
            subOpts.inlineOnly = true;
            node.children = recurse(cap.value(1), subOpts);
            return {node};
        }
    });

    // 12. escape: order 12, required ['\\']
    rules.push_back({
        "escape", 12, false, {'\\'},
        [](const QString& text, const MarkdownParseOptions& options, const QString&) -> RuleMatch {
            if (!options.allowEscape) return {};
            static const QRegularExpression re(R"(^\\([^0-9A-Za-z\s]))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Text;
            node.content = cap.value(1);
            return {node};
        }
    });

    // 14. autolink: order 14, required ['<']
    rules.push_back({
        "autolink", 14, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<([^: >]+:\/[^ >]+)>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Link;
            node.target = cap.value(1);
            MarkdownNode child;
            child.type = MarkdownNodeType::Text;
            child.content = cap.value(1);
            node.children.push_back(child);
            return {node};
        }
    });

    // 15. mailto: order 15, required ['<']
    rules.push_back({
        "mailto", 15, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Link;
            QString target = cap.value(1);
            if (!target.startsWith("mailto:")) target.prepend("mailto:");
            node.target = target;
            MarkdownNode child;
            child.type = MarkdownNodeType::Text;
            child.content = cap.value(1);
            node.children.push_back(child);
            return {node};
        }
    });

    // 15. tel: order 15, required ['<']
    rules.push_back({
        "tel", 15, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<((?:(?:tel|sms):\+?|\+)(?:(?:[0-9]|\([0-9]+\)))(?:[- .\/]?(?:[0-9]|\([0-9]+\)))+)>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Link;
            QString target = cap.value(1);
            if (!target.startsWith("tel:") && !target.startsWith("sms:")) target.prepend("tel:");
            node.target = target;
            MarkdownNode child;
            child.type = MarkdownNodeType::Text;
            child.content = cap.value(1);
            node.children.push_back(child);
            return {node};
        }
    });

    // 16. url: order 16, required ['h', 's']
    rules.push_back({
        "url", 16, false, {'h', 's'},
        [](const QString& text, const MarkdownParseOptions& options, const QString&) -> RuleMatch {
            if (!options.inlineOnly) return {};
            static const QRegularExpression re(R"(^((?:https?|steam):\/\/[^\s<]+[^<.,:;"'\]\s]))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                QString matchedUrl = balanceUrlParentheses(match.captured(1));
                return {true, static_cast<int>(matchedUrl.length()), {matchedUrl, matchedUrl}, 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Link;
            node.target = cap.value(1);
            MarkdownNode child;
            child.type = MarkdownNodeType::Text;
            child.content = cap.value(1);
            node.children.push_back(child);
            return {node};
        }
    });

    // 17. link: order 17, required ['[']
    rules.push_back({
        "link", 17, false, {'['},
        [](const QString& text, const MarkdownParseOptions& options, const QString&) -> RuleMatch {
            if (!options.allowLinks || !text.contains("](")) return {};
            int bracketDepth = 0, parenLen = 0, deepCount = 0;
            for (int i = 0; i < text.length(); ++i) {
                const QChar c = text[i];
                if (bracketDepth >= 2) {
                    if (++deepCount > 100) return {};
                } else {
                    deepCount = 0;
                }
                if (c == ')') {
                    parenLen = 0;
                    continue;
                }
                if (c == '[') {
                    if (++bracketDepth > 10) return {};
                } else if (c == ']') {
                    if (bracketDepth > 0) bracketDepth--;
                } else if (c != '(') {
                    continue;
                }
                if (++parenLen > 200) return {};
            }
            static const QRegularExpression re(R"(^\[((?:\[[^\]]*\]|[^\[\]]|\](?=[^\[]*\]))*)\]\(\s*<?((?:\([^)]*\)|[^\s\\()]|\\.)*?)>?(?:\s+['"]([\s\S]*?)['"])?\s*\))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            const QString label = cap.value(1);
            const QString rawTarget = cap.value(2);
            const QString title = cap.value(3);
            static const QStringList allowedSchemes = {"http:", "https:", "discord:", "tel:", "sms:", "mailto:"};
            bool allowed = false;
            for (const auto& s : allowedSchemes) {
                if (rawTarget.startsWith(s, Qt::CaseInsensitive)) {
                    allowed = true;
                    break;
                }
            }
            if (!allowed) {
                MarkdownNode node;
                node.type = MarkdownNodeType::Text;
                node.content = cap.value(0);
                return {node};
            }
            MarkdownNode node;
            node.type = MarkdownNodeType::Link;
            node.target = rawTarget;
            node.title = title;
            auto subOpts = options;
            subOpts.allowLinks = false;
            node.children = recurse(label, subOpts);
            return {node};
        }
    });
    // 21. strong: order 21, required ['*'], quality = len + 0.1
    rules.push_back({
        "strong", 21, true, {'*'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^\*\*((?:\\(?:[\s\S])|[^\\])+?)\*\*(?!\*))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), match.capturedLength() + 0.1};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Strong;
            node.children = recurse(cap.value(1), options);
            return {node};
        }
    });

    // 21. em: order 21, quality = len + 0.2
    rules.push_back({
        "em", 21, true, {},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^\b_((?:__|\\(?:[\s\S])|[^\\_])+?)_\b|^\*(?=\S)((?:\*\*|\\(?:[\s\S])|\s+(?:\\(?:[\s\S])|[^\s*\\]|\*\*)|[^\s*\\])+?)\*(?!\*))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), match.capturedLength() + 0.2};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Em;
            const QString content = !cap.value(2).isEmpty() ? cap.value(2) : cap.value(1);
            node.children = recurse(content, options);
            return {node};
        }
    });

    // 21. looseEm: order 21, quality = len + 0.2
    rules.push_back({
        "looseEm", 21, true, {},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^\*(?=\S)((?:\*\*|\\(?:[\s\S])|\s+(?:\\(?:[\s\S])|[^\s*\\]|\*\*)|[^\s*\\])+?) {1,2}\*(?!\*))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), match.capturedLength() + 0.2};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Em;
            node.children = recurse(cap.value(1), options);
            return {node};
        }
    });

    // 21. u: order 21, required ['_'], quality = len
    rules.push_back({
        "u", 21, true, {'_'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^__((?:\\(?:[\s\S])|[^\\])+?)__(?!_))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), static_cast<double>(match.capturedLength())};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Underline;
            node.children = recurse(cap.value(1), options);
            return {node};
        }
    });

    // 21. s: strikethrough, order 21, required ['~']
    rules.push_back({
        "s", 21, false, {'~'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^~~([\s\S]+?)~~(?!_))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Strikethrough;
            node.children = recurse(cap.value(1), options);
            return {node};
        }
    });

    // 23. inlineCode: order 23, required ['`']
    rules.push_back({
        "inlineCode", 23, false, {'`'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^(`+)([\s\S]*?[^`])\1(?!`))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::InlineCode;
            QString content = cap.value(2);
            static const QRegularExpression spaceRe(R"(^ (?= *`)|(` *) $)");
            content.replace(spaceRe, "$1");
            node.content = content;
            return {node};
        }
    });

    // 24. br: order 24, required [' ']
    rules.push_back({
        "br", 24, false, {' '},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^ {2,}\n)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList&, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::LineBreak;
            return {node};
        }
    });

    // 24. timestamp: order 24, required ['<']
    rules.push_back({
        "timestamp", 24, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<t:(-?\d{1,17})(?::([tTdDfFsSR]))?>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Timestamp;
            node.content = cap.value(0);
            node.id = cap.value(1);
            node.lang = cap.value(2);
            return {node};
        }
    });
    // 25. spoiler: order 25, required ['|']
    rules.push_back({
        "spoiler", 25, false, {'|'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^\|\|([\s\S]+?)\|\|)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions& options, const auto& recurse) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Spoiler;
            node.children = recurse(cap.value(1), options);
            return {node};
        }
    });

    // 25. emoticon: order 25, required [QChar(0x00af)]
    rules.push_back({
        "emoticon", 25, false, {QChar(0x00af)},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^(\x{00af}\\_\(\x{30c4}\)_\/\x{00af}))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Emoticon;
            node.content = cap.value(1);
            return {node};
        }
    });

    // 25. roleMention: order 25, required ['<']
    rules.push_back({
        "roleMention", 25, false, {'<'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<@&(\d+)>)");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::RoleMention;
            node.id = cap.value(1);
            node.content = QString("@role:%1").arg(cap.value(1));
            return {node};
        }
    });

    // 25. mention: order 25, required ['<', '@']
    rules.push_back({
        "mention", 25, false, {'<', '@'},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^<@!?(\d+)>|^(@(?:everyone|here)))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Mention;
            if (!cap.value(1).isEmpty()) {
                node.id = cap.value(1);
                node.content = QString("@%1").arg(cap.value(1));
            } else {
                node.content = cap.value(2);
            }
            return {node};
        }
    });

    // 25. silentPrefix: order 25, required ['@']
    rules.push_back({
        "silentPrefix", 25, false, {'@'},
        [](const QString& text, const MarkdownParseOptions&, const QString& prevCapture) -> RuleMatch {
            if (!prevCapture.isEmpty()) return {};
            static const QRegularExpression re(R"(^(@silent(?![^\s])))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::SilentPrefix;
            node.content = cap.value(1);
            return {node};
        }
    });

    // 25. text: order 25
    rules.push_back({
        "text", 25, false, {},
        [](const QString& text, const MarkdownParseOptions&, const QString&) -> RuleMatch {
            static const QRegularExpression re(R"(^[\s\S]+?(?=[^0-9A-Za-z\s\x{00c0}-\x{ffff}]|\n\n| {2,}\n|\w+:\S|[0-9]+\.|$))");
            auto match = re.match(text);
            if (match.hasMatch() && match.capturedStart() == 0) {
                return {true, static_cast<int>(match.capturedLength()), match.capturedTexts(), 0.0};
            }
            if (!text.isEmpty()) {
                return {true, 1, {text.left(1)}, 0.0};
            }
            return {};
        },
        [](const QStringList& cap, const MarkdownParseOptions&, const auto&) -> std::vector<MarkdownNode> {
            MarkdownNode node;
            node.type = MarkdownNodeType::Text;
            node.content = cap.value(0);
            return {node};
        }
    });

    std::sort(rules.begin(), rules.end(), [](const Rule& a, const Rule& b) {
        if (a.order != b.order) return a.order < b.order;
        const int sqA = a.hasQuality ? 0 : 1;
        const int sqB = b.hasQuality ? 0 : 1;
        if (sqA != sqB) return sqA < sqB;
        return a.name < b.name;
    });

    return rules;
}
std::vector<MarkdownNode> parseInternal(QString text, MarkdownParseOptions options) {
    std::vector<MarkdownNode> result;
    const int depth = options.parseDepth + 1;
    if (depth > 1000) {
        if (!text.isEmpty()) {
            MarkdownNode fallback;
            fallback.type = MarkdownNodeType::Text;
            fallback.content = text;
            result.push_back(fallback);
        }
        return result;
    }
    options.parseDepth = depth;

    static const std::vector<Rule> rules = buildDiscordRules();

    std::unordered_map<ushort, std::vector<int>> charIndex;
    std::vector<int> fallbackIndices;
    for (int i = 0; i < static_cast<int>(rules.size()); ++i) {
        if (rules[i].requiredFirstCharacters.isEmpty()) {
            fallbackIndices.push_back(i);
        } else {
            for (const auto& ch : rules[i].requiredFirstCharacters) {
                charIndex[ch.unicode()].push_back(i);
            }
        }
    }

    QString prevCapture;
    while (!text.isEmpty()) {
        int bestRuleIndex = -1;
        RuleMatch bestMatch;
        int bestOrder = 100000;
        double bestQuality = -100000.0;

        const ushort firstChar = text[0].unicode();
        const std::vector<int>* candidateList = nullptr;
        auto it = charIndex.find(firstChar);
        if (it != charIndex.end()) {
            candidateList = &it->second;
        }

        const std::vector<const std::vector<int>*> candidateLists = {candidateList, &fallbackIndices};
        for (const auto* list : candidateLists) {
            if (!list) continue;
            for (int idx : *list) {
                const auto& rule = rules[idx];
                if (rule.order > bestOrder) {
                    break;
                }
                auto match = rule.match(text, options, prevCapture);
                if (match.matched && match.length > 0) {
                    const double q = match.quality;
                    if (rule.order < bestOrder || q > bestQuality) {
                        bestRuleIndex = idx;
                        bestMatch = match;
                        bestOrder = rule.order;
                        bestQuality = q;
                    }
                }
            }
        }

        if (bestRuleIndex < 0 || bestMatch.length <= 0) {
            MarkdownNode fallback;
            fallback.type = MarkdownNodeType::Text;
            fallback.content = text.left(1);
            result.push_back(fallback);
            prevCapture = text.left(1);
            text = text.mid(1);
            continue;
        }

        const auto& chosenRule = rules[bestRuleIndex];
        auto parsedNodes = chosenRule.parse(bestMatch.captures, options, [](const QString& sub, const MarkdownParseOptions& subOpts) {
            return parseInternal(sub, subOpts);
        });

        for (auto& n : parsedNodes) {
            result.push_back(std::move(n));
        }

        prevCapture = bestMatch.captures.value(0);
        text = text.mid(bestMatch.length);
    }

    return result;
}

} // namespace

std::vector<MarkdownNode> parseDiscordMarkdown(const QString& input, const MarkdownParseOptions& options) {
    QString normalized = normalizeInput(input);
    if (!options.inlineOnly && !options.disableAutoBlockNewlines) {
        normalized.append("\n\n");
    }
    return parseInternal(normalized, options);
}

QString markdownToPlainText(const std::vector<MarkdownNode>& nodes) {
    QString out;
    for (const auto& node : nodes) {
        switch (node.type) {
        case MarkdownNodeType::Text:
        case MarkdownNodeType::CustomEmoji:
        case MarkdownNodeType::Emoticon:
        case MarkdownNodeType::SilentPrefix:
            out.append(node.content);
            break;
        case MarkdownNodeType::InlineCode:
        case MarkdownNodeType::CodeBlock:
            out.append(node.content);
            break;
        case MarkdownNodeType::LineBreak:
        case MarkdownNodeType::Newline:
            out.append('\n');
            break;
        case MarkdownNodeType::Mention:
        case MarkdownNodeType::RoleMention:
            out.append(node.content);
            break;
        case MarkdownNodeType::Timestamp:
            out.append(formatDiscordTimestamp(node));
            break;
        case MarkdownNodeType::Heading:
        case MarkdownNodeType::Subtext:
        case MarkdownNodeType::BlockQuote:
        case MarkdownNodeType::Paragraph:
        case MarkdownNodeType::Strong:
        case MarkdownNodeType::Em:
        case MarkdownNodeType::Underline:
        case MarkdownNodeType::Strikethrough:
        case MarkdownNodeType::Spoiler:
        case MarkdownNodeType::Link:
        case MarkdownNodeType::Autolink:
        case MarkdownNodeType::Mailto:
        case MarkdownNodeType::Tel:
        case MarkdownNodeType::Url:
            out.append(markdownToPlainText(node.children));
            break;
        case MarkdownNodeType::List:
            for (const auto& item : node.listItems) {
                out.append(markdownToPlainText(item));
                out.append('\n');
            }
            break;
        }
    }
    return out;
}

QString formatDiscordTimestamp(const MarkdownNode& node, const QDateTime& now) {
    bool ok = false; const auto seconds = node.id.toLongLong(&ok);
    // JavaScript Date's TimeClip range, not QDateTime's larger representable range.
    if (!ok || seconds < -8640000000000LL || seconds > 8640000000000LL) return node.content;
    const auto date = QDateTime::fromSecsSinceEpoch(seconds);
    if (!date.isValid()) return node.content;
    const QLocale locale(QLocale::Portuguese, QLocale::Brazil);
    const auto shortDate = locale.toString(date.date(), "dd/MM/yyyy");
    const auto longDate = locale.toString(date.date(), "d 'de' MMMM 'de' yyyy");
    const auto time = date.toString("HH:mm");
    const auto format = node.lang.isEmpty() ? QString("f") : node.lang;
    if (format == "t") return time;
    if (format == "T") return date.toString("HH:mm:ss");
    if (format == "d") return shortDate;
    if (format == "D") return longDate;
    if (format == "s") return shortDate + " " + time;
    if (format == "S") return shortDate + " " + date.toString("HH:mm:ss");
    if (format == "F") return locale.toString(date.date(), "dddd") + ", " + longDate + " " + time;
    if (format != "R") return longDate + " " + time;
    // Modules 379418 / 536637: calendar-month duration, Math.round, and thresholds.
    const auto first = date < now ? date : now, last = date < now ? now : date;
    int months = (last.date().year()-first.date().year())*12 + last.date().month()-first.date().month();
    if (first.addMonths(months) > last) --months;
    const double remainder = first.addMonths(months).msecsTo(last);
    const double duration = std::round(months * 146097.0 / 4800.0)*86400000.0 + remainder;
    const double fractionalMonths = months + remainder / 86400000.0 * 4800.0 / 146097.0;
    const auto sec = std::round(duration/1000), min = std::round(duration/60000), hours = std::round(duration/3600000), days = std::round(duration/86400000);
    const auto monthCount = std::round(fractionalMonths), years = std::round(fractionalMonths/12);
    QString unit; qint64 count = 1;
    if (sec < 60) { count = std::max<qint64>(1,sec); unit = count == 1 ? "segundo" : "segundos"; }
    else if (min <= 1) unit = "minuto";
    else if (min < 60) { count = min; unit = "minutos"; }
    else if (hours <= 1) unit = "hora";
    else if (hours < 22) { count = hours; unit = "horas"; }
    else if (days <= 1) unit = "dia";
    else if (days < 26) { count = days; unit = "dias"; }
    else if (monthCount <= 1) unit = "mês";
    else if (monthCount < 11) { count = monthCount; unit = "meses"; }
    else if (years <= 1) unit = "ano";
    else { count = years; unit = "anos"; }
    return (date > now ? QString("em %1 %2") : QString("há %1 %2")).arg(count).arg(unit);
}

FormattedMarkdown buildFormattedMarkdown(const std::vector<MarkdownNode>& nodes, const QFont& baseFont, const QSet<int>& revealed) {
    FormattedMarkdown result;
    auto& text = result.plainText;
    auto& formats = result.formats;
    int spoilerId = 0;

    std::function<void(const std::vector<MarkdownNode>&, const QTextCharFormat&)> emitNodes;
    emitNodes = [&](const std::vector<MarkdownNode>& list, const QTextCharFormat& currentFormat) {
        for (const auto& node : list) {
            switch (node.type) {
            case MarkdownNodeType::Text:
            case MarkdownNodeType::CustomEmoji:
            case MarkdownNodeType::Emoticon:
            case MarkdownNodeType::SilentPrefix: {
                if (!node.content.isEmpty()) {
                    const int start = text.length();
                    text.append(node.content);
                    QTextLayout::FormatRange fr;
                    fr.start = start;
                    fr.length = node.content.length();
                    fr.format = currentFormat;
                    formats.push_back(fr);
                }
                break;
            }
            case MarkdownNodeType::Strong: {
                QTextCharFormat fmt = currentFormat;
                fmt.setFontWeight(QFont::Bold);
                emitNodes(node.children, fmt);
                break;
            }
            case MarkdownNodeType::Em: {
                QTextCharFormat fmt = currentFormat;
                fmt.setFontItalic(true);
                emitNodes(node.children, fmt);
                break;
            }
            case MarkdownNodeType::Underline: {
                QTextCharFormat fmt = currentFormat;
                fmt.setFontUnderline(true);
                emitNodes(node.children, fmt);
                break;
            }
            case MarkdownNodeType::Strikethrough: {
                QTextCharFormat fmt = currentFormat;
                fmt.setFontStrikeOut(true);
                emitNodes(node.children, fmt);
                break;
            }
            case MarkdownNodeType::InlineCode: {
                QTextCharFormat fmt = currentFormat;
                fmt.setFontFamilies({"Consolas", "Courier New", "monospace"});
                fmt.setBackground(QColor("#252525"));
                fmt.setForeground(QColor("#eeeeee"));
                const int start = text.length();
                text.append(node.content);
                QTextLayout::FormatRange fr;
                fr.start = start;
                fr.length = node.content.length();
                fr.format = fmt;
                formats.push_back(fr);
                break;
            }
            case MarkdownNodeType::CodeBlock: {
                if (!text.isEmpty() && !text.endsWith('\n')) text.append('\n');
                QTextCharFormat fmt = currentFormat;
                fmt.setFontFamilies({"Consolas", "Courier New", "monospace"});
                fmt.setBackground(QColor("#181818"));
                fmt.setForeground(QColor("#eeeeee"));
                const int start = text.length();
                text.append(node.content);
                QTextLayout::FormatRange fr;
                fr.start = start;
                fr.length = node.content.length();
                fr.format = fmt;
                formats.push_back(fr);
                if (!text.endsWith('\n')) text.append('\n');
                break;
            }
            case MarkdownNodeType::Spoiler: {
                const int id = spoilerId++, start = text.size(), firstFormat = formats.size();
                QTextCharFormat fmt = currentFormat;
                fmt.setBackground(QColor("#252525"));
                emitNodes(node.children, fmt);
                const bool visible = revealed.contains(id);
                result.spoilers.append({start, static_cast<int>(text.size()) - start, id, visible});
                if (!visible) {
                    // Hide all child styles too: links and emphasis must not expose the text.
                    for (int i = firstFormat; i < formats.size(); ++i) {
                        formats[i].format.setForeground(QColor("#252525"));
                        formats[i].format.setBackground(QColor("#252525"));
                        formats[i].format.setFontUnderline(false);
                        formats[i].format.setFontStrikeOut(false);
                    }
                }
                break;
            }
            case MarkdownNodeType::BlockQuote: {
                if (!text.isEmpty() && !text.endsWith('\n')) text.append('\n');
                QTextCharFormat fmt = currentFormat;
                fmt.setForeground(QColor("#aaaaaa"));
                emitNodes(node.children, fmt);
                if (!text.endsWith('\n')) text.append('\n');
                break;
            }
            case MarkdownNodeType::Subtext: {
                QTextCharFormat fmt = currentFormat;
                auto font = baseFont;
                if (font.pixelSize() > 0) font.setPixelSize(std::max(1, qRound(font.pixelSize() * 0.85)));
                else font.setPointSizeF(std::max(1.0, font.pointSizeF() * 0.85));
                fmt.setFont(font);
                fmt.setForeground(QColor("#aaaaaa"));
                emitNodes(node.children, fmt);
                break;
            }
            case MarkdownNodeType::Heading: {
                if (!text.isEmpty() && !text.endsWith('\n')) text.append('\n');
                QTextCharFormat fmt = currentFormat;
                fmt.setFontWeight(QFont::Bold);
                const qreal scale = node.level == 1 ? 1.4 : (node.level == 2 ? 1.25 : 1.1);
                auto font = baseFont;
                if (font.pixelSize() > 0) font.setPixelSize(std::max(1, qRound(font.pixelSize() * scale)));
                else font.setPointSizeF(std::max(1.0, font.pointSizeF() * scale));
                font.setBold(true); fmt.setFont(font);
                emitNodes(node.children, fmt);
                if (!text.endsWith('\n')) text.append('\n');
                break;
            }
            case MarkdownNodeType::Link:
            case MarkdownNodeType::Url:
            case MarkdownNodeType::Autolink:
            case MarkdownNodeType::Mailto:
            case MarkdownNodeType::Tel: {
                QTextCharFormat fmt = currentFormat;
                // Observed link: blue (#4a94f6 dominant under ClearType) without underline at rest.
                fmt.setForeground(QColor("#4a94f6"));
                fmt.setAnchor(true);
                fmt.setAnchorHref(node.target);
                if (!node.children.empty()) {
                    emitNodes(node.children, fmt);
                } else {
                    const int start = text.length();
                    text.append(!node.target.isEmpty() ? node.target : node.content);
                    QTextLayout::FormatRange fr;
                    fr.start = start;
                    fr.length = text.length() - start;
                    fr.format = fmt;
                    formats.push_back(fr);
                }
                break;
            }
            case MarkdownNodeType::Mention:
            case MarkdownNodeType::RoleMention: {
                QTextCharFormat fmt = currentFormat;
                fmt.setForeground(QColor("#eeeeee"));
                fmt.setBackground(QColor("#252525"));
                fmt.setFontWeight(QFont::DemiBold);
                const int start = text.length();
                text.append(node.content);
                QTextLayout::FormatRange fr;
                fr.start = start;
                fr.length = node.content.length();
                fr.format = fmt;
                formats.push_back(fr);
                break;
            }
            case MarkdownNodeType::Timestamp: {
                QTextCharFormat fmt = currentFormat;
                fmt.setForeground(QColor("#eeeeee"));
                fmt.setBackground(QColor("#252525"));
                const int start = text.length();
                const auto label = formatDiscordTimestamp(node);
                text.append(label);
                QTextLayout::FormatRange fr;
                fr.start = start;
                fr.length = label.length();
                fr.format = fmt;
                formats.push_back(fr);
                break;
            }
            case MarkdownNodeType::Paragraph: {
                emitNodes(node.children, currentFormat);
                if (!text.endsWith("\n\n")) text.append("\n\n");
                break;
            }
            case MarkdownNodeType::LineBreak:
            case MarkdownNodeType::Newline: {
                text.append('\n');
                break;
            }
            case MarkdownNodeType::List: {
                int itemIdx = 1;
                for (const auto& item : node.listItems) {
                    if (!text.isEmpty() && !text.endsWith('\n')) text.append('\n');
                    const QString prefix = node.ordered ? QString("%1. ").arg(itemIdx++) : QString("• ");
                    text.append(prefix);
                    emitNodes(item, currentFormat);
                    if (!text.endsWith('\n')) text.append('\n');
                }
                break;
            }
            }
        }
    };

    QTextCharFormat baseFmt;
    baseFmt.setFont(baseFont);
    baseFmt.setForeground(QColor("#eeeeee"));
    emitNodes(nodes, baseFmt);

    while (text.endsWith("\n\n")) {
        text.chop(1);
    }

    return result;
}

} // namespace triscord
