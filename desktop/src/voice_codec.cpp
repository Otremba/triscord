#include "voice_codec.h"
#include <stdexcept>

namespace triscord {
VoiceEncoder::VoiceEncoder(bool music) {
    int error = 0;
    encoder_.reset(opus_encoder_create(VoiceRate, 1, music ? OPUS_APPLICATION_AUDIO : OPUS_APPLICATION_VOIP, &error));
    if (!encoder_ || error != OPUS_OK) throw std::runtime_error("Opus encoder unavailable");
    opus_encoder_ctl(encoder_.get(), OPUS_SET_BITRATE(music ? 64000 : 32000));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_VBR(1));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_COMPLEXITY(5));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_PACKET_LOSS_PERC(5));
    opus_encoder_ctl(encoder_.get(), OPUS_SET_DTX(music ? 0 : 1));
}
QByteArray VoiceEncoder::encode(const VoiceFrame& pcm) {
    QByteArray packet(1275, Qt::Uninitialized);
    const int bytes = opus_encode_float(encoder_.get(), pcm.data(), VoiceSamples,
        reinterpret_cast<unsigned char*>(packet.data()), packet.size());
    if (bytes < 0) throw std::runtime_error("Opus encoding failed");
    packet.resize(bytes);
    return packet;
}
VoiceDecoder::VoiceDecoder() {
    int error = 0;
    decoder_.reset(opus_decoder_create(VoiceRate, 1, &error));
    if (!decoder_ || error != OPUS_OK) throw std::runtime_error("Opus decoder unavailable");
}
VoiceFrame VoiceDecoder::decode(const QByteArray& packet, bool recoverPrevious) {
    VoiceFrame pcm{};
    const int samples = opus_decode_float(decoder_.get(),
        packet.isEmpty() ? nullptr : reinterpret_cast<const unsigned char*>(packet.constData()),
        packet.size(), pcm.data(), VoiceSamples, recoverPrevious ? 1 : 0);
    if (samples < 0) throw std::runtime_error("Invalid Opus frame");
    return pcm;
}
}
