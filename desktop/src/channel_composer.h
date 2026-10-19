#pragma once
#include <QPlainTextEdit>

namespace triscord {

class ChannelComposer final : public QPlainTextEdit {
    Q_OBJECT
public:
    explicit ChannelComposer(QWidget* parent = nullptr);
    ~ChannelComposer() override;

    QString text() const;
    void setText(const QString& text);
    void setMaxLength(int maxLen);
    int maxLength() const { return maxLength_; }

signals:
    void returnPressed();

protected:
    void keyPressEvent(QKeyEvent* event) override;
    void insertFromMimeData(const QMimeData* source) override;
    void resizeEvent(QResizeEvent* event) override;
    void showEvent(QShowEvent* event) override;
    bool eventFilter(QObject* watched, QEvent* event) override;

public slots:
    void updateAdaptiveHeight();

private:
    int maxLength_ = 2000;
};

} // namespace triscord
