#pragma once
#include "voice_codec.h"
#include <QObject>
#include <QTimer>
#include <memory>
namespace triscord {
// WASAPI process loopback excludes this process and its descendants.
class SystemAudio final : public QObject {
    Q_OBJECT
public:
    explicit SystemAudio(QObject* parent = nullptr);
    ~SystemAudio() override;
    bool start();
    void stop();
    QString failureReason() const { return failure_; }
signals:
    void captured(const QByteArray& opus);
    void error(const QString& message);
private:
    void tick();
    bool openCapture();
    struct State;
    std::unique_ptr<State> state_;
    QTimer timer_;
    QTimer retry_;
    VoiceEncoder encoder_{true};
    QString failure_;
};
}
