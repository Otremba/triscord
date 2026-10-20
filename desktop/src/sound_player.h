#pragma once
#include <QObject>
#include <QJsonArray>
#include <QByteArray>
#include <QTimer>
#include <map>
#include <memory>
class QMediaPlayer;
namespace triscord {
class SoundOutput;
// Widget-free playback of the bundled, hash-verified sound catalog. No network.
class SoundPlayer final : public QObject {
    Q_OBJECT
public:
    explicit SoundPlayer(QObject* parent = nullptr);
    ~SoundPlayer() override;
    static QJsonArray catalog();
    static bool contains(const QString& id);
    void play(const QString& id, bool preview);
    void stopPreview();
    void stop();
    void setOutput(const QByteArray& id);
    void setDeafened(bool muted);
    void playCue(const QString& id);
    void refreshSettings();
signals:
    void changed(const QString& id);
    void failed(const QString& reason);
    void decoded(const QString& kind, const QString& id, qint64 samples, double peak);
private:
    struct CuePlayback {
        QMediaPlayer* player = nullptr;
        SoundOutput* output = nullptr;
        QString id;
        quint64 generation = 0;
        bool active = false, decoded = false;
    };
    QMediaPlayer* createPlayer(SoundOutput*& output, CuePlayback* cue = nullptr);
    void configureAudioBuffers(QMediaPlayer* player, SoundOutput* output, CuePlayback* cue);
    QMediaPlayer* player_ = nullptr;
    SoundOutput* output_ = nullptr;
    // Heap-owned entries keep callback addresses stable as other cue IDs are inserted.
    // The validated cue allowlist bounds this lazy cache to eleven playback voices.
    std::map<QString, std::unique_ptr<CuePlayback>> cues_;
    bool boardDecoded_ = false;
    QTimer deadline_;
    QByteArray device_;
    QString playing_;
    bool deafened_ = false, preview_ = false;
};
}
