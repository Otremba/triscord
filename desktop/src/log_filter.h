#pragma once
#include <cctype>
#include <string>

namespace triscord {
// The log a user sends (web_main.cpp). FFmpeg prints a block for every call sound and soundboard clip it decodes
// ("Input #0, mp3, from ..." plus indented details) and "[mp3float @ 000001d86b9869c0] ..." warnings; on 19/10 they
// filled most of a friend's log and cut other lines in half. They never explain a call problem, so they are left out.
// `ffmpegBlock` carries the state between lines: the indented lines after an "Input #" header belong to it.
inline bool dropLogLine(const std::string& line, bool& ffmpegBlock) {
    if (line.rfind("Input #", 0) == 0) { ffmpegBlock = true; return true; }
    if (ffmpegBlock && line.rfind("  ", 0) == 0) return true;
    ffmpegBlock = false;
    // FFmpeg's own prefix: a codec or format name, " @ " and the context's address, then "] ".
    if (line.size() > 4 && line[0] == '[') {
        const auto at = line.find(" @ ");
        const auto close = line.find("] ");
        if (at != std::string::npos && close != std::string::npos && at > 1 && at < close) {
            bool name = true;
            for (size_t n = 1; n < at && name; ++n) name = std::isalnum(static_cast<unsigned char>(line[n])) || line[n] == '_';
            if (name) return true;
        }
    }
    return false;
}
} // namespace triscord
