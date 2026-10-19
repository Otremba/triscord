#include "call_shortcuts.h"
#include <QCoreApplication>
#include <QSignalBlocker>
#include <algorithm>
#include <windows.h>
namespace triscord {
CallShortcuts::CallShortcuts(QObject* parent, bool native) : QObject(parent), native_(native) {
    static int nextId = 0x5200;
    talkId_ = ++nextId; muteId_ = ++nextId;
    releaseTimer_.setInterval(16);
    connect(&releaseTimer_, &QTimer::timeout, this, [this] {
        if (!(GetAsyncKeyState(talkKey_) & 0x8000)) setTalkKeyPressed(false);
    });
    tailTimer_.setSingleShot(true); tailTimer_.setTimerType(Qt::PreciseTimer);
    connect(&tailTimer_, &QTimer::timeout, this, [this] {
        if (held_ && !pressed_) { held_ = false; emit talkingChanged(false); }
    });
    if (native_) QCoreApplication::instance()->installNativeEventFilter(this);
}
CallShortcuts::~CallShortcuts() {
    QSignalBlocker blocker(this); release();
    if (native_) QCoreApplication::instance()->removeNativeEventFilter(this);
}
void CallShortcuts::release() {
    if (native_) {
        if (talkRegistered_) UnregisterHotKey(nullptr, talkId_);
        if (muteRegistered_) UnregisterHotKey(nullptr, muteId_);
    }
    talkRegistered_ = muteRegistered_ = false;
    releaseTimer_.stop();
    tailTimer_.stop(); pressed_ = false;
    if (held_) { held_ = false; emit talkingChanged(false); }
}
void CallShortcuts::registerKeys() {
    if (!active_) return;
    if (ptt_) {
        talkRegistered_ = !native_ || RegisterHotKey(nullptr, talkId_, MOD_NOREPEAT, talkKey_);
        if (!talkRegistered_) emit message("a tecla para falar está em uso. escolha outra nas configurações.");
    }
    if (mute_) {
        muteRegistered_ = !native_ || RegisterHotKey(nullptr, muteId_, MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT, 'M');
        if (!muteRegistered_) emit message("o atalho do microfone está em uso por outro aplicativo.");
    }
}
void CallShortcuts::configure(bool pushToTalk, bool muteShortcut, unsigned talkKey, int releaseDelayMs) {
    releaseDelayMs = std::clamp(releaseDelayMs, 0, 2000);
    if (ptt_ == pushToTalk && mute_ == muteShortcut && talkKey_ == talkKey && releaseDelayMs_ == releaseDelayMs) return;
    release(); ptt_ = pushToTalk; mute_ = muteShortcut; talkKey_ = talkKey; releaseDelayMs_ = releaseDelayMs; registerKeys();
}
void CallShortcuts::setActive(bool active) {
    if (active_ == active) return;
    release(); active_ = active; registerKeys();
}
void CallShortcuts::setTalkKeyPressed(bool pressed) {
    if (!active_ || !ptt_ || !talkRegistered_ || pressed_ == pressed) return;
    pressed_ = pressed;
    if (pressed) {
        tailTimer_.stop();
        if (!held_) { held_ = true; emit talkingChanged(true); }
        if (native_) releaseTimer_.start();
    } else {
        releaseTimer_.stop();
        if (releaseDelayMs_ > 0) tailTimer_.start(releaseDelayMs_);
        else if (held_) { held_ = false; emit talkingChanged(false); }
    }
}
bool CallShortcuts::nativeEventFilter(const QByteArray&, void* message, qintptr*) {
    auto* event = static_cast<MSG*>(message);
    if (!active_ || event->message != WM_HOTKEY) return false;
    if (muteRegistered_ && event->wParam == static_cast<WPARAM>(muteId_)) { emit muteRequested(); return true; }
    if (talkRegistered_ && event->wParam == static_cast<WPARAM>(talkId_)) {
        if (GetAsyncKeyState(talkKey_) & 0x8000) setTalkKeyPressed(true);
        return true;
    }
    return false;
}
}
