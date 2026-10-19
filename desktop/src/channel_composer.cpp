#include "channel_composer.h"
#include <QKeyEvent>
#include <QMimeData>
#include <QResizeEvent>
#include <QShowEvent>
#include <QTextDocument>
#include <QTextBlock>
#include <QTextLayout>
#include <QScrollBar>
#include <algorithm>
#include <cmath>

namespace triscord {

ChannelComposer::ChannelComposer(QWidget* parent) : QPlainTextEdit(parent) {
    setWordWrapMode(QTextOption::WrapAtWordBoundaryOrAnywhere);
    setHorizontalScrollBarPolicy(Qt::ScrollBarAlwaysOff);
    setVerticalScrollBarPolicy(Qt::ScrollBarAsNeeded);
    setTabChangesFocus(true);
    // Observed composer box: 58px outer, 56px inner, 16px text. This matches the later :root declaration
    // --custom-channel-textarea-text-area-height: 56px (419070.5a76dee70a3767eb.css offset 31138), which
    // overrides the earlier 44px one.
    setMinimumHeight(56);
    setFixedHeight(56);
    setStyleSheet("QPlainTextEdit { background: transparent; border: 0; color: #d4d5d8; font-size: 16px; selection-background-color: #5865f2; padding: 13px 0; }");

    connect(this, &QPlainTextEdit::textChanged, this, [this] {
        if (maxLength_ > 0 && toPlainText().length() > maxLength_) {
            const auto truncated = toPlainText().left(maxLength_);
            const int pos = textCursor().position();
            setPlainText(truncated);
            auto cursor = textCursor();
            cursor.setPosition(std::min(pos, static_cast<int>(truncated.length())));
            setTextCursor(cursor);
        }
        updateAdaptiveHeight();
    });
}

ChannelComposer::~ChannelComposer() {
    if (window()) {
        window()->removeEventFilter(this);
    }
}

QString ChannelComposer::text() const {
    return toPlainText();
}

void ChannelComposer::setText(const QString& text) {
    setPlainText(text);
    updateAdaptiveHeight();
}

void ChannelComposer::setMaxLength(int maxLen) {
    maxLength_ = maxLen;
    if (maxLength_ > 0 && toPlainText().length() > maxLength_) {
        setPlainText(toPlainText().left(maxLength_));
        updateAdaptiveHeight();
    }
}

void ChannelComposer::updateAdaptiveHeight() {
    qreal contentHeight = 0;
    for (QTextBlock block = document()->begin(); block.isValid(); block = block.next()) {
        auto* layout = block.layout();
        if (layout && layout->lineCount() > 0) {
            contentHeight += layout->boundingRect().height();
        } else {
            contentHeight += fontMetrics().lineSpacing();
        }
    }
    if (contentHeight <= 0) {
        contentHeight = fontMetrics().lineSpacing();
    }
    // 13px top/bottom padding centres one line in the observed 56px text area.
    const int margins = static_cast<int>(std::ceil(document()->documentMargin() * 2)) + 26;
    const int docPixelHeight = static_cast<int>(std::ceil(contentHeight)) + margins;

    // --custom-channel-textarea-text-area-height: 56px (observed) and max-height 50vh
    // (419070.5a76dee70a3767eb.css offsets 31138 and 18826).
    const int winH = window() ? window()->height() : 600;
    const int maxViewportHeight = std::max(56, winH / 2);
    const int targetHeight = std::clamp(docPixelHeight, 56, maxViewportHeight);
    if (height() != targetHeight) {
        setFixedHeight(targetHeight);
        updateGeometry();
    }
}

void ChannelComposer::keyPressEvent(QKeyEvent* event) {
    if (event->key() == Qt::Key_Return || event->key() == Qt::Key_Enter) {
        if (event->modifiers() & Qt::ShiftModifier) {
            QPlainTextEdit::keyPressEvent(event);
            updateAdaptiveHeight();
            return;
        }
        emit returnPressed();
        event->accept();
        return;
    }
    // Modifiers like Ctrl, Cmd/Meta (copy, paste, cut, select all, undo, redo, etc.)
    // Note: AltGr produces Ctrl+Alt on Windows; plain Ctrl shortcuts do not have Alt.
    const bool isControlShortcut = (event->modifiers() & (Qt::ControlModifier | Qt::MetaModifier)) &&
                                   !(event->modifiers() & Qt::AltModifier);
    if (!isControlShortcut && maxLength_ > 0 && toPlainText().length() >= maxLength_ && !textCursor().hasSelection()) {
        if (!event->text().isEmpty() && event->key() != Qt::Key_Backspace && event->key() != Qt::Key_Delete) {
            event->ignore();
            return;
        }
    }
    QPlainTextEdit::keyPressEvent(event);
}

void ChannelComposer::insertFromMimeData(const QMimeData* source) {
    if (!source || !source->hasText()) {
        QPlainTextEdit::insertFromMimeData(source);
        return;
    }
    QString textToInsert = source->text();
    if (maxLength_ > 0) {
        const int selectedLength = textCursor().hasSelection() ? textCursor().selectedText().length() : 0;
        const int currentLength = toPlainText().length() - selectedLength;
        const int remaining = maxLength_ - currentLength;
        if (remaining <= 0) return;
        if (textToInsert.length() > remaining) {
            textToInsert = textToInsert.left(remaining);
        }
    }
    textCursor().insertText(textToInsert);
    updateAdaptiveHeight();
}

void ChannelComposer::resizeEvent(QResizeEvent* event) {
    QPlainTextEdit::resizeEvent(event);
    updateAdaptiveHeight();
}

void ChannelComposer::showEvent(QShowEvent* event) {
    QPlainTextEdit::showEvent(event);
    if (window()) {
        window()->installEventFilter(this);
    }
    updateAdaptiveHeight();
}

bool ChannelComposer::eventFilter(QObject* watched, QEvent* event) {
    if (watched == window() && event->type() == QEvent::Resize) {
        updateAdaptiveHeight();
    }
    return QPlainTextEdit::eventFilter(watched, event);
}

} // namespace triscord
