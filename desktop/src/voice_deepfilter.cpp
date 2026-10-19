#include "voice_deepfilter.h"
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <algorithm>
#include <string>
#include <QCryptographicHash>
#include <QFile>
#include <QDebug>

namespace triscord {
namespace {
struct DfState;
// libDF's C API (libDF/src/capi.rs). It panics, which aborts the process, on a missing model: checked first.
struct DeepFilterApi {
    DfState* (*create)(const char* modelPath, float attenuationLimitDb, const char* logLevel) = nullptr;
    size_t (*frameLength)(DfState*) = nullptr;
    float (*process)(DfState*, float* input, float* output) = nullptr;
    void (*destroy)(DfState*) = nullptr;
    std::string model;
};
std::wstring deepFilterDirectory() {
    std::wstring path(MAX_PATH, L'\0');
    for (;;) {
        const DWORD size = GetModuleFileNameW(nullptr, path.data(), DWORD(path.size()));
        if (size == 0) return {};
        if (size < path.size()) { path.resize(size); break; }
        path.resize(path.size() * 2);
    }
    return path.substr(0, path.find_last_of(L"\\/") + 1) + L"deepfilter\\";
}
std::string utf8(const std::wstring& text) {
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), int(text.size()), nullptr, 0, nullptr, nullptr);
    std::string result(size_t(std::max(size, 0)), '\0');
    if (size > 0) WideCharToMultiByte(CP_UTF8, 0, text.c_str(), int(text.size()), result.data(), size, nullptr, nullptr);
    return result;
}
bool validModel(const std::wstring& path) {
    // libDF's C entry point aborts on unreadable/corrupt archives. Only pass the pinned model to Rust.
    QFile file(QString::fromStdWString(path));
    QCryptographicHash hash(QCryptographicHash::Sha256);
    return file.open(QIODevice::ReadOnly) && hash.addData(&file)
        && hash.result().toHex() == "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616";
}
// Loaded once and never unloaded (states may outlive any one VoiceProcessor).
const DeepFilterApi* api() {
    static const DeepFilterApi* loaded = [] () -> const DeepFilterApi* {
        const auto directory = deepFilterDirectory();
        const auto model = directory + L"DeepFilterNet3_onnx.tar.gz";
        if (directory.empty() || GetFileAttributesW(model.c_str()) == INVALID_FILE_ATTRIBUTES) return nullptr;
        HMODULE library = LoadLibraryExW((directory + L"df.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        if (!library) return nullptr;
        static DeepFilterApi functions;
        functions.create = reinterpret_cast<decltype(functions.create)>(reinterpret_cast<void*>(GetProcAddress(library, "df_create")));
        functions.frameLength = reinterpret_cast<decltype(functions.frameLength)>(reinterpret_cast<void*>(GetProcAddress(library, "df_get_frame_length")));
        functions.process = reinterpret_cast<decltype(functions.process)>(reinterpret_cast<void*>(GetProcAddress(library, "df_process_frame")));
        functions.destroy = reinterpret_cast<decltype(functions.destroy)>(reinterpret_cast<void*>(GetProcAddress(library, "df_free")));
        functions.model = utf8(model);
        if (!functions.create || !functions.frameLength || !functions.process || !functions.destroy || functions.model.empty()) return nullptr;
        return &functions;
    }();
    return loaded;
}
}
bool DeepFilter::available() {
    const auto directory = deepFilterDirectory();
    return !directory.empty() && GetFileAttributesW((directory + L"df.dll").c_str()) != INVALID_FILE_ATTRIBUTES
        && GetFileAttributesW((directory + L"DeepFilterNet3_onnx.tar.gz").c_str()) != INVALID_FILE_ATTRIBUTES;
}
std::unique_ptr<DeepFilter> DeepFilter::create() {
    const auto directory = deepFilterDirectory();
    if (directory.empty() || !validModel(directory + L"DeepFilterNet3_onnx.tar.gz")) {
        qWarning("voice: DeepFilterNet model missing, unreadable or damaged; keeping RNNoise");
        return nullptr;
    }
    const auto* functions = api();
    if (!functions) return nullptr;
    // 100 dB: no attenuation limit, noise between words is removed entirely (the voice gate follows anyway).
    DfState* state = functions->create(functions->model.c_str(), 100.f, nullptr);
    if (!state) return nullptr;
    if (functions->frameLength(state) != size_t(kBlock)) { functions->destroy(state); return nullptr; }
    std::unique_ptr<DeepFilter> filter(new DeepFilter);
    filter->state_ = state;
    return filter;
}
DeepFilter::~DeepFilter() { if (state_) api()->destroy(static_cast<DfState*>(state_)); }
void DeepFilter::process(const std::array<float, kBlock>& input, float* output) {
    std::array<float, kBlock> copy = input;   // the C API takes a mutable pointer
    api()->process(static_cast<DfState*>(state_), copy.data(), output);
}
}
