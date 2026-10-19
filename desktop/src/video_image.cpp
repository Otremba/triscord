#include "video_image.h"
#include <algorithm>
#include <vector>
#include <stdexcept>
namespace triscord {
QImage videoImage(const DecodedVideo& video, QSize limit) {
    const int width = video.size.width(), height = video.size.height();
    if (width < 2 || height < 2 || width > 1920 || height > 1080 || width % 2 || height % 2 ||
        video.nv12.size() != qsizetype(width) * height * 3 / 2 || limit.isEmpty())
        throw std::invalid_argument("Invalid NV12 image");
    const QSize output = video.size.scaled(limit.boundedTo(video.size), Qt::KeepAspectRatio);
    QImage image(output, QImage::Format_RGB32);
    if (image.isNull()) throw std::runtime_error("Video image allocation failed");
    std::vector<int> columns(size_t(output.width()));
    for (int x = 0; x < output.width(); ++x) columns[size_t(x)] = x * width / output.width();
    auto clamp = [](int value) { return std::clamp(value, 0, 255); };
    for (int row = 0; row < output.height(); ++row) {
        const int y = row * height / output.height();
        auto* pixels = reinterpret_cast<QRgb*>(image.scanLine(row));
        for (int x = 0; x < output.width(); ++x) {
            const int column = columns[size_t(x)];
            const int c = std::max(0, int(uint8_t(video.nv12[y * width + column])) - 16);
            const int uv = width * height + y / 2 * width + (column & ~1);
            const int d = int(uint8_t(video.nv12[uv])) - 128, e = int(uint8_t(video.nv12[uv + 1])) - 128;
            pixels[x] = qRgb(clamp((298 * c + 459 * e + 128) >> 8), clamp((298 * c - 55 * d - 136 * e + 128) >> 8), clamp((298 * c + 541 * d + 128) >> 8));
        }
    }
    return image;
}
}
