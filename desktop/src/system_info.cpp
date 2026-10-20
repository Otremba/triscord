#include "system_info.h"
#include <windows.h>
#include <dxgi.h>
#include <wrl/client.h>
#include <QGuiApplication>
#include <QScreen>
#include <QString>
#include <QStringList>
#include <cstdio>

namespace triscord {
namespace {
QString registryText(const wchar_t* key, const wchar_t* name) {
    wchar_t buffer[256]; DWORD size = sizeof buffer;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, key, name, RRF_RT_REG_SZ, nullptr, buffer, &size) != ERROR_SUCCESS) return {};
    return QString::fromWCharArray(buffer).simplified();
}
DWORD registryNumber(const wchar_t* key, const wchar_t* name) {
    DWORD value = 0, size = sizeof value;
    return RegGetValueW(HKEY_LOCAL_MACHINE, key, name, RRF_RT_REG_DWORD, nullptr, &value, &size) == ERROR_SUCCESS ? value : 0;
}
}

void logSystemInfo() {
    // RtlGetVersion: GetVersionEx reports 6.2 to an executable without a compatibility manifest.
    OSVERSIONINFOW os{}; os.dwOSVersionInfoSize = sizeof os;
    using GetVersion = LONG(WINAPI*)(OSVERSIONINFOW*);
    if (const auto get = reinterpret_cast<GetVersion>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion")))) get(&os);
    const wchar_t* current = L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";
    MEMORYSTATUSEX memory{}; memory.dwLength = sizeof memory; GlobalMemoryStatusEx(&memory);
    std::printf("system: Windows %s %s (build %lu.%lu), %s, %lu threads, %.0f GB RAM\n", os.dwBuildNumber >= 22000 ? "11" : "10",
                qPrintable(registryText(current, L"DisplayVersion")), os.dwBuildNumber, registryNumber(current, L"UBR"),
                qPrintable(registryText(L"HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0", L"ProcessorNameString")),
                GetActiveProcessorCount(ALL_PROCESSOR_GROUPS), memory.ullTotalPhys / 1073741824.0);

    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) {
        Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
        QStringList seen;   // DXGI can list one GPU twice
        for (UINT n = 0; factory->EnumAdapters1(n, &adapter) != DXGI_ERROR_NOT_FOUND; ++n, adapter.Reset()) {
            DXGI_ADAPTER_DESC1 desc{};
            // The Microsoft Basic Render Driver is on every PC and never used here.
            if (FAILED(adapter->GetDesc1(&desc)) || (desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE)) continue;
            LARGE_INTEGER umd{};
            const auto driver = SUCCEEDED(adapter->CheckInterfaceSupport(__uuidof(IDXGIDevice), &umd))
                ? QStringLiteral("%1.%2.%3.%4").arg(HIWORD(umd.HighPart)).arg(LOWORD(umd.HighPart)).arg(HIWORD(umd.LowPart)).arg(LOWORD(umd.LowPart))
                : QStringLiteral("unknown");
            UINT outputs = 0;
            for (Microsoft::WRL::ComPtr<IDXGIOutput> output; adapter->EnumOutputs(outputs, &output) != DXGI_ERROR_NOT_FOUND; output.Reset()) ++outputs;
            const auto line = QStringLiteral("%1, %2 MB, driver %3").arg(QString::fromWCharArray(desc.Description).simplified())
                .arg(desc.DedicatedVideoMemory / 1048576).arg(driver);
            if (seen.contains(line)) continue;
            seen << line;
            std::printf("gpu: %s, %u monitor(s)\n", qPrintable(line), outputs);
        }
    }
    for (const auto* screen : QGuiApplication::screens()) {
        const auto size = screen->size() * screen->devicePixelRatio();
        std::printf("display: %dx%d at %.0f Hz, scale %.0f%%%s\n", size.width(), size.height(), screen->refreshRate(),
                    screen->devicePixelRatio() * 100, screen == QGuiApplication::primaryScreen() ? ", primary" : "");
    }
    std::fflush(stdout);
}
}
