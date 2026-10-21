//! Native child surfaces. Decoded frames never cross the renderer IPC boundary.
use crate::{
    error::{Error, Result},
    video_gpu::Converter,
};
use livekit::webrtc::video_frame::{BoxVideoFrame, VideoBuffer};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};
use windows::{
    core::{w, Interface},
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dxgi::{Common::*, *},
            Gdi::*,
        },
        UI::WindowsAndMessaging::*,
    },
};

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
impl Rect {
    pub fn physical(self, scale: f64) -> Option<Self> {
        if !scale.is_finite()
            || !(0.5..=4.).contains(&scale)
            || self.width < 0
            || self.height < 0
            || self.width > 8192
            || self.height > 8192
            || self.x.unsigned_abs() > 32768
            || self.y.unsigned_abs() > 32768
        {
            return None;
        }
        let rect = Self {
            x: (self.x as f64 * scale).round() as i32,
            y: (self.y as f64 * scale).round() as i32,
            width: (self.width as f64 * scale).round() as i32 & !1,
            height: (self.height as f64 * scale).round() as i32 & !1,
        };
        (rect.width <= 8192 && rect.height <= 8192).then_some(rect)
    }
}
#[derive(Default)]
struct Slot {
    frame: Option<BoxVideoFrame>,
    rect: Rect,
    scale: f64,
    failed: bool,
    /// The card is the focused stage: the stage's own menus cut it too.
    stage: bool,
    /// "Ocultar transmissão": the card stays but its native window is hidden and its frames dropped.
    hidden: bool,
}
#[derive(Default)]
struct State {
    dirty: bool,
    slots: HashMap<String, Slot>,
    occluders: Vec<Rect>,
    stage_occluders: Vec<Rect>,
}
#[derive(Clone)]
pub struct Presenter {
    state: Arc<Mutex<State>>,
    wake: Arc<Condvar>,
}
impl Presenter {
    pub fn new(parent: usize, app: tauri::AppHandle) -> Self {
        let state = Arc::new(Mutex::new(State::default()));
        let wake = Arc::new(Condvar::new());
        let worker_wake = wake.clone();
        let weak = Arc::downgrade(&state);
        thread::spawn(move || {
            let mut surfaces: HashMap<String, Surface> = HashMap::new();
            loop {
                let Some(state) = weak.upgrade() else { break };
                let (frames, ids) = {
                    let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
                    state.dirty = false;
                    let ids = state.slots.keys().cloned().collect::<Vec<_>>();
                    let base = state.occluders.clone();
                    let stage = state.stage_occluders.clone();
                    let frames = state
                        .slots
                        .iter_mut()
                        .map(|(id, slot)| {
                            let mut cuts = base.clone();
                            if slot.stage {
                                cuts.extend(stage.iter().copied());
                            }
                            (
                                id.clone(),
                                // A hidden stream draws nothing and keeps no frame waiting.
                                slot.frame.take().filter(|_| !slot.hidden),
                                if slot.hidden { Rect::default() } else { slot.rect },
                                slot.scale,
                                slot.failed,
                                cuts,
                            )
                        })
                        .collect::<Vec<_>>();
                    (frames, ids)
                };
                surfaces.retain(|id, _| ids.contains(id));
                for (id, frame, rect, scale, failed, occluders) in frames {
                    if failed {
                        continue;
                    }
                    if rect.width < 2 || rect.height < 2 {
                        if let Some(surface) = surfaces.get_mut(&id) {
                            unsafe {
                                let _ = ShowWindow(surface.window, SW_HIDE);
                            }
                            surface.visible = false;
                        }
                        continue;
                    }
                    // Device/window creation is lazy and occurs only after a subscribed frame.
                    if !surfaces.contains_key(&id) && frame.is_some() {
                        match Surface::new(parent, rect) {
                            Ok(surface) => {
                                surfaces.insert(id.clone(), surface);
                            }
                            Err(_) => {
                                if let Some(slot) = state
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .slots
                                    .get_mut(&id)
                                {
                                    slot.failed = true;
                                }
                                crate::model::notice(&app,"Não foi possível criar a saída de vídeo por GPU. Entre novamente na sala para tentar recuperar.");
                                continue;
                            }
                        }
                    }
                    if let Some(surface) = surfaces.get_mut(&id) {
                        let result =
                            surface
                                .layout(rect, &occluders, scale)
                                .and_then(|_| match frame {
                                    Some(frame) => surface.draw(frame),
                                    None => Ok(()),
                                });
                        if result.is_err() {
                            unsafe {
                                let _ = ShowWindow(surface.window, SW_HIDE);
                            }
                            if let Some(slot) = state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .slots
                                .get_mut(&id)
                            {
                                slot.failed = true;
                            }
                            crate::model::notice(&app,"A saída de vídeo por GPU falhou. Entre novamente na sala para tentar recuperar.");
                        }
                    }
                }
                unsafe {
                    let mut msg = MSG::default();
                    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
                let guard = state.lock().unwrap_or_else(|e| e.into_inner());
                let _ =
                    worker_wake.wait_timeout_while(guard, Duration::from_millis(250), |state| {
                        !state.dirty
                    });
                drop(state);
            }
        });
        Self { state, wake }
    }
    pub fn register(&self, id: &str) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.slots.len() >= 16 || state.slots.contains_key(id) {
            return Err(Error::invalid());
        }
        state.slots.insert(id.into(), Slot::default());
        state.dirty = true;
        self.wake.notify_one();
        Ok(())
    }
    pub fn remove(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.slots.remove(id);
        state.dirty = true;
        self.wake.notify_one();
    }
    pub fn submit(&self, id: &str, frame: BoxVideoFrame) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = state.slots.get_mut(id) {
            slot.frame = Some(frame);
            state.dirty = true;
            self.wake.notify_one();
        }
    }
    pub fn layout(&self, id: &str, rect: Rect, scale: f64) -> Result<()> {
        let physical = rect.physical(scale).ok_or_else(Error::invalid)?;
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = state.slots.get_mut(id) {
            slot.rect = physical;
            slot.scale = scale;
        }
        state.dirty = true;
        self.wake.notify_one();
        Ok(())
    }
    /// "grid", "stage" or "film": where the page shows this card (only the stage is cut by the stage's menus).
    pub fn role(&self, id: &str, role: &str) -> Result<()> {
        if !["grid", "stage", "film"].contains(&role) {
            return Err(Error::invalid());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = state.slots.get_mut(id) {
            slot.stage = role == "stage";
        }
        state.dirty = true;
        self.wake.notify_one();
        Ok(())
    }
    pub fn hide(&self, id: &str, hidden: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(slot) = state.slots.get_mut(id) {
            slot.hidden = hidden;
        }
        state.dirty = true;
        self.wake.notify_one();
    }
    pub fn stage_occluders(&self, rects: Vec<Rect>) -> Result<()> {
        if rects.len() > 8 || rects.iter().any(|r| r.physical(1.).is_none()) {
            return Err(Error::invalid());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.stage_occluders = rects;
        state.dirty = true;
        self.wake.notify_one();
        Ok(())
    }
    pub fn occluders(&self, rects: Vec<Rect>) -> Result<()> {
        if rects.len() > 8 || rects.iter().any(|r| r.physical(1.).is_none()) {
            return Err(Error::invalid());
        }
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.occluders = rects;
        state.dirty = true;
        self.wake.notify_one();
        Ok(())
    }
}

struct Surface {
    visible: bool,
    occluders: Vec<Rect>,
    scale: f64,
    window: HWND,
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    swap: IDXGISwapChain1,
    converter: Converter,
    size: (u32, u32),
    rect: Rect,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.window);
        }
    }
}
impl Surface {
    fn new(parent: usize, rect: Rect) -> windows::core::Result<Self> {
        unsafe {
            let window = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!(""),
                WS_CHILD | WS_DISABLED | WS_CLIPSIBLINGS,
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                Some(HWND(parent as *mut _)),
                None,
                None,
                None,
            )?;
            let result = (|| {
                let mut device = None;
                let mut context = None;
                D3D11CreateDevice(
                    None,
                    D3D_DRIVER_TYPE_HARDWARE,
                    HMODULE::default(),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                    None,
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )?;
                let device = device.ok_or_else(windows::core::Error::from_thread)?;
                let context = context.ok_or_else(windows::core::Error::from_thread)?;
                let dxgi: IDXGIDevice = device.cast()?;
                let factory: IDXGIFactory2 = dxgi.GetAdapter()?.GetParent()?;
                let swap = factory.CreateSwapChainForHwnd(
                    &device,
                    window,
                    &DXGI_SWAP_CHAIN_DESC1 {
                        Width: rect.width as u32,
                        Height: rect.height as u32,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC {
                            Count: 1,
                            Quality: 0,
                        },
                        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                        BufferCount: 2,
                        SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
                        Scaling: DXGI_SCALING_STRETCH,
                        ..Default::default()
                    },
                    None,
                    None,
                )?;
                let converter = Converter::receiver(
                    device.clone(),
                    context.clone(),
                    rect.width as u32,
                    rect.height as u32,
                )?;
                Ok(Self {
                    window,
                    device,
                    context,
                    swap,
                    converter,
                    size: (rect.width as u32, rect.height as u32),
                    rect,
                    visible: false,
                    occluders: Vec::new(),
                    scale: 0.,
                })
            })();
            if result.is_err() {
                let _ = DestroyWindow(window);
            }
            result
        }
    }
    fn layout(&mut self, rect: Rect, occluders: &[Rect], scale: f64) -> windows::core::Result<()> {
        if self.visible && self.rect == rect && self.occluders == occluders && self.scale == scale {
            return Ok(());
        }
        unsafe {
            let size = (rect.width as u32, rect.height as u32);
            if size != self.size {
                self.swap.ResizeBuffers(
                    2,
                    size.0,
                    size.1,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_SWAP_CHAIN_FLAG(0),
                )?;
                self.converter =
                    Converter::receiver(self.device.clone(), self.context.clone(), size.0, size.1)?;
                self.size = size;
            }
            self.rect = rect;
            self.visible = true;
            self.occluders = occluders.to_vec();
            self.scale = scale;
            SetWindowPos(
                self.window,
                Some(HWND_TOP),
                rect.x,
                rect.y,
                rect.width,
                rect.height,
                SWP_NOACTIVATE | SWP_SHOWWINDOW,
            )?;
            let mask = CreateRectRgn(0, 0, rect.width, rect.height);
            if mask.is_invalid() {
                return Err(windows::core::Error::from_thread());
            }
            for occluder in occluders {
                if let Some(cut) = occluder.physical(scale) {
                    let cut = CreateRectRgn(
                        cut.x - rect.x,
                        cut.y - rect.y,
                        cut.x - rect.x + cut.width,
                        cut.y - rect.y + cut.height,
                    );
                    if !cut.is_invalid() {
                        CombineRgn(Some(mask), Some(mask), Some(cut), RGN_DIFF);
                        let _ = DeleteObject(cut.into());
                    }
                }
            }
            // On success Windows owns the region.
            if SetWindowRgn(self.window, Some(mask), true) == 0 {
                let _ = DeleteObject(mask.into());
                return Err(windows::core::Error::from_thread());
            }
            Ok(())
        }
    }
    fn draw(&mut self, frame: BoxVideoFrame) -> windows::core::Result<()> {
        let buffer = frame.buffer.to_i420();
        let width = buffer.width();
        let height = buffer.height();
        let planes = buffer.data();
        let strides = buffer.strides();
        let bytes = nv12(width, height, strides, planes).ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_INVALIDARG)
        })?;
        unsafe {
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: width,
                    Height: height,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                    ..Default::default()
                },
                Some(&D3D11_SUBRESOURCE_DATA {
                    pSysMem: bytes.as_ptr().cast(),
                    SysMemPitch: width,
                    SysMemSlicePitch: 0,
                }),
                Some(&mut texture),
            )?;
            let texture = texture.ok_or_else(windows::core::Error::from_thread)?;
            let output = self.converter.convert(&texture, width, height)?;
            let back: ID3D11Texture2D = self.swap.GetBuffer(0)?;
            self.context.CopyResource(&back, &output);
            // Never block behind a slow/occluded compositor or build a presentation queue.
            let result = self.swap.Present(0, DXGI_PRESENT_DO_NOT_WAIT);
            if result == DXGI_ERROR_WAS_STILL_DRAWING {
                return Ok(());
            }
            result.ok()
        }
    }
}

fn nv12(
    width: u32,
    height: u32,
    strides: (u32, u32, u32),
    planes: (&[u8], &[u8], &[u8]),
) -> Option<Vec<u8>> {
    if width < 2 || height < 2 || width > 4096 || height > 4096 || width % 2 != 0 || height % 2 != 0
    {
        return None;
    }
    let (w, h) = (width as usize, height as usize);
    let (sy, su, sv) = (strides.0 as usize, strides.1 as usize, strides.2 as usize);
    if sy < w
        || su < w / 2
        || sv < w / 2
        || planes.0.len() < sy.checked_mul(h)?
        || planes.1.len() < su.checked_mul(h / 2)?
        || planes.2.len() < sv.checked_mul(h / 2)?
    {
        return None;
    }
    let mut bytes = vec![0; w * h * 3 / 2];
    for y in 0..h {
        bytes[y * w..(y + 1) * w].copy_from_slice(&planes.0[y * sy..y * sy + w]);
    }
    for y in 0..h / 2 {
        for x in 0..w / 2 {
            bytes[w * h + y * w + 2 * x] = planes.1[y * su + x];
            bytes[w * h + y * w + 2 * x + 1] = planes.2[y * sv + x];
        }
    }
    Some(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interleave_respects_plane_padding_and_rejects_short_buffers() {
        let bytes = nv12(2, 2, (3, 2, 2), (&[1, 2, 99, 3, 4, 99], &[5, 99], &[6, 99])).unwrap();
        assert_eq!(bytes, vec![1, 2, 3, 4, 5, 6]);
        assert!(nv12(2, 2, (2, 1, 1), (&[0; 3], &[0], &[0])).is_none());
        assert!(nv12(3, 2, (3, 2, 2), (&[0; 6], &[0; 2], &[0; 2])).is_none());
    }
    #[test]
    fn geometry_is_bounded_before_native_calls() {
        assert!(Rect {
            x: i32::MIN,
            ..Default::default()
        }
        .physical(1.)
        .is_none());
        assert!(Rect::default().physical(f64::NAN).is_none());
        assert!(Rect {
            width: 8192,
            ..Default::default()
        }
        .physical(4.)
        .is_none());
        let rect = Rect {
            x: 10,
            y: 20,
            width: 301,
            height: 201,
        }
        .physical(1.5)
        .unwrap();
        assert_eq!(
            (rect.x, rect.y, rect.width, rect.height),
            (15, 30, 452, 302)
        );
    }
}
