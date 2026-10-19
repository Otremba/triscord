#pragma once
#include <windows.h>
#include <inspectable.h>
#include <winstring.h>

// Narrow WinRT ABI declarations: the bundled MinGW SDK does not project these
// capture interfaces. GUIDs/method order match Microsoft's Windows SDK; no
// C++/WinRT runtime, dispatcher queue or custom COM implementation is required.
namespace triscord::wgc {
struct Size { INT32 width, height; };
struct Token { INT64 value; };
struct Time { INT64 duration; };
struct Session : IInspectable { virtual HRESULT STDMETHODCALLTYPE StartCapture() = 0; };
// IGraphicsCaptureSession3 (Windows 10 2104+ / 11): the yellow border Windows draws around what is captured.
struct SessionBorder : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_IsBorderRequired(boolean*) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_IsBorderRequired(boolean) = 0;
};
struct SessionRate : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_MinUpdateInterval(Time*) = 0;
    virtual HRESULT STDMETHODCALLTYPE put_MinUpdateInterval(Time) = 0;
};
struct Item : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_DisplayName(HSTRING*) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_Size(Size*) = 0;
    virtual HRESULT STDMETHODCALLTYPE add_Closed(IUnknown*, Token*) = 0;
    virtual HRESULT STDMETHODCALLTYPE remove_Closed(Token) = 0;
};
struct Frame : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE get_Surface(IInspectable**) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_SystemRelativeTime(Time*) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_ContentSize(Size*) = 0;
};
struct Pool : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE Recreate(IInspectable*, INT32, INT32, Size) = 0;
    virtual HRESULT STDMETHODCALLTYPE TryGetNextFrame(Frame**) = 0;
    virtual HRESULT STDMETHODCALLTYPE add_FrameArrived(IUnknown*, Token*) = 0;
    virtual HRESULT STDMETHODCALLTYPE remove_FrameArrived(Token) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateCaptureSession(Item*, Session**) = 0;
    virtual HRESULT STDMETHODCALLTYPE get_DispatcherQueue(IInspectable**) = 0;
};
struct PoolFactory : IInspectable {
    virtual HRESULT STDMETHODCALLTYPE CreateFreeThreaded(IInspectable*, INT32, INT32, Size, Pool**) = 0;
};
struct ItemInterop : IUnknown {
    virtual HRESULT STDMETHODCALLTYPE CreateForWindow(HWND, REFIID, void**) = 0;
    virtual HRESULT STDMETHODCALLTYPE CreateForMonitor(HMONITOR, REFIID, void**) = 0;
};
struct SurfaceAccess : IUnknown { virtual HRESULT STDMETHODCALLTYPE GetInterface(REFIID, void**) = 0; };
struct Closable : IInspectable { virtual HRESULT STDMETHODCALLTYPE Close() = 0; };
inline constexpr GUID ItemId{0x79c3f95b,0x31f7,0x4ec2,{0xa4,0x64,0x63,0x2e,0xf5,0xd3,0x07,0x60}};
inline constexpr GUID DeviceId{0xa37624ab,0x8d5f,0x4650,{0x9d,0x3e,0x9e,0xae,0x3d,0x9b,0xc6,0x70}};
inline constexpr GUID SessionBorderId{0xf2cdd966,0x22ae,0x5ea1,{0x95,0x96,0x3a,0x28,0x93,0x44,0xc3,0xbe}};
inline constexpr GUID SessionRateId{0x67c0ea62,0x1f85,0x5061,{0x92,0x5a,0x23,0x9b,0xe0,0xac,0x09,0xcb}};
inline constexpr GUID InteropId{0x3628e81b,0x3cac,0x4c60,{0xb7,0xf4,0x23,0xce,0x0e,0x0c,0x33,0x56}};
inline constexpr GUID PoolFactoryId{0x589b103f,0x6bbc,0x5df5,{0xa9,0x91,0x02,0xe2,0x8b,0x3b,0x66,0xd5}};
inline constexpr GUID SurfaceAccessId{0xa9b3d012,0x3df2,0x4ee3,{0xb8,0xd1,0x86,0x95,0xf4,0x57,0xd3,0xc1}};
inline constexpr GUID ClosableId{0x30d5a829,0x7fa4,0x4026,{0x83,0xbb,0xd7,0x5b,0xae,0x4e,0xa9,0x9e}};
inline constexpr INT32 Bgra8 = 87;
}
