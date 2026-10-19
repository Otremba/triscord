#pragma once
#include <QThread>
#include <windows.h>
#include <objbase.h>

namespace triscord {
// Qt Multimedia 6.8 puts a thread that opens an audio device into a single-threaded COM apartment for the rest of its
// life. Media Foundation and Windows capture here then asked for the multithreaded one and failed with
// RPC_E_CHANGED_MODE (0x80010106): on 19/10 no stream was decoded and no screen could be captured once the media
// thread had played audio. A media thread joins the multithreaded apartment as it starts, so Qt reuses it. It keeps it
// until it exits: objects deleted after QThread::finished may still hold COM pointers.
inline void joinMultithreadedApartment(QThread& thread) {
    QObject::connect(&thread, &QThread::started, [] { CoInitializeEx(nullptr, COINIT_MULTITHREADED); });
}

// The calls that need COM on the current thread: an apartment the thread already has (RPC_E_CHANGED_MODE) is used as
// it is instead of failing; only an initialization that succeeded is undone.
inline HRESULT enterComApartment(bool& entered) {
    const auto hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    entered = SUCCEEDED(hr);
    return hr == RPC_E_CHANGED_MODE ? S_OK : hr;
}
}
