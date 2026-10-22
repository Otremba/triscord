use crate::{
    error::{Error, Result},
    video_codec::{Config, Encoder},
    video_gpu::Converter,
};
use livekit::webrtc::{
    video_frame::{EncodedFrameType, EncodedVideoCodec, EncodedVideoFrame},
    video_source::{native::NativeVideoSource, VideoResolution},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::Interface,
    Win32::Graphics::{Direct3D10::ID3D10Multithread, Direct3D11::*},
};
use windows_capture::{
    capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    frame::Frame,
    graphics_capture_api::InternalCaptureControl,
    monitor::Monitor,
    settings::*,
    window::Window,
};
type Failure = Arc<dyn Fn() + Send + Sync>;
#[derive(Clone)]
pub struct Source {
    pub name: String,
    pub kind: &'static str,
    handle: usize,
    pid: u32,
}
pub fn sources() -> Result<Vec<Source>> {
    let mut sources = Vec::new();
    for (index, monitor) in Monitor::enumerate()
        .map_err(|_| Error::network())?
        .into_iter()
        .enumerate()
    {
        sources.push(Source {
            name: format!("Tela {}", index + 1),
            kind: "screen",
            handle: monitor.as_raw_hmonitor() as usize,
            pid: 0,
        });
    }
    for window in Window::enumerate().map_err(|_| Error::network())? {
        let name = window.title().unwrap_or_default();
        let pid = window.process_id().unwrap_or(0);
        if !name.trim().is_empty() && pid != 0 && pid != std::process::id() {
            sources.push(Source {
                name,
                kind: "window",
                handle: window.as_raw_hwnd() as usize,
                pid,
            });
        }
    }
    Ok(sources)
}
struct GpuFrame {
    texture: ID3D11Texture2D,
}
#[derive(Clone)]
pub struct Flags {
    source: Source,
    config: Config,
    sender: mpsc::SyncSender<GpuFrame>,
    alive: Arc<AtomicBool>,
    failure: Failure,
}
struct Handler {
    flags: Flags,
    converter: Converter,
    query: ID3D11Query,
    clock: Clock,
    started: Instant,
}
impl GraphicsCaptureApiHandler for Handler {
    type Flags = Flags;
    type Error = windows::core::Error;
    fn new(context: Context<Flags>) -> std::result::Result<Self, Self::Error> {
        unsafe {
            let protection: ID3D10Multithread = context.device.cast()?;
            let _ = protection.SetMultithreadProtected(true);
        }
        let mut query = None;
        unsafe {
            context.device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut query),
            )?;
        }
        let query = query.ok_or_else(|| {
            windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
        })?;
        Ok(Self {
            clock: Clock::new(context.flags.config.fps),
            converter: Converter::new(
                context.device,
                context.device_context,
                context.flags.config,
            )?,
            flags: context.flags,
            query,
            started: Instant::now(),
        })
    }
    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> std::result::Result<(), Self::Error> {
        if !self.flags.alive.load(Ordering::Acquire) {
            control.stop();
            return Ok(());
        }
        if self.flags.source.kind == "window"
            && Window::from_raw_hwnd(self.flags.source.handle as *mut _)
                .process_id()
                .unwrap_or(0)
                != self.flags.source.pid
        {
            self.flags.alive.store(false, Ordering::Release);
            (self.flags.failure)();
            control.stop();
            return Ok(());
        }
        if !self.clock.due(self.started.elapsed()) {
            return Ok(());
        }
        let result = (|| -> windows::core::Result<ID3D11Texture2D> {
            let texture =
                self.converter
                    .convert(frame.as_raw_texture(), frame.width(), frame.height())?;
            unsafe {
                frame.device_context().End(&self.query);
                frame.device_context().Flush();
                let deadline = Instant::now() + Duration::from_millis(100);
                loop {
                    let mut completed = windows::core::BOOL::default();
                    frame.device_context().GetData(
                        &self.query,
                        Some((&mut completed as *mut windows::core::BOOL).cast()),
                        std::mem::size_of_val(&completed) as u32,
                        0,
                    )?;
                    if completed.as_bool() {
                        break;
                    }
                    if Instant::now() >= deadline {
                        return Err(windows::core::Error::from_hresult(
                            windows::Win32::Foundation::E_FAIL,
                        ));
                    }
                    thread::yield_now();
                }
            }
            Ok(texture)
        })();
        match result {
            Ok(texture) => {
                let _ = self.flags.sender.try_send(GpuFrame { texture });
            }
            Err(error) => {
                self.flags.alive.store(false, Ordering::Release);
                (self.flags.failure)();
                control.stop();
                return Err(error);
            }
        }
        Ok(())
    }
    fn on_closed(&mut self) -> std::result::Result<(), Self::Error> {
        if self.flags.alive.swap(false, Ordering::AcqRel) {
            (self.flags.failure)();
        }
        Ok(())
    }
}
pub struct Pipeline {
    control: Option<CaptureControl<Handler, windows::core::Error>>,
    alive: Arc<AtomicBool>,
}
impl Pipeline {
    pub fn start(
        source: Source,
        config: Config,
        sink: NativeVideoSource,
        failure: Failure,
    ) -> Result<Self> {
        if !config.valid() {
            return Err(Error::invalid());
        }
        let alive = Arc::new(AtomicBool::new(true));
        let (sender, receiver) = mpsc::sync_channel(2);
        let flags = Flags {
            source: source.clone(),
            config,
            sender,
            alive: alive.clone(),
            failure: failure.clone(),
        };
        let settings = |item| {
            Settings::new(
                item,
                CursorCaptureSettings::WithCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags.clone(),
            )
        };
        let control = if source.kind == "screen" {
            Handler::start_free_threaded(settings(Monitor::from_raw_hmonitor(
                source.handle as *mut _,
            )))
        } else {
            Handler::start_free_threaded(Settings::new(
                Window::from_raw_hwnd(source.handle as *mut _),
                CursorCaptureSettings::WithCursor,
                DrawBorderSettings::WithoutBorder,
                SecondaryWindowSettings::Default,
                MinimumUpdateIntervalSettings::Default,
                DirtyRegionSettings::Default,
                ColorFormat::Bgra8,
                flags,
            ))
        }
        .map_err(|_| Error::network())?;
        let running = alive.clone();
        thread::spawn(move || {
            if encode(receiver, running.clone(), config, sink).is_err()
                && running.swap(false, Ordering::AcqRel)
            {
                failure();
            }
        });
        Ok(Self {
            control: Some(control),
            alive,
        })
    }
}
impl Drop for Pipeline {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        if let Some(control) = self.control.take() {
            thread::spawn(move || {
                let _ = control.stop();
            });
        }
    }
}
fn encode(
    receiver: mpsc::Receiver<GpuFrame>,
    alive: Arc<AtomicBool>,
    config: Config,
    sink: NativeVideoSource,
) -> windows::core::Result<()> {
    let mut latest = None;
    let mut encoder: Option<Encoder> = None;
    let started = Instant::now();
    let mut clock = Clock::new(config.fps);
    while alive.load(Ordering::Acquire) {
        if let Ok(frame) = receiver.recv_timeout(Duration::from_millis(2)) {
            latest = Some(frame);
            while let Ok(frame) = receiver.try_recv() {
                latest = Some(frame);
            }
        }
        let Some(frame) = &latest else {
            if started.elapsed() > Duration::from_secs(10) {
                return Err(windows::core::Error::from_hresult(
                    windows::Win32::Foundation::E_FAIL,
                ));
            }
            continue;
        };
        if encoder.is_none() {
            let device = unsafe { frame.texture.GetDevice()? };
            let enc = Encoder::new(config, &device)?;
            let _ = enc.keyframe();
            encoder = Some(enc);
        }
        let encoder = encoder.as_mut().expect("initialized encoder");
        if sink.take_keyframe_request() {
            let _ = encoder.keyframe();
        }
        if let Some(rate) = sink.take_rate_control_request() {
            let bitrate = rate.target_bitrate_bps.clamp(64000, config.bitrate as u64) as u32;
            let _ = encoder.bitrate(bitrate);
        }
        if encoder.ready()? && clock.due(started.elapsed()) {
            let timestamp = started.elapsed().as_nanos() / 100;
            encoder.submit(&frame.texture, timestamp.min(i64::MAX as u128) as i64)?;
        }
        for frame in encoder.poll()? {
            if !sink.capture_encoded_frame(&EncodedVideoFrame {
                codec: EncodedVideoCodec::H264,
                payload: &frame.data,
                timestamp_us: frame.timestamp / 10,
                frame_type: if frame.keyframe {
                    EncodedFrameType::Key
                } else {
                    EncodedFrameType::Delta
                },
                resolution: VideoResolution {
                    width: config.width,
                    height: config.height,
                },
                frame_metadata: None,
            }) {
                let _ = encoder.keyframe();
            }
        }
    }
    Ok(())
}
pub struct Clock {
    fps: u32,
    last: Option<u128>,
}
impl Clock {
    pub fn new(fps: u32) -> Self {
        Self {
            fps: fps.max(1),
            last: None,
        }
    }
    pub fn due(&mut self, elapsed: Duration) -> bool {
        // Accumulate from the original epoch, not the last accepted frame: no 60->30fps drift.
        let tick = (elapsed.as_nanos() * self.fps as u128 + 500000) / 1000000000;
        if self.last.is_none_or(|last| tick > last) {
            self.last = Some(tick);
            true
        } else {
            false
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn thirty_fps_capture_does_not_drop_to_twenty_on_sixty_hz_source() {
        let mut clock = Clock::new(30);
        let mut accepted = 0;
        for frame in 0..60 {
            if clock.due(Duration::from_nanos(frame * 1000000000 / 60)) {
                accepted += 1;
            }
        }
        assert_eq!(accepted, 30);
    }
    #[test]
    fn clock_cadence_under_jitter_and_extreme_durations() {
        let mut clock = Clock::new(60);
        // Zero duration is due immediately on first call
        assert!(clock.due(Duration::ZERO));
        // Same tick does not re-trigger
        assert!(!clock.due(Duration::ZERO));
        assert!(!clock.due(Duration::from_micros(100)));

        // Advance by ~16.6ms intervals with jitter (14ms, 19ms, 16ms)
        let mut current_ns = 0u64;
        let mut frames = 0;
        let jitter = [14_000_000, 19_000_000, 16_000_000, 17_000_000];
        for i in 0..60 {
            current_ns += jitter[i % jitter.len()];
            if clock.due(Duration::from_nanos(current_ns)) {
                frames += 1;
            }
        }
        // Over roughly 1 second (16.5ms * 60 = 990ms), clock should accept roughly 59-60 frames
        assert!((58..=61).contains(&frames), "Frames accepted: {}", frames);

        // Long duration test: 10 days without panic or overflow
        let ten_days = Duration::from_secs(86400 * 10);
        assert!(clock.due(ten_days));
    }
    #[test]
    fn source_metadata_and_cloning() {
        let screen = Source {
            name: "Tela 1".into(),
            kind: "screen",
            handle: 12345,
            pid: 0,
        };
        let cloned = screen.clone();
        assert_eq!(cloned.name, "Tela 1");
        assert_eq!(cloned.kind, "screen");
        assert_eq!(cloned.handle, 12345);
        assert_eq!(cloned.pid, 0);
    }
}
