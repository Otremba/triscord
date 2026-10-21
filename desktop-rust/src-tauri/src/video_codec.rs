//! Thread-confined Media Foundation encoder. Tests exercise framing/configuration only, never devices.
use std::{marker::PhantomData, mem::ManuallyDrop, rc::Rc};
use windows::{
    core::{Error, Interface, Result, GUID},
    Win32::{
        Foundation::{E_FAIL, E_INVALIDARG},
        Graphics::{
            Direct3D10::ID3D10Multithread,
            Direct3D11::{ID3D11Device, ID3D11Texture2D},
        },
        Media::MediaFoundation::*,
        System::{
            Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_MULTITHREADED},
            Variant::VARIANT,
        },
    },
};

#[derive(Clone, Copy)]
pub struct Config {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate: u32,
}
impl Config {
    pub fn valid(self) -> bool {
        (64..=2560).contains(&self.width)
            && (64..=1440).contains(&self.height)
            && self.width % 2 == 0
            && self.height % 2 == 0
            && (1..=60).contains(&self.fps)
            && (64000..=30000000).contains(&self.bitrate)
    }
}
pub struct Encoded {
    pub data: Vec<u8>,
    pub timestamp: i64,
    pub keyframe: bool,
}
struct Runtime {
    _thread: PhantomData<Rc<()>>,
}
impl Runtime {
    fn new() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = MFStartup(MF_VERSION, MFSTARTUP_FULL) {
                CoUninitialize();
                return Err(error);
            }
        }
        Ok(Self {
            _thread: PhantomData,
        })
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            CoUninitialize();
        }
    }
}
pub struct Encoder {
    transform: IMFTransform,
    activation: IMFActivate,
    events: Option<IMFMediaEventGenerator>,
    _manager: IMFDXGIDeviceManager,
    _device: ID3D11Device,
    config: Config,
    input: u32,
    output: u32,
    in_flight: u32,
    last_time: i64,
    _runtime: Runtime, // Fields drop in declaration order: MF/COM objects must die before the runtime.
}
impl Encoder {
    pub fn new(config: Config, device: &ID3D11Device) -> Result<Self> {
        if !config.valid() {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        let runtime = Runtime::new()?;
        unsafe {
            let protection: ID3D10Multithread = device.cast()?;
            let _ = protection.SetMultithreadProtected(true);
            let mut reset = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut reset, &mut manager)?;
            let manager = manager.ok_or_else(|| Error::from_hresult(E_FAIL))?;
            manager.ResetDevice(device, reset)?;
            let input = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_NV12,
            };
            let output = MFT_REGISTER_TYPE_INFO {
                guidMajorType: MFMediaType_Video,
                guidSubtype: MFVideoFormat_H264,
            };
            let mut pointer = std::ptr::null_mut();
            let mut count = 0;
            MFTEnumEx(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                Some(&input),
                Some(&output),
                &mut pointer,
                &mut count,
            )?;
            let activations = if pointer.is_null() {
                Vec::new()
            } else {
                let values = (0..count)
                    .filter_map(|i| std::ptr::read(pointer.add(i as usize)))
                    .collect::<Vec<_>>();
                CoTaskMemFree(Some(pointer.cast()));
                values
            };
            let mut last = Error::from_hresult(E_FAIL);
            for activation in activations {
                let candidate = (|| -> Result<(IMFTransform, Option<IMFMediaEventGenerator>)> {
                    let transform: IMFTransform = activation.ActivateObject()?;
                    let attributes = transform.GetAttributes()?;
                    if attributes.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) == 0 {
                        return Err(Error::from_hresult(E_FAIL));
                    }
                    let events = if attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0 {
                        attributes.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)?;
                        Some(transform.cast()?)
                    } else {
                        None
                    };
                    transform
                        .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)?;
                    let _ = codec_bool(&transform, &CODECAPI_AVLowLatencyMode, true);
                    let _ = codec_value(&transform, &CODECAPI_AVEncMPVDefaultBPictureCount, 0);
                    let _ = codec_value(&transform, &CODECAPI_AVEncMPVGOPSize, config.fps * 2);
                    let _ = codec_value(
                        &transform,
                        &CODECAPI_AVEncCommonRateControlMode,
                        eAVEncCommonRateControlMode_CBR.0 as u32,
                    );
                    let out = media_type(config, &MFVideoFormat_H264)?;
                    out.SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate)?;
                    out.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32)?;
                    transform.SetOutputType(0, &out, 0)?;
                    transform.SetInputType(0, &media_type(config, &MFVideoFormat_NV12)?, 0)?;
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)?;
                    transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)?;
                    Ok((transform, events))
                })();
                match candidate {
                    Ok((transform, events)) => {
                        return Ok(Self {
                            transform,
                            activation,
                            events,
                            _manager: manager,
                            _device: device.clone(),
                            config,
                            input: 0,
                            output: 0,
                            in_flight: 0,
                            last_time: -1,
                            _runtime: runtime,
                        })
                    }
                    Err(error) => {
                        let _ = activation.ShutdownObject();
                        last = error;
                    }
                }
            }
            Err(last)
        }
    }
    fn collect(&mut self) -> Result<()> {
        if let Some(events) = &self.events {
            unsafe {
                for _ in 0..64 {
                    let event = match events.GetEvent(MEDIA_EVENT_GENERATOR_GET_EVENT_FLAGS(
                        MF_EVENT_FLAG_NO_WAIT.0,
                    )) {
                        Ok(value) => value,
                        Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => break,
                        Err(error) => return Err(error),
                    };
                    event.GetStatus()?.ok()?;
                    match event.GetType()? {
                        value if value == METransformNeedInput.0 as u32 => self.input += 1,
                        value if value == METransformHaveOutput.0 as u32 => self.output += 1,
                        _ => {}
                    }
                    if self.input > 64 || self.output > 64 {
                        return Err(Error::from_hresult(E_FAIL));
                    }
                }
            }
        }
        Ok(())
    }
    pub fn ready(&mut self) -> Result<bool> {
        self.collect()?;
        Ok(self.in_flight < 4 && (self.events.is_none() || self.input > 0))
    }
    pub fn keyframe(&self) -> Result<()> {
        unsafe { codec_value(&self.transform, &CODECAPI_AVEncVideoForceKeyFrame, 1) }
    }
    pub fn bitrate(&mut self, value: u32) -> Result<()> {
        let mut config = self.config;
        config.bitrate = value;
        if !config.valid() {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        unsafe {
            codec_value(&self.transform, &CODECAPI_AVEncCommonMeanBitRate, value)?;
        }
        self.config = config;
        Ok(())
    }
    pub fn submit(&mut self, texture: &ID3D11Texture2D, timestamp: i64) -> Result<bool> {
        unsafe {
            let mut desc = Default::default();
            texture.GetDesc(&mut desc);
            if desc.Width != self.config.width
                || desc.Height != self.config.height
                || desc.Format != windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_NV12
                || desc.ArraySize != 1
                || desc.MipLevels != 1
                || texture.GetDevice()?.as_raw() != self._device.as_raw()
            {
                return Err(Error::from_hresult(E_INVALIDARG));
            }
        }
        if timestamp < 0 || timestamp <= self.last_time {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        if !self.ready()? {
            return Ok(false);
        }
        unsafe {
            let sample = MFCreateSample()?;
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)?;
            sample.AddBuffer(&buffer)?;
            sample.SetSampleTime(timestamp)?;
            sample.SetSampleDuration(10000000 / self.config.fps as i64)?;
            match self.transform.ProcessInput(0, &sample, 0) {
                Err(error) if error.code() == MF_E_NOTACCEPTING => return Ok(false),
                result => result?,
            }
        }
        if self.events.is_some() {
            self.input -= 1;
        }
        self.in_flight += 1;
        self.last_time = timestamp;
        Ok(true)
    }
    pub fn poll(&mut self) -> Result<Vec<Encoded>> {
        self.collect()?;
        let mut frames = Vec::new();
        for _ in 0..4 {
            if self.events.is_some() && self.output == 0 {
                break;
            }
            unsafe {
                let info = self.transform.GetOutputStreamInfo(0)?;
                let supplied = if info.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 == 0 {
                    if info.cbSize == 0 || info.cbSize > 8 * 1024 * 1024 {
                        return Err(Error::from_hresult(E_FAIL));
                    }
                    let sample = MFCreateSample()?;
                    sample.AddBuffer(&MFCreateAlignedMemoryBuffer(
                        info.cbSize,
                        info.cbAlignment.saturating_sub(1),
                    )?)?;
                    Some(sample)
                } else {
                    None
                };
                let mut output = MFT_OUTPUT_DATA_BUFFER {
                    dwStreamID: 0,
                    pSample: ManuallyDrop::new(supplied.clone()),
                    dwStatus: 0,
                    pEvents: ManuallyDrop::new(None),
                };
                let mut status = 0;
                let result =
                    self.transform
                        .ProcessOutput(0, std::slice::from_mut(&mut output), &mut status);
                let sample = ManuallyDrop::take(&mut output.pSample);
                let _events = ManuallyDrop::take(&mut output.pEvents);
                if let Err(error) = result {
                    if self.events.is_none() && error.code() == MF_E_TRANSFORM_NEED_MORE_INPUT {
                        break;
                    }
                    return Err(error);
                }
                if self.events.is_some() {
                    self.output -= 1;
                }
                self.in_flight = self.in_flight.saturating_sub(1);
                let sample = sample.ok_or_else(|| Error::from_hresult(E_FAIL))?;
                let mut data = sample_bytes(&sample)?;
                let keyframe = has_nal(&data, 5);
                if keyframe && (!has_nal(&data, 7) || !has_nal(&data, 8)) {
                    let kind = self.transform.GetOutputCurrentType(0)?;
                    let size = kind.GetBlobSize(&MF_MT_MPEG_SEQUENCE_HEADER)?;
                    if size == 0 || size > 65536 {
                        return Err(Error::from_hresult(E_FAIL));
                    }
                    let mut header = vec![0; size as usize];
                    kind.GetBlob(&MF_MT_MPEG_SEQUENCE_HEADER, &mut header, None)?;
                    if !has_nal(&header, 7) || !has_nal(&header, 8) {
                        return Err(Error::from_hresult(E_FAIL));
                    }
                    header.extend_from_slice(&data);
                    data = header;
                }
                frames.push(Encoded {
                    data,
                    timestamp: sample.GetSampleTime()?,
                    keyframe,
                });
            }
        }
        Ok(frames)
    }
}
impl Drop for Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            let _ = self.activation.ShutdownObject();
        }
    }
}
unsafe fn media_type(config: Config, subtype: &GUID) -> Result<IMFMediaType> {
    let kind = MFCreateMediaType()?;
    kind.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
    kind.SetGUID(&MF_MT_SUBTYPE, subtype)?;
    kind.SetUINT64(
        &MF_MT_FRAME_SIZE,
        ((config.width as u64) << 32) | config.height as u64,
    )?;
    kind.SetUINT64(&MF_MT_FRAME_RATE, ((config.fps as u64) << 32) | 1)?;
    kind.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
    kind.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
    kind.SetUINT32(&MF_MT_VIDEO_PRIMARIES, MFVideoPrimaries_BT709.0 as u32)?;
    kind.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)?;
    kind.SetUINT32(&MF_MT_TRANSFER_FUNCTION, MFVideoTransFunc_709.0 as u32)?;
    kind.SetUINT32(&MF_MT_VIDEO_NOMINAL_RANGE, MFNominalRange_16_235.0 as u32)?;
    Ok(kind)
}
unsafe fn codec_value(transform: &IMFTransform, key: &GUID, value: u32) -> Result<()> {
    let codec: ICodecAPI = transform.cast()?;
    codec.SetValue(key, &VARIANT::from(value))
}
unsafe fn codec_bool(transform: &IMFTransform, key: &GUID, value: bool) -> Result<()> {
    let codec: ICodecAPI = transform.cast()?;
    codec.SetValue(key, &VARIANT::from(value))
}
unsafe fn sample_bytes(sample: &IMFSample) -> Result<Vec<u8>> {
    let buffer = sample.ConvertToContiguousBuffer()?;
    let length = buffer.GetCurrentLength()?;
    if length == 0 || length > 8 * 1024 * 1024 {
        return Err(Error::from_hresult(E_FAIL));
    }
    let mut data = std::ptr::null_mut();
    buffer.Lock(&mut data, None, None)?;
    let result = std::slice::from_raw_parts(data, length as usize).to_vec();
    buffer.Unlock()?;
    Ok(result)
}
pub fn has_nal(data: &[u8], kind: u8) -> bool {
    (0..data.len().saturating_sub(3)).any(|i| {
        let n = if data[i..].starts_with(&[0, 0, 1]) {
            3
        } else if data[i..].starts_with(&[0, 0, 0, 1]) {
            4
        } else {
            return false;
        };
        data.get(i + n).is_some_and(|value| value & 31 == kind)
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encoder_configuration_rejects_oversize_and_odd_dimensions() {
        let valid = Config {
            width: 2560,
            height: 1440,
            fps: 60,
            bitrate: 16000000,
        };
        assert!(valid.valid());
        assert!(!Config {
            width: 2561,
            ..valid
        }
        .valid());
        assert!(!Config { fps: 0, ..valid }.valid());
        assert!(!Config {
            bitrate: 31000000,
            ..valid
        }
        .valid());
    }
    #[test]
    fn annex_b_parser_handles_both_start_codes_and_truncated_headers() {
        assert!(has_nal(&[0, 0, 1, 0x65, 1], 5));
        assert!(has_nal(&[0, 0, 0, 1, 0x67, 1], 7));
        assert!(!has_nal(&[0, 0, 0, 1], 5));
        assert!(!has_nal(&[0, 0, 1], 5));
        assert!(!has_nal(&[1, 2, 3, 4, 5], 5));
    }
    #[test]
    fn config_accepts_standard_presets_720p30_and_1080p60() {
        let p720 = Config {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate: 2500000,
        };
        assert!(p720.valid());

        let p1080 = Config {
            width: 1920,
            height: 1080,
            fps: 60,
            bitrate: 8000000,
        };
        assert!(p1080.valid());
    }
    #[test]
    fn config_rejects_odd_height_or_too_low_bitrate() {
        let odd_h = Config {
            width: 1920,
            height: 1081,
            fps: 60,
            bitrate: 8000000,
        };
        assert!(!odd_h.valid());

        let low_bitrate = Config {
            width: 1280,
            height: 720,
            fps: 30,
            bitrate: 32000, // < 64000
        };
        assert!(!low_bitrate.valid());
    }
    #[test]
    fn annex_b_parser_distinguishes_nal_types() {
        // NAL header byte: forbidden_zero_bit (1) + nal_ref_idc (2) + nal_unit_type (5)
        // 0x27 & 0x1F = 7 (SPS)
        // 0x28 & 0x1F = 8 (PPS)
        // 0x25 & 0x1F = 5 (IDR slice)
        // 0x21 & 0x1F = 1 (non-IDR slice)
        let stream = [0, 0, 0, 1, 0x27, 0, 0, 0, 1, 0x28, 0, 0, 1, 0x25];
        assert!(has_nal(&stream, 7), "should detect SPS");
        assert!(has_nal(&stream, 8), "should detect PPS");
        assert!(has_nal(&stream, 5), "should detect IDR");
        assert!(!has_nal(&stream, 1), "non-IDR slice is absent");
    }
}
