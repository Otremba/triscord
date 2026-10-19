#include "camera_capture.h"
#include <QCamera>
#include <QMediaCaptureSession>
#include <QMediaDevices>
#include <QVideoSink>
#include <QSignalBlocker>
#include <algorithm>
#include <limits>
namespace triscord {
CameraCapture::CameraCapture(QObject* parent) : QObject(parent) {
    delivery_.setParent(this); startup_.setParent(this);
    delivery_.setInterval(33);
    connect(&delivery_, &QTimer::timeout, this, [this] {
        if (auto frame = frames_->take()) { startup_.start(); emit frameReady(*frame); }
    });
    startup_.setSingleShot(true); startup_.setInterval(5000);
    connect(&startup_, &QTimer::timeout, this, [this] { fail("a câmera parou de enviar imagem. confira o dispositivo e as permissões do windows."); });
}
CameraCapture::~CameraCapture() { QSignalBlocker blocker(this); stop(); }
QList<QCameraDevice> CameraCapture::devices() { return QMediaDevices::videoInputs(); }
void CameraCapture::fail(const QString& text) { stop(); emit message(text); }
void CameraCapture::start(const QByteArray& deviceId, const std::function<bool()>& wanted, QSize requestedSize, int fps) {
    stop();
    fps = std::clamp(fps, 1, 60);
    delivery_.setTimerType(Qt::PreciseTimer);
    delivery_.setInterval(std::max(1, 1000 / (fps * 2)));
    if (wanted && !wanted()) return;
    const auto available = devices();
    if (wanted && !wanted()) return;
    auto found = std::find_if(available.begin(), available.end(), [&](const QCameraDevice& device) {
        return deviceId.isEmpty() ? device.isDefault() : device.id() == deviceId;
    });
    if (deviceId.isEmpty() && found == available.end()) found = available.begin();
    if (found == available.end()) { emit message("câmera indisponível. escolha um dispositivo conectado."); return; }
    if (!devices_) {
        devices_ = std::make_unique<QMediaDevices>();
        connect(devices_.get(), &QMediaDevices::videoInputsChanged, this, [this] {
            if (!camera_) return;
            const auto available = devices();
            if (std::none_of(available.begin(), available.end(), [this](const QCameraDevice& d) { return d.id() == selected_; }))
                fail("a câmera foi desconectada. escolha novamente o dispositivo.");
        });
    }
    selected_ = found->id(); const auto generation = generation_;
    session_ = std::make_unique<QMediaCaptureSession>();
    camera_ = std::make_unique<QCamera>(*found); sink_ = std::make_unique<QVideoSink>();
    // Select a real device format for the requested share preset, not a fixed 720p/30 source.
    QCameraFormat format; qint64 best = std::numeric_limits<qint64>::max();
    for (const auto& candidate : found->videoFormats()) {
        const auto size = candidate.resolution();
        if (size.isEmpty() || size.width() > 4096 || size.height() > 2160 || candidate.maxFrameRate() <= 0) continue;
        const qint64 pixels = qint64(size.width()) * size.height();
        const qint64 score = std::abs(pixels - qint64(requestedSize.width()) * requestedSize.height())
            + qint64(std::abs(candidate.maxFrameRate() - fps) * 1000000)
            + (candidate.maxFrameRate() < fps ? 100000000 : 0);
        if (score < best) { best = score; format = candidate; }
    }
    if (!format.isNull()) camera_->setCameraFormat(format);
    connect(sink_.get(), &QVideoSink::videoFrameChanged, sink_.get(), [frames = frames_, generation](const QVideoFrame& frame) {
        frames->publish(generation, frame);
    }, Qt::DirectConnection);
    connect(camera_.get(), &QCamera::activeChanged, this, [this, generation](bool active) {
        if (generation != generation_ || active_ == active) return;
        if (!active) { fail("a câmera foi interrompida. ligue-a novamente para retomar o vídeo."); return; }
        active_ = true; emit activeChanged(true);
    }, Qt::QueuedConnection);
    connect(camera_.get(), &QCamera::errorOccurred, this, [this, generation](QCamera::Error error, const QString&) {
        if (generation == generation_ && error != QCamera::NoError)
            fail("não foi possível abrir a câmera. confira se outro aplicativo está usando e as permissões do windows.");
    }, Qt::QueuedConnection);
    session_->setCamera(camera_.get()); session_->setVideoSink(sink_.get());
    if (wanted && !wanted()) { stop(); return; }
    delivery_.start(); startup_.start(); camera_->start();
}
void CameraCapture::stop() {
    frames_->select(++generation_); delivery_.stop(); startup_.stop();
    if (camera_) { disconnect(camera_.get(), nullptr, this, nullptr); camera_->stop(); }
    if (session_) { session_->setCamera(nullptr); session_->setVideoSink(nullptr); }
    sink_.reset(); camera_.reset(); session_.reset(); selected_.clear();
    if (active_) { active_ = false; emit activeChanged(false); }
}
}
