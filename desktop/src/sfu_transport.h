#pragma once
#include <QObject>
#include <QProcess>
#include <QJsonObject>
#include <QTimer>
#include <QSet>
#include <QHash>

namespace triscord {
// Encoded H.264/Opus only. Capture, DSP, codecs and playback stay in the native media workers.
class SfuTransport final : public QObject {
    Q_OBJECT
public:
    explicit SfuTransport(QString kind, QObject* parent = nullptr);
    ~SfuTransport() override;
    static bool available();
    bool selected() const { return selected_; }
    void open(const QJsonObject& credentials);
    void close();
    void publish(int width = 0, int height = 0, int fps = 0, int bitrate = 0);
    void unpublish();
    void send(const QString& kind, const QByteArray& data, qint64 durationUs, quint32 timestamp = 0);
    void watch(const QString& peer, bool enabled);
    void requestKeyframe(const QString& peer);
signals:
    void audioReset(const QString& peer);
    void audio(const QString& peer, const QByteArray& opus, quint32 timestamp);
    void video(const QString& peer, const QByteArray& h264, quint32 timestamp, bool key, const QJsonObject& config);
    void keyframeRequested();
    void bitrateRequested(int bitrate);
    void credentialsNeeded();
    void message(const QString& message);
private:
    bool command(const QJsonObject& value, bool media = false);
    void read();
    void failed();
    QString kind_;
    QProcess process_;
    QTimer retry_;
    QByteArray input_;
    QJsonObject publication_;
    QMetaObject::Connection startup_;
    QSet<QString> disabled_;
    QHash<QString, QString> audioTracks_;
    bool selected_ = false, connected_ = false;
};
}
