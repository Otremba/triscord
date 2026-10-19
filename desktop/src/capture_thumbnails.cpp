#include "capture_thumbnails.h"
#include <cstdio>
namespace triscord {
CaptureThumbnails::CaptureThumbnails(QObject* parent) : QObject(parent) {
    timer_.setParent(this); timer_.setInterval(25);
    connect(&timer_, &QTimer::timeout, this, &CaptureThumbnails::tick);
}
void CaptureThumbnails::request(QVector<CaptureSource> sources, quint64 generation) {
    cancel(); sources_ = std::move(sources); sources_.resize(qMin(qsizetype(48), sources_.size()));
    generation_ = generation; timer_.start();
}
void CaptureThumbnails::cancel() { timer_.stop(); capture_.reset(); sources_.clear(); index_ = 0; }
void CaptureThumbnails::tick() {
    if (index_ >= sources_.size()) { cancel(); return; }
    try {
        if (!capture_) { capture_ = std::make_unique<NativeCapture>(sources_[index_], 5); age_.start(); return; }
        if (auto preview = capture_->next()) {
            emit ready(generation_, index_, preview->image.scaled(160, 90, Qt::KeepAspectRatio, Qt::FastTransformation));
            capture_.reset(); ++index_;
        } else if (age_.elapsed() > 300) {
            // No WGC frame in time: one GDI frame instead of a black thumbnail (18/10, a friend's PC).
            if (!capture_->usingGdi()) { capture_ = std::make_unique<NativeCapture>(sources_[index_], 5, NativeCapture::Backend::GdiOnly); age_.start(); }
            else { capture_.reset(); ++index_; }
        }
    } catch (const std::exception& error) {
        std::printf("capture: thumbnail %d failed: %s\n", int(index_), error.what()); std::fflush(stdout);
        if (capture_ && !capture_->usingGdi()) {
            try { capture_ = std::make_unique<NativeCapture>(sources_[index_], 5, NativeCapture::Backend::GdiOnly); age_.start(); return; }
            catch (const std::exception&) {}
        }
        capture_.reset(); ++index_;
    }
}
}
