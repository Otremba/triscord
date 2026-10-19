#include "camera_segmenter.h"
#include <onnxruntime_c_api.h>
#include <windows.h>
#include <QFile>
#include <QFileInfo>
#include <QCryptographicHash>
#include <algorithm>
#include <bit>
#include <cmath>
#include <stdexcept>
#include <vector>
namespace triscord {
struct CameraSegmenter::State {
    HMODULE module = nullptr;
    const OrtApi* api = nullptr;
    OrtEnv* env = nullptr;
    OrtSessionOptions* options = nullptr;
    OrtSession* session = nullptr;
    OrtMemoryInfo* memory = nullptr;
    OrtValue* inputValue = nullptr;
    OrtValue* outputValue = nullptr;
    std::vector<float> input = std::vector<float>(256*144*3);
    std::vector<float> output = std::vector<float>(256*144);
    std::string outputName;
    ~State() {
        if (api) {
            api->ReleaseValue(inputValue); api->ReleaseValue(outputValue);
            api->ReleaseSession(session); api->ReleaseSessionOptions(options);
            api->ReleaseMemoryInfo(memory); api->ReleaseEnv(env);
        }
        if (module) FreeLibrary(module);
    }
    void check(OrtStatus* status) {
        if (!status) return;
        const std::string message(api->GetErrorMessage(status)); api->ReleaseStatus(status);
        throw std::runtime_error(message);
    }
};
CameraSegmenter::CameraSegmenter(const QString& runtimePath, const QString& modelPath) : state_(std::make_unique<State>()) {
    if (!QFileInfo(runtimePath).isAbsolute() || !QFileInfo(modelPath).isAbsolute()) throw std::invalid_argument("Effect paths must be absolute");
    QFile file(modelPath);
    if (!file.open(QIODevice::ReadOnly) || file.size() != 441922) throw std::runtime_error("Camera model is unavailable");
    const auto bytes = file.readAll();
    if (QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex() != "fc319dd58d764b242e8c13e53ac8be3e210769b0a02f458bff6e55540358e1e3")
        throw std::runtime_error("Camera model integrity mismatch");
    auto& s = *state_;
    s.module = LoadLibraryExW(reinterpret_cast<LPCWSTR>(runtimePath.utf16()),nullptr,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
    if (!s.module) throw std::runtime_error("Camera inference runtime is unavailable");
    using GetBase = const OrtApiBase* (ORT_API_CALL*)();
    const auto getBase = std::bit_cast<GetBase>(GetProcAddress(s.module,"OrtGetApiBase"));
    if (!getBase || !(s.api = getBase()->GetApi(ORT_API_VERSION))) throw std::runtime_error("Unsupported camera inference runtime");
    s.check(s.api->CreateEnv(ORT_LOGGING_LEVEL_FATAL,"triscord",&s.env));
    s.check(s.api->DisableTelemetryEvents(s.env));
    s.check(s.api->CreateSessionOptions(&s.options));
    s.check(s.api->SetIntraOpNumThreads(s.options,1)); s.check(s.api->SetInterOpNumThreads(s.options,1));
    s.check(s.api->SetSessionExecutionMode(s.options,ORT_SEQUENTIAL));
    s.check(s.api->AddSessionConfigEntry(s.options,"session.intra_op.allow_spinning","0"));
    s.check(s.api->AddSessionConfigEntry(s.options,"session.inter_op.allow_spinning","0"));
    s.check(s.api->CreateSessionFromArray(s.env,bytes.constData(),bytes.size(),s.options,&s.session));
    OrtAllocator* allocator = nullptr; s.check(s.api->GetAllocatorWithDefaultOptions(&allocator));
    char* name = nullptr; s.check(s.api->SessionGetOutputName(s.session,0,allocator,&name));
    try { s.outputName = name; } catch (...) { allocator->Free(allocator,name); throw; }
    allocator->Free(allocator,name);
    s.check(s.api->CreateCpuMemoryInfo(OrtArenaAllocator,OrtMemTypeDefault,&s.memory));
    const int64_t inShape[]{1,144,256,3}, outShape[]{1,144,256,1};
    s.check(s.api->CreateTensorWithDataAsOrtValue(s.memory,s.input.data(),s.input.size()*sizeof(float),inShape,4,ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&s.inputValue));
    s.check(s.api->CreateTensorWithDataAsOrtValue(s.memory,s.output.data(),s.output.size()*sizeof(float),outShape,4,ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT,&s.outputValue));
}
CameraSegmenter::~CameraSegmenter() = default;
std::span<const float> CameraSegmenter::segment(const QImage& image) {
    if (image.isNull() || image.width() > 4096 || image.height() > 2160) throw std::invalid_argument("Invalid camera image extent");
    const auto rgb = image.convertToFormat(QImage::Format_RGB888);
    if (rgb.isNull()) throw std::runtime_error("Camera RGB conversion failed");
    auto& s = *state_;
    // RGB, float 0..1; stretch to model size, bilinear pixel-center sampling.
    for (int y = 0; y < 144; ++y) {
        const float sy = std::max(0.0f,(y+0.5f)*rgb.height()/144.0f-0.5f);
        const int y0 = std::min(int(sy),rgb.height()-1), y1 = std::min(y0+1,rgb.height()-1);
        const float fy = sy-y0;
        for (int x = 0; x < 256; ++x) {
            const float sx = std::max(0.0f,(x+0.5f)*rgb.width()/256.0f-0.5f);
            const int x0 = std::min(int(sx),rgb.width()-1), x1 = std::min(x0+1,rgb.width()-1);
            const float fx = sx-x0;
            for (int c = 0; c < 3; ++c) {
                const float top = rgb.constScanLine(y0)[x0*3+c]*(1-fx)+rgb.constScanLine(y0)[x1*3+c]*fx;
                const float bottom = rgb.constScanLine(y1)[x0*3+c]*(1-fx)+rgb.constScanLine(y1)[x1*3+c]*fx;
                s.input[(y*256+x)*3+c] = (top*(1-fy)+bottom*fy)/255.0f;
            }
        }
    }
    const char* inputs[]{"t0"}; const char* outputs[]{s.outputName.c_str()}; const OrtValue* inputValues[]{s.inputValue};
    s.check(s.api->Run(s.session,nullptr,inputs,inputValues,1,outputs,1,&s.outputValue));
    for (const auto value : s.output) if (!std::isfinite(value) || value < 0 || value > 1) throw std::runtime_error("Invalid camera segmentation probability");
    return s.output;
}
}
