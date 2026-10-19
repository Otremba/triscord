#pragma once
#include <QListWidget>
#include <QJsonObject>
#include <QPersistentModelIndex>
#include <QHash>
#include <QUrl>
#include <QTimer>
#include "markdown_parser.h"
namespace triscord {
class ChatPane final : public QListWidget {
    Q_OBJECT
public:
    explicit ChatPane(QWidget* parent = nullptr);
    ~ChatPane() override;
    void appendMessage(const QJsonObject& message);
    void updateReactions(const QJsonObject& update);
    void setCurrentUser(const QString& userId) { userId_ = userId; }
    void removeMessage(const QString& id);
    const FormattedMarkdown& formattedMessage(const QModelIndex& index, const QFont& font) const;
signals:
    void reactionRequested(const QString& messageId, const QString& emoji);
    void deleteRequested(const QString& messageId);
    void linkRequested(const QUrl& url);
protected:
    void mousePressEvent(QMouseEvent* event) override;
    void mouseMoveEvent(QMouseEvent* event) override;
    void showEvent(QShowEvent* event) override;
    void hideEvent(QHideEvent* event) override;
    bool viewportEvent(QEvent* event) override;
private:
    QListWidgetItem* actionItem() const;
    void setActionRow(QListWidgetItem* row);
    void placeActionBar();
    void showMessageMenu(QListWidgetItem* item, const QPoint& globalPos, bool includeMessageActions);
    QWidget* actionBar_ = nullptr;
    QPersistentModelIndex actionRow_;
    struct PreparedMessage {
        QString source;
        QFont font;
        QSet<int> revealed;
        std::vector<MarkdownNode> nodes;
        FormattedMarkdown formatted;
        bool ready{false};
        bool stale{false};
        int relativeInterval{0};
    };
    mutable QHash<QPersistentModelIndex, PreparedMessage> prepared_;
    int characterAt(QListWidgetItem* row, const QPoint& position) const;
    void refreshAccessibleText(QListWidgetItem* row);
    void scheduleRelativeRefresh();
    QTimer relativeRefresh_;
    void updateGroups();
    static void present(QListWidgetItem* item, const QJsonObject& message);
    QString userId_;
};
}
