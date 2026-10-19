#include "capture_service.h"
#include <windows.h>

namespace triscord {
CaptureWorker::CaptureWorker(QObject* parent) : QObject(parent) {
    timer_.setParent(this); timer_.setTimerType(Qt::PreciseTimer); timer_.setInterval(66);
    connect(&timer_, &QTimer::timeout, this, &CaptureWorker::tick);
}
void CaptureWorker::start(const CaptureSource& source, quint64 generation) {
    stop(generation);
    source_ = source;
    try {
        capture_ = std::make_unique<NativeCapture>(source);
        timer_.start(); emit activeChanged(true, generation_);
    } catch (const std::exception&) {
        emit message("Não foi possível capturar esta fonte. Escolha outra janela ou confira as permissões do Windows.", generation_);
    }
}
void CaptureWorker::stop(quint64 generation) {
    generation_ = generation; timer_.stop(); capture_.reset(); paused_ = false;
    emit pausedChanged(false, generation_); emit activeChanged(false, generation_);
}
void CaptureWorker::tick() {
    if (!capture_) return;
    bool unavailable = false, paused = false;
    if (source_.kind == CaptureSource::Kind::Window) {
        auto window = reinterpret_cast<HWND>(source_.handle);
        DWORD process = 0; GetWindowThreadProcessId(window, &process);
        unavailable = !IsWindow(window) || !IsWindowVisible(window) || process != source_.processId;
        paused = IsIconic(window);
    } else {
        MONITORINFO info{}; info.cbSize = sizeof(info);
        unavailable = !GetMonitorInfoW(reinterpret_cast<HMONITOR>(source_.handle), &info);
    }
    if (unavailable) { stop(generation_); emit message("A fonte foi fechada ou desconectada. Escolha outra para continuar.", generation_); return; }
    if (paused_ != paused) { paused_ = paused; emit pausedChanged(paused, generation_); }
    if (paused) return;
    try {
        if (auto preview = capture_->next()) { preview->generation = generation_; emit frame(*preview); }
    } catch (const std::exception&) {
        stop(generation_); emit message("A captura foi interrompida. Escolha novamente a janela ou o monitor.", generation_);
    }
}
CaptureService::CaptureService(QObject* parent) : QObject(parent), worker_(new CaptureWorker), mailbox_(std::make_shared<PreviewMailbox>()) {
    qRegisterMetaType<CaptureSource>(); qRegisterMetaType<CapturePreview>();
    worker_->moveToThread(&thread_);
    connect(worker_, &CaptureWorker::frame, worker_, [this, mailbox = mailbox_](const CapturePreview& preview) {
        if (!mailbox->publish(preview)) return;
        QMetaObject::invokeMethod(this, [this, mailbox] {
            if (auto latest = mailbox->take(); latest && latest->generation == generation_) emit previewReady(*latest);
        }, Qt::QueuedConnection);
    });
    connect(worker_, &CaptureWorker::activeChanged, this, [this](bool active, quint64 generation) {
        if (generation == generation_) emit activeChanged(active);
    });
    connect(worker_, &CaptureWorker::pausedChanged, this, [this](bool paused, quint64 generation) {
        if (generation == generation_) emit pausedChanged(paused);
    });
    connect(worker_, &CaptureWorker::message, this, [this](const QString& message, quint64 generation) {
        if (generation == generation_) emit this->message(message);
    });
    connect(&thread_, &QThread::finished, worker_, &QObject::deleteLater);
    thread_.setObjectName("TriscordCapture"); thread_.start();
}
CaptureService::~CaptureService() {
    QMetaObject::invokeMethod(worker_, [worker = worker_, generation = generation_] { worker->stop(generation); }, Qt::BlockingQueuedConnection);
    thread_.quit(); thread_.wait();
}
void CaptureService::start(const CaptureSource& source) {
    const auto generation = ++generation_; mailbox_->select(generation);
    QMetaObject::invokeMethod(worker_, [worker = worker_, source, generation] { worker->start(source, generation); });
}
void CaptureService::stop() {
    const auto generation = ++generation_; mailbox_->select(generation);
    QMetaObject::invokeMethod(worker_, [worker = worker_, generation] { worker->stop(generation); });
}
}
