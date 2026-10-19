#pragma once
#include <QByteArray>
#include <QMetaType>
#include <array>
#include <memory>
#include <opus.h>

namespace triscord {
inline constexpr int VoiceRate = 48000;
inline constexpr int VoiceSamples = 960; // 20 ms, mono
using VoiceFrame = std::array<float, VoiceSamples>;
class VoiceEncoder {
public:
    explicit VoiceEncoder(bool music = false);
    QByteArray encode(const VoiceFrame& pcm);
private:
    std::unique_ptr<OpusEncoder, decltype(&opus_encoder_destroy)> encoder_{nullptr, opus_encoder_destroy};
};
class VoiceDecoder {
public:
    VoiceDecoder();
    VoiceFrame decode(const QByteArray& packet, bool recoverPrevious = false);
private:
    std::unique_ptr<OpusDecoder, decltype(&opus_decoder_destroy)> decoder_{nullptr, opus_decoder_destroy};
};
}
Q_DECLARE_METATYPE(triscord::VoiceFrame)
