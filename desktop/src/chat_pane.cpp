#include "markdown_parser.h"
#include "chat_pane.h"
#include "discord_icons.h"
#include "discord_tooltip.h"
#include <QHBoxLayout>
#include <QPushButton>
#include <QJsonArray>
#include <QMenu>
#include <QScrollBar>
#include <QStyledItemDelegate>
#include <QPainter>
#include <QTextLayout>
#include <QDateTime>
#include <QTextBoundaryFinder>
#include <QLocale>
#include <QMouseEvent>
#include <algorithm>
#include <cmath>
#include <functional>
#include <QShowEvent>
#include <QHideEvent>
namespace triscord {
namespace {
constexpr int GroupStartRole = Qt::UserRole + 2;
constexpr int DateSeparatorRole = Qt::UserRole + 3;
constexpr int DateSeparatorHeight = 24;
constexpr int RevealedSpoilersRole = Qt::UserRole + 4;
QDate messageDate(const QJsonObject& message) {
    const auto time = message.value("timestamp").toInteger();
    return time > 0 ? QDateTime::fromMSecsSinceEpoch(time).date() : QDate{};
}
QString dateCaption(const QDate& date) {
    return date.isValid() ? QLocale(QLocale::Portuguese,QLocale::Brazil).toString(date,"d 'de' MMMM 'de' yyyy") : QString{};
}
bool sameMessageGroup(const QJsonObject& anchor, const QJsonObject& current) {
    auto identity = [](const QJsonObject& message) {
        const auto user = message.value("senderUserId").toString();
        if (!user.isEmpty()) return QString("user:") + user;
        const auto socket = message.value("senderSocketId").toString();
        return socket.isEmpty() ? QString{} : QString("socket:") + socket;
    };
    const auto user = identity(anchor);
    if (user.isEmpty() || user != identity(current)) return false;
    const auto first = anchor.value("timestamp").toInteger(), time = current.value("timestamp").toInteger();
    if (first <= 0 || time <= 0) return false;
    const auto distance = first > time ? first - time : time - first;
    if (distance >= 7 * 60 * 1000) return false;
    const auto firstDate = QDateTime::fromMSecsSinceEpoch(first), date = QDateTime::fromMSecsSinceEpoch(time);
    return firstDate.isValid() && date.isValid() && firstDate.date().day() == date.date().day();
}
QString messageTime(const QJsonObject& message) {
    const auto value = message.value("timestamp").toInteger();
    if (value <= 0) return {};
    const auto time = QDateTime::fromMSecsSinceEpoch(value);
    if (!time.isValid()) return {};
    // Observed in Discord: messages from earlier days show "dd/MM/yyyy HH:mm". The wording for today and
    // yesterday was not observed, so those keep the time only.
    const auto today = QDate::currentDate();
    if (time.date() != today && time.date() != today.addDays(-1)) return time.toString("dd/MM/yyyy HH:mm");
    return time.toString("HH:mm");
}
qreal wrapMessage(QTextLayout& text, int width) {
    QTextOption option; option.setWrapMode(QTextOption::WrapAtWordBoundaryOrAnywhere); text.setTextOption(option);
    text.beginLayout(); qreal height = 0;
    while (true) {
        auto line = text.createLine(); if (!line.isValid()) break;
        line.setLineWidth(std::max(1,width)); line.setPosition({0,height}); height += line.height();
    }
    text.endLayout(); return height;
}
class MessageDelegate final : public QStyledItemDelegate {
public:
    explicit MessageDelegate(ChatPane* pane) : QStyledItemDelegate(pane), pane_(pane) {}
    QSize sizeHint(const QStyleOptionViewItem& option, const QModelIndex& index) const override {
        const int width = std::max(1,pane_->viewport()->width());
        auto formatted = pane_->formattedMessage(index, option.font);
        formatted.plainText.replace('\n', QChar::LineSeparator);
        QTextLayout text(formatted.plainText, option.font);
        text.setFormats(formatted.formats);
        const auto height = wrapMessage(text, width - 88);
        const int reactions = index.data(Qt::UserRole + 1).toString().isEmpty() ? 0 : QFontMetrics(option.font).height() + 6;
        const bool header = !index.data(GroupStartRole).isValid() || index.data(GroupStartRole).toBool();
        const int dateHeight = index.data(DateSeparatorRole).toString().isEmpty() ? 0 : DateSeparatorHeight;
        return {width,dateHeight + std::max(header ? 48 : 0,static_cast<int>(std::ceil(height)) + (header ? QFontMetrics(option.font).height() + 12 : 6) + reactions)};
    }
    void paint(QPainter* painter, const QStyleOptionViewItem& option, const QModelIndex& index) const override {
        const auto message = index.data(Qt::UserRole).toJsonObject();
        const auto name = message.value("senderName").toString();
        QRect rect = option.rect;
        // Discord: --custom-message-avatar-size: 40px; margin-left: 16px; content-left: 72px
        const int left = rect.left() + 72, width = std::max(1,rect.width() - 88);
        const QFontMetrics metrics(option.font); const int headerHeight = metrics.height();
        painter->save(); painter->setClipRect(rect); painter->setRenderHint(QPainter::Antialiasing);
        const auto date = index.data(DateSeparatorRole).toString();
        const QRect messageArea = rect.adjusted(0, date.isEmpty() ? 0 : DateSeparatorHeight, 0, 0);
        if (option.state & QStyle::State_Selected) painter->fillRect(messageArea,QColor("#242426"));
        else if (option.state & QStyle::State_MouseOver) painter->fillRect(messageArea,QColor("#3e3f45"));
        if (!date.isEmpty()) {
            auto dateFont = option.font; dateFont.setPixelSize(12); dateFont.setWeight(QFont::DemiBold);
            const QFontMetrics dateMetrics(dateFont);
            const auto caption = dateMetrics.elidedText(date,Qt::ElideRight,std::max(1,rect.width()-24));
            const int half = dateMetrics.horizontalAdvance(caption)/2, center = rect.center().x(), y = rect.top()+12;
            painter->setPen(QColor("#1e1e20"));
            if (center-half-8 > rect.left()+12) painter->drawLine(rect.left()+12,y,center-half-8,y);
            if (center+half+8 < rect.right()-12) painter->drawLine(center+half+8,y,rect.right()-12,y);
            painter->setFont(dateFont); painter->setPen(QColor("#949ba4"));
            painter->drawText(QRect(rect.left()+12,rect.top()+3,std::max(1,rect.width()-24),18),Qt::AlignCenter,caption);
            rect.setTop(rect.top()+DateSeparatorHeight);
        }
        const bool header = !index.data(GroupStartRole).isValid() || index.data(GroupStartRole).toBool();
        const auto time = messageTime(message);
        if (header) {
            painter->setPen(QPen(QColor("#242426"), 1)); painter->setBrush(QColor("#414249"));
            const QRect avatar(rect.left()+16,rect.top()+6,40,40); painter->drawEllipse(avatar);
            QTextBoundaryFinder boundary(QTextBoundaryFinder::Grapheme,name); const int first = boundary.toNextBoundary();
            auto avatarFont = option.font; avatarFont.setBold(true);
            painter->setFont(avatarFont); painter->setPen(QColor("#dcdcdf")); painter->drawText(avatar,Qt::AlignCenter,name.left(std::max(0,first)));
            // Observed (CHAT.md): name 16px semibold white, time 12px #9d9ea5, 16px content.
            auto authorFont = option.font; authorFont.setWeight(QFont::DemiBold); const QFontMetrics authorMetrics(authorFont);
            auto timeFont = option.font; timeFont.setPixelSize(12); const QFontMetrics timeMetrics(timeFont);
            const int timeWidth = time.isEmpty() ? 0 : timeMetrics.horizontalAdvance(time) + 10;
            const auto author = authorMetrics.elidedText(name,Qt::ElideRight,std::max(1,width-timeWidth));
            painter->setFont(authorFont); painter->setPen(QColor("#dcdcdf"));
            painter->drawText(QRect(left,rect.top()+8,std::max(1,width-timeWidth),headerHeight),Qt::AlignLeft|Qt::AlignVCenter,author);
            if (!time.isEmpty()) {
                painter->setFont(timeFont); painter->setPen(QColor("#9d9ea5"));
                painter->drawText(QRect(left+authorMetrics.horizontalAdvance(author)+8,rect.top()+8,timeWidth,headerHeight),Qt::AlignLeft|Qt::AlignVCenter,time);
            }
        } else if (!time.isEmpty() && (option.state & (QStyle::State_MouseOver | QStyle::State_Selected))) {
            painter->setFont(option.font); painter->setPen(QColor("#81828a"));
            painter->drawText(QRect(rect.left()+8,rect.top()+3,56,headerHeight),Qt::AlignRight|Qt::AlignVCenter,time);
        }
        const int bodyTop = rect.top() + (header ? 8 + headerHeight : 3);
        auto formatted = pane_->formattedMessage(index, option.font);
        formatted.plainText.replace('\n', QChar::LineSeparator);
        QTextLayout text(formatted.plainText, option.font);
        text.setFormats(formatted.formats);
        const auto textHeight = wrapMessage(text, width);
        painter->setPen(QColor("#d4d5d8"));
        text.draw(painter, {static_cast<qreal>(left), static_cast<qreal>(bodyTop)});
        const auto reactions = index.data(Qt::UserRole+1).toString();
        if (!reactions.isEmpty()) {
            painter->setFont(option.font); painter->setPen(QColor("#d4d5d8"));
            const int reactionTop = bodyTop + 4 + static_cast<int>(std::ceil(textHeight));
            const int textWidth = metrics.horizontalAdvance(reactions);
            const QRect reactionPill(left, reactionTop - 2, textWidth + 12, headerHeight + 4);
            painter->setBrush(QColor("#414249")); painter->setPen(QPen(QColor("#242426"), 1));
            painter->drawRoundedRect(reactionPill, 6, 6);
            painter->setPen(QColor("#d4d5d8"));
            painter->drawText(QRect(left + 6, reactionTop, textWidth, headerHeight), Qt::AlignLeft|Qt::AlignVCenter, reactions);
        }
        painter->restore();
    }
private:
    ChatPane* pane_;
};

// triscord's reaction set (shared by the quick reactions, the picker and the context menu).
struct Reaction { const char* emoji; const char* code; };
constexpr Reaction kReactions[] = {{"👍", "thumbsup"}, {"❤️", "heart"}, {"😂", "joy"}, {"😮", "open_mouth"}, {"😢", "cry"}, {"🎉", "tada"}};

// Message action bar observed on hover (CHAT.md): 32px tall, radius 8, 28px buttons with 20px glyphs,
// three quick reactions, a 1px divider with 4px gaps, then the actions; 16px above the message top and
// 14px from its right edge. Black-theme surface like the other popovers.
class MessageActionBar final : public QFrame {
public:
    explicit MessageActionBar(QWidget* parent) : QFrame(parent) {
        setObjectName("messageActionBar");
        setFixedHeight(32);
        setStyleSheet(
            "QFrame#messageActionBar { background:#0a0a0c; border:1px solid #48484d; border-radius:8px; }"
            "QFrame#messageActionDivider { background:#262629; border:none; }"
            "QPushButton { background:transparent; border:none; border-radius:4px; padding:0; }"
            "QPushButton:hover { background:#1b1b1e; }"
            "QPushButton#messageQuickReaction { font-family:\"Segoe UI Emoji\"; font-size:20px; }");
        layout_ = new QHBoxLayout(this);
        layout_->setContentsMargins(2, 1, 2, 1);
        layout_->setSpacing(0);
    }
    QPushButton* addEmoji(const Reaction& reaction) {
        auto* button = addButton("messageQuickReaction", QString(":%1:\nClique para reagir").arg(QString::fromLatin1(reaction.code)));
        button->setText(QString::fromUtf8(reaction.emoji));
        return button;
    }
    QPushButton* addIcon(const char* name, DiscordIcons::IconType icon, const QString& tooltip) {
        auto* button = addButton(name, tooltip);
        button->setIconSize(QSize(20, 20));
        const QIcon idle = DiscordIcons::icon(icon, QColor("#96979e"), 20), hover = DiscordIcons::icon(icon, QColor("#dcdcdf"), 20);
        button->setIcon(idle);
        button->installEventFilter(new HoverIcon(button, idle, hover));
        return button;
    }
    void addDivider() {
        layout_->addSpacing(4);
        auto* line = new QFrame(this);
        line->setObjectName("messageActionDivider");
        line->setFixedSize(1, 24);
        layout_->addWidget(line, 0, Qt::AlignVCenter);
        layout_->addSpacing(4);
    }
private:
    // Observed: the glyph turns white over the hovered button.
    class HoverIcon final : public QObject {
    public:
        HoverIcon(QPushButton* button, QIcon idle, QIcon hover) : QObject(button), button_(button), idle_(std::move(idle)), hover_(std::move(hover)) {}
        bool eventFilter(QObject*, QEvent* event) override {
            if (event->type() == QEvent::Enter) button_->setIcon(hover_);
            else if (event->type() == QEvent::Leave || event->type() == QEvent::Hide) button_->setIcon(idle_);
            return false;
        }
    private:
        QPushButton* button_; QIcon idle_, hover_;
    };
    QPushButton* addButton(const char* name, const QString& tooltip) {
        auto* button = new QPushButton(this);
        button->setObjectName(name);
        button->setFixedSize(28, 28);
        button->setCursor(Qt::PointingHandCursor);
        button->setFocusPolicy(Qt::NoFocus);
        button->setToolTip(tooltip);
        installDiscordTooltip(button);
        layout_->addWidget(button, 0, Qt::AlignVCenter);
        return button;
    }
    QHBoxLayout* layout_;
};
}
ChatPane::ChatPane(QWidget* parent) : QListWidget(parent) {
    setAccessibleName("Conversa do canal");
    QFont messageFont = font(); messageFont.setPixelSize(16); setFont(messageFont);
    setWordWrap(true); setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    setResizeMode(QListView::Adjust); setItemDelegate(new MessageDelegate(this));
    setMouseTracking(true);
    relativeRefresh_.setSingleShot(true);
    connect(&relativeRefresh_, &QTimer::timeout, this, [this] {
        for (int n = 0; n < count(); ++n) {
            auto* row = item(n);
            if (!visualItemRect(row).intersects(viewport()->rect())) continue;
            auto it = prepared_.find(QPersistentModelIndex(indexFromItem(row)));
            if (it != prepared_.end() && it->relativeInterval) {
                it->stale = true; refreshAccessibleText(row);
                emit model()->dataChanged(indexFromItem(row), indexFromItem(row), {Qt::SizeHintRole});
            }
        }
        viewport()->update(); scheduleRelativeRefresh();
    });
    connect(verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { scheduleRelativeRefresh(); });
    connect(model(), &QAbstractItemModel::rowsAboutToBeRemoved, this, [this] { prepared_.clear(); relativeRefresh_.stop(); });
    connect(model(), &QAbstractItemModel::modelAboutToBeReset, this, [this] { prepared_.clear(); relativeRefresh_.stop(); });
    setContextMenuPolicy(Qt::CustomContextMenu);
    connect(this, &QWidget::customContextMenuRequested, this, [this](const QPoint& position) {
        auto* item = itemAt(position); if (!item) return;
        if (!item->data(DateSeparatorRole).toString().isEmpty() && position.y() < visualItemRect(item).top()+DateSeparatorHeight) return;
        showMessageMenu(item, viewport()->mapToGlobal(position), true);
    });

    auto* bar = new MessageActionBar(viewport());
    actionBar_ = bar;
    for (int n = 0; n < 3; ++n) {
        const auto emoji = QString::fromUtf8(kReactions[n].emoji);
        connect(bar->addEmoji(kReactions[n]), &QPushButton::clicked, this, [this, emoji] {
            if (auto* row = actionItem()) emit reactionRequested(row->data(Qt::UserRole).toJsonObject().value("id").toString(), emoji);
        });
    }
    bar->addDivider();
    auto* react = bar->addIcon("messageAddReaction", DiscordIcons::IconType::Reaction, "Adicionar reação");
    connect(react, &QPushButton::clicked, this, [this, react] {
        if (auto* row = actionItem()) showMessageMenu(row, react->mapToGlobal(QPoint(0, react->height() + 4)), false);
    });
    auto* more = bar->addIcon("messageMoreActions", DiscordIcons::IconType::MoreHorizontal, "Mais");
    connect(more, &QPushButton::clicked, this, [this, more] {
        if (auto* row = actionItem()) showMessageMenu(row, more->mapToGlobal(QPoint(0, more->height() + 4)), true);
    });
    bar->adjustSize();
    bar->hide();
    connect(verticalScrollBar(), &QScrollBar::valueChanged, this, [this] { placeActionBar(); });
    connect(model(), &QAbstractItemModel::rowsRemoved, this, [this] { placeActionBar(); });
}
QListWidgetItem* ChatPane::actionItem() const {
    return actionRow_.isValid() ? item(actionRow_.row()) : nullptr;
}
void ChatPane::showMessageMenu(QListWidgetItem* item, const QPoint& globalPos, bool includeMessageActions) {
    const auto message = item->data(Qt::UserRole).toJsonObject();
    const auto id = message.value("id").toString();
    if (id.isEmpty()) return;
    QMenu menu(this);
    for (const auto& reaction : kReactions) {
        const auto emoji = QString::fromUtf8(reaction.emoji);
        auto* action = menu.addAction(emoji);
        connect(action, &QAction::triggered, this, [this, id, emoji] { emit reactionRequested(id, emoji); });
    }
    if (includeMessageActions && !userId_.isEmpty() && message.value("senderUserId").toString() == userId_) {
        menu.addSeparator(); auto* remove = menu.addAction("Excluir Mensagem");
        connect(remove, &QAction::triggered, this, [this, id] { emit deleteRequested(id); });
    }
    menu.exec(globalPos);
}
void ChatPane::placeActionBar() {
    if (!actionBar_) return;
    auto* row = actionItem();
    const auto message = row ? row->data(Qt::UserRole).toJsonObject() : QJsonObject{};
    if (!row || message.value("id").toString().isEmpty()) { actionBar_->hide(); return; }
    QRect area = visualItemRect(row);
    if (!row->data(DateSeparatorRole).toString().isEmpty()) area.setTop(area.top() + DateSeparatorHeight);
    if (area.bottom() < 0 || area.top() > viewport()->height()) { actionBar_->hide(); return; }
    // Observed: 16px above the message top, 14px from its right edge; kept inside the list (inferred).
    actionBar_->move(area.right() + 1 - 14 - actionBar_->width(), std::max(0, area.top() - 16));
    actionBar_->show();
    actionBar_->raise();
}
void ChatPane::setActionRow(QListWidgetItem* row) {
    const QPersistentModelIndex index = row ? QPersistentModelIndex(indexFromItem(row)) : QPersistentModelIndex();
    if (index == actionRow_) { if (row) placeActionBar(); return; }
    actionRow_ = index;
    placeActionBar();
}
bool ChatPane::viewportEvent(QEvent* event) {
    if (event->type() == QEvent::Leave && actionBar_ && !actionBar_->underMouse()) setActionRow(nullptr);
    return QListWidget::viewportEvent(event);
}
ChatPane::~ChatPane() {
    // QListWidget destroys its model after derived members. Its reset/scroll
    // signals must no longer reach the cache or timer at that point.
    relativeRefresh_.stop();
    disconnect(model(), nullptr, this, nullptr);
    disconnect(verticalScrollBar(), nullptr, this, nullptr);
    prepared_.clear();
}
void ChatPane::present(QListWidgetItem* item, const QJsonObject& message) {
    auto text = QString("%1: %2").arg(message.value("senderName").toString(), message.value("text").toString());
    const auto reactions = message.value("reactions").toObject();
    QStringList counts;
    for (auto it = reactions.begin(); it != reactions.end(); ++it)
        if (!it.value().toArray().isEmpty()) counts.append(it.key() + " " + QString::number(it.value().toArray().size()));
    const auto reactionText = counts.join("   ");
    if (!counts.isEmpty()) text += "\n" + reactionText;
    item->setData(Qt::UserRole+1,reactionText);
    item->setData(Qt::UserRole, message); item->setText(text);
    item->setData(Qt::AccessibleTextRole, dateCaption(messageDate(message)) + " " + message.value("senderName").toString() + " " + messageTime(message) + "\n" + message.value("text").toString() + "\n" + reactionText);
    item->setToolTip("Opções da mensagem (botão direito)");
}
void ChatPane::appendMessage(const QJsonObject& message) {
    const bool follow = verticalScrollBar()->value() >= verticalScrollBar()->maximum() - 4;
    while (count() >= 200) delete takeItem(0);
    auto* item = new QListWidgetItem(this); present(item, message);
    refreshAccessibleText(item);
    updateGroups();
    if (follow) scrollToBottom();
    scheduleRelativeRefresh();
}
void ChatPane::updateReactions(const QJsonObject& update) {
    for (int n = 0; n < count(); ++n) {
        auto message = item(n)->data(Qt::UserRole).toJsonObject();
        if (message.value("id") != update.value("messageId")) continue;
        message.insert("reactions", update.value("reactions")); present(item(n), message); refreshAccessibleText(item(n)); return;
    }
}
void ChatPane::removeMessage(const QString& id) {
    for (int n = 0; n < count(); ++n) if (item(n)->data(Qt::UserRole).toJsonObject().value("id").toString() == id) { delete takeItem(n); updateGroups(); return; }
}
void ChatPane::updateGroups() {
    QJsonObject anchor;
    QDate previousDate;
    for (int n = 0; n < count(); ++n) {
        auto* row = item(n); const auto message = row->data(Qt::UserRole).toJsonObject();
        const auto date = messageDate(message);
        const auto caption = date.isValid() && date != previousDate ? dateCaption(date) : QString{};
        if (row->data(DateSeparatorRole).toString() != caption) row->setData(DateSeparatorRole,caption);
        previousDate = date;
        const bool starts = n == 0 || !sameMessageGroup(anchor,message);
        if (starts) anchor = message;
        if (!row->data(GroupStartRole).isValid() || row->data(GroupStartRole).toBool() != starts)
            row->setData(GroupStartRole,starts);
    }
}
const FormattedMarkdown& ChatPane::formattedMessage(const QModelIndex& index, const QFont& font) const {
    auto& cached = prepared_[QPersistentModelIndex(index)];
    const auto source = index.data(Qt::UserRole).toJsonObject().value("text").toString();
    QSet<int> revealed;
    for (const auto& value : index.data(RevealedSpoilersRole).toList()) revealed.insert(value.toInt());
    const bool changed = !cached.ready || cached.source != source;
    if (changed) {
        cached.nodes = parseDiscordMarkdown(source); cached.source = source; cached.relativeInterval = 0;
        std::function<void(const std::vector<MarkdownNode>&)> visit = [&](const auto& nodes) {
            for (const auto& node : nodes) {
                if (node.type == MarkdownNodeType::Timestamp && node.lang == "R") {
                    bool ok; const auto seconds = node.id.toLongLong(&ok);
                    if (ok && seconds >= -8640000000000LL && seconds <= 8640000000000LL) {
                        const auto date = QDateTime::fromSecsSinceEpoch(seconds);
                        const auto distance = std::abs(date.msecsTo(QDateTime::currentDateTime()));
                        // Discord module 785562: 1s / 1m / 2m / 5m / 2h cadence.
                        const int interval = distance < 120000 ? 1000 : distance < 300000 ? 60000 :
                            distance < 2700000 ? 120000 : distance < 75600000 ? 300000 : 7200000;
                        if (!cached.relativeInterval || interval < cached.relativeInterval) cached.relativeInterval = interval;
                    }
                }
                visit(node.children); for (const auto& list : node.listItems) visit(list);
            }
        };
        visit(cached.nodes);
    }
    if (changed || cached.stale || cached.font != font || cached.revealed != revealed) {
        cached.formatted = buildFormattedMarkdown(cached.nodes, font, revealed);
        cached.font = font; cached.revealed = revealed; cached.ready = true; cached.stale = false;
    }
    return cached.formatted;
}
void ChatPane::refreshAccessibleText(QListWidgetItem* row) {
    const auto& formatted = formattedMessage(indexFromItem(row), font());
    auto visible = formatted.plainText;
    auto ranges = formatted.spoilers;
    std::sort(ranges.begin(), ranges.end(), [](const auto& a, const auto& b) { return a.start > b.start; });
    for (const auto& range : ranges) if (!range.revealed) visible.replace(range.start, range.length, "[spoiler]");
    const auto message = row->data(Qt::UserRole).toJsonObject();
    row->setData(Qt::AccessibleTextRole, dateCaption(messageDate(message)) + " " +
        message.value("senderName").toString() + " " + messageTime(message) + "\n" + visible +
        "\n" + row->data(Qt::UserRole+1).toString());
}
int ChatPane::characterAt(QListWidgetItem* row, const QPoint& position) const {
    const auto rect = visualItemRect(row);
    const bool header = row->data(GroupStartRole).toBool();
    const int dateHeight = row->data(DateSeparatorRole).toString().isEmpty() ? 0 : DateSeparatorHeight;
    const QPoint origin(rect.left()+72, rect.top()+dateHeight+(header ? 8+QFontMetrics(font()).height() : 3));
    const auto point = position - origin;
    if (point.x() < 0 || point.y() < 0) return -1;
    auto formatted = formattedMessage(indexFromItem(row), font());
    formatted.plainText.replace('\n', QChar::LineSeparator);
    QTextLayout layout(formatted.plainText, font()); layout.setFormats(formatted.formats);
    wrapMessage(layout, rect.width()-88);
    for (int i = 0; i < layout.lineCount(); ++i) {
        const auto line = layout.lineAt(i);
        if (point.y() >= line.y() && point.y() < line.y()+line.height() && point.x() < line.naturalTextWidth())
            return line.xToCursor(point.x(), QTextLine::CursorOnCharacter);
    }
    return -1;
}
void ChatPane::mousePressEvent(QMouseEvent* event) {
    auto* row = itemAt(event->pos());
    if (row && !row->data(DateSeparatorRole).toString().isEmpty() && event->pos().y() < visualItemRect(row).top()+DateSeparatorHeight) {
        event->ignore(); return;
    }
    if (row && event->button() == Qt::LeftButton) {
        const auto character = characterAt(row, event->pos());
        const auto formatted = formattedMessage(indexFromItem(row), font());
        for (const auto& range : formatted.spoilers) {
            if (!range.revealed && character >= range.start && character < range.start+range.length) {
                auto revealed = row->data(RevealedSpoilersRole).toList(); revealed.append(range.id);
                row->setData(RevealedSpoilersRole, revealed); refreshAccessibleText(row);
                viewport()->update(visualItemRect(row)); event->accept(); return;
            }
        }
        for (const auto& range : formatted.formats) {
            if (character < range.start || character >= range.start+range.length || !range.format.isAnchor()) continue;
            const QUrl url(range.format.anchorHref(), QUrl::StrictMode);
            const auto scheme = url.scheme().toLower();
            const bool web = (scheme == "https" || scheme == "http") && !url.host().isEmpty();
            if (url.isValid() && (web || scheme == "mailto" || scheme == "tel" || scheme == "sms" || scheme == "discord"))
                emit linkRequested(url);
            event->accept(); return;
        }
    }
    QListWidget::mousePressEvent(event);
}
void ChatPane::scheduleRelativeRefresh() {
    if (!isVisible()) { relativeRefresh_.stop(); return; }
    int interval = 0;
    for (int n = 0; n < count(); ++n) {
        auto* row = item(n);
        if (!visualItemRect(row).intersects(viewport()->rect())) continue;
        formattedMessage(indexFromItem(row),font());
        const auto cached = prepared_.constFind(QPersistentModelIndex(indexFromItem(row)));
        const int cadence = cached == prepared_.cend() ? 0 : cached->relativeInterval;
        if (cadence && (!interval || cadence < interval)) interval = cadence;
    }
    if (!interval) relativeRefresh_.stop();
    else if (!relativeRefresh_.isActive() || relativeRefresh_.interval() != interval) relativeRefresh_.start(interval);
}
void ChatPane::showEvent(QShowEvent* event) {
    QListWidget::showEvent(event);
    for (auto& cached : prepared_) if (cached.relativeInterval) cached.stale = true;
    scheduleRelativeRefresh();
}
void ChatPane::hideEvent(QHideEvent* event) { relativeRefresh_.stop(); QListWidget::hideEvent(event); }
void ChatPane::mouseMoveEvent(QMouseEvent* event) {
    bool interactive = false;
    if (auto* row = itemAt(event->pos())) {
        const int character = characterAt(row, event->pos());
        const auto& formatted = formattedMessage(indexFromItem(row), font());
        for (const auto& range : formatted.spoilers)
            interactive |= !range.revealed && character >= range.start && character < range.start+range.length;
        for (const auto& range : formatted.formats)
            interactive |= range.format.isAnchor() && character >= range.start && character < range.start+range.length;
    }
    viewport()->setCursor(interactive ? Qt::PointingHandCursor : Qt::ArrowCursor);
    auto* hovered = itemAt(event->pos());
    if (hovered && !hovered->data(DateSeparatorRole).toString().isEmpty() && event->pos().y() < visualItemRect(hovered).top()+DateSeparatorHeight) hovered = nullptr;
    setActionRow(hovered);
    QListWidget::mouseMoveEvent(event);
}
}
