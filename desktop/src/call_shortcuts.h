#pragma once
#include <QObject>
#include <QAbstractNativeEventFilter>
#include <QTimer>
namespace triscord {
class CallShortcuts final : public QObject, public QAbstractNativeEventFilter {
    Q_OBJECT
public:
    explicit CallShortcuts(QObject* parent = nullptr, bool native = true);
    ~CallShortcuts() override;
    void configure(bool pushToTalk, bool muteShortcut, unsigned talkKey = 0x77, int releaseDelayMs = 0);
    void setActive(bool active);
    void setTalkKeyPressed(bool pressed);
    bool nativeEventFilter(const QByteArray& type, void* message, qintptr* result) override;
signals:
    void talkingChanged(bool held);
    void muteRequested();
    void message(const QString& text);
private:
    void release();
    void registerKeys();
    bool native_, active_ = false, ptt_ = false, mute_ = true, held_ = false, pressed_ = false;
    bool talkRegistered_ = false, muteRegistered_ = false;
    unsigned talkKey_ = 0x77;
    int talkId_, muteId_;
    QTimer releaseTimer_;
    QTimer tailTimer_;
    int releaseDelayMs_ = 0;
};
inline bool microphoneMuted(bool manualMute, bool pushToTalk, bool held) {
    return manualMute || (pushToTalk && !held);
}
}
