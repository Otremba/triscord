#pragma once
#include "voice_codec.h"
#include <QObject>
#include <QJsonObject>
#include <QString>
#include <QMutex>
#include <rtc/rtc.hpp>
#include <deque>

namespace triscord {
// One native audio session. Device capture and UI stay outside this transport.
class VoicePeer final : public QObject {
    Q_OBJECT
public:
    VoicePeer(const rtc::Configuration& config, QObject* parent = nullptr);
    ~VoicePeer() override;
    void offer();
    void applyDescription(const QString& sdp, const QString& type);
    void addCandidate(const QString& candidate, const QString& mid);
    bool sendOpus(const QByteArray& packet);
    bool connected() const;
signals:
    void localDescription(const QString& sdp, const QString& type);
    void localCandidate(const QString& candidate, const QString& mid);
    void audioReceived(const QByteArray& opus, uint32_t timestamp);
    void connectionChanged(bool connected);
    void failed();
private:
    struct Dispatch : std::enable_shared_from_this<Dispatch> {
        QMutex mutex;
        VoicePeer* owner = nullptr;
        void post(std::function<void(VoicePeer*)> callback);
        void postAudio(QByteArray packet, uint32_t timestamp);
        std::deque<std::pair<QByteArray, uint32_t>> audio;
        bool audioScheduled = false;
    };
    std::shared_ptr<Dispatch> dispatch_;
    std::shared_ptr<rtc::PeerConnection> pc_;
    std::shared_ptr<rtc::Track> audio_;
    uint32_t timestamp_ = 0;
};
}
