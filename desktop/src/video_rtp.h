#pragma once
#include <QByteArray>
#include <optional>
#include <map>
#include <chrono>
#include <set>
#include <vector>

namespace triscord {
constexpr qsizetype VideoFrameLimit = 2 * 1024 * 1024;
constexpr int VideoPacketLimit = 2048;
struct ReceivedVideo {
    QByteArray annexB;
    uint32_t timestamp = 0;
    bool keyframe = false;
};
// Single H264 access unit. Reordering/duplicates are accepted within that unit;
// gaps, malformed payloads and excessive input require a fresh SPS/PPS + IDR.
class VideoRtpAssembler final {
public:
    std::optional<ReceivedVideo> push(const QByteArray& rtp);
    bool takeRecoveryRequest();
private:
    void discard();
    std::optional<ReceivedVideo> assemble();
    std::map<uint16_t, QByteArray> packets_;
    qsizetype bytes_ = 0;
    std::optional<uint32_t> timestamp_, ssrc_;
    std::optional<uint16_t> marker_, expectedFirst_;
    bool dropping_ = false, waitingForIdr_ = true, recovery_ = false, completed_ = false;
    std::chrono::steady_clock::time_point started_;
};
// Hands RTP packets to the assembler in sequence order. Before it, any lost packet froze the picture until a new
// keyframe and cut the sender's bitrate (19/10: streams "sometimes bad" over a TURN relay). Now a gap is NACKed at
// once (the sender keeps its last 2048 packets, video_peer.cpp) and the packets behind it wait up to 150 ms for the
// retransmission; only then is the gap let through and the assembler asks for a keyframe as before.
class VideoRtpReorder final {
public:
    static constexpr int HoldMs = 150;
    struct Result { std::vector<QByteArray> ready; std::vector<uint16_t> nack; int lost = 0; };
    Result push(const QByteArray& rtp, std::chrono::steady_clock::time_point now);
    int recovered() const { return recovered_; }
private:
    void release(Result& result);
    std::map<int64_t, QByteArray> held_;   // extended sequence number -> packet
    std::set<int64_t> nacked_;
    int64_t next_ = 0;
    bool started_ = false;
    std::optional<std::chrono::steady_clock::time_point> blocked_;
    int recovered_ = 0;
};
// One RTCP Generic NACK (RFC 4585, PT 205 FMT 1) for `missing`, as libdatachannel's RtcpNackResponder reads it.
QByteArray rtcpNack(uint32_t mediaSsrc, const std::vector<uint16_t>& missing);
class VideoRtpClock final {
public:
    std::optional<qint64> accept(uint32_t timestamp);
private:
    std::optional<uint32_t> last_;
    uint64_t elapsed_ = 0;
};
}
