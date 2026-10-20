#pragma once
#include <QAudioFormat>

namespace triscord {
inline QAudioFormat soundPcmFormat() {
    QAudioFormat format;
    format.setSampleRate(48000);
    format.setChannelConfig(QAudioFormat::ChannelConfigStereo);
    format.setSampleFormat(QAudioFormat::Float);
    return format;
}
// Querying support is separate from device access so format negotiation can be tested without speakers.
template<class Supports>
QAudioFormat soundOutputFormat(QAudioFormat preferred, Supports supports) {
    auto format = soundPcmFormat();
    if (supports(format)) return format;
    format.setSampleFormat(QAudioFormat::Int16);
    if (supports(format)) return format;
    if (!preferred.isValid() || preferred.sampleRate() < 8000 || preferred.sampleRate() > 192000
        || preferred.channelCount() < 1 || preferred.channelCount() > 8) return {};
    // FFmpeg needs an explicit channel layout even when the Windows device reports an unspecified mask.
    if (preferred.channelConfig() == QAudioFormat::ChannelConfigUnknown)
        preferred.setChannelConfig(QAudioFormat::defaultChannelConfigForChannelCount(preferred.channelCount()));
    return supports(preferred) ? preferred : QAudioFormat{};
}
}
