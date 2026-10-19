#pragma once
#include <QImage>
#include <QString>
#include <memory>
#include <span>
namespace triscord {
// Worker-owned, synchronous inference. Construct only when enabling an effect.
// The returned mask remains valid until the next inference / destruction.
class CameraSegmenter final {
public:
    CameraSegmenter(const QString& runtimePath, const QString& modelPath);
    ~CameraSegmenter();
    std::span<const float> segment(const QImage& image);
    static constexpr int maskWidth = 256, maskHeight = 144;
private:
    struct State;
    std::unique_ptr<State> state_;
};
}
