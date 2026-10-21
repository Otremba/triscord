use crate::video_codec::Config;
use std::mem::ManuallyDrop;
use windows::{
    core::{Error, Interface, Result},
    Win32::{
        Foundation::{E_FAIL, E_INVALIDARG, RECT},
        Graphics::{Direct3D11::*, Dxgi::Common::*},
    },
};

pub struct Converter {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    video: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    config: Config,
    source: (u32, u32),
    enumerator: Option<ID3D11VideoProcessorEnumerator>,
    processor: Option<ID3D11VideoProcessor>,
    receiving: bool,
}
impl Converter {
    pub fn new(device: ID3D11Device, context: ID3D11DeviceContext, config: Config) -> Result<Self> {
        if !config.valid() {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        unsafe {
            if context.GetDevice()?.as_raw() != device.as_raw() {
                return Err(Error::from_hresult(E_INVALIDARG));
            }
        }
        Ok(Self {
            video: device.cast()?,
            video_context: context.cast()?,
            device,
            context,
            config,
            source: (0, 0),
            enumerator: None,
            processor: None,
            receiving: false,
        })
    }
    pub fn receiver(
        device: ID3D11Device,
        context: ID3D11DeviceContext,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        if width < 2
            || height < 2
            || width > 8192
            || height > 8192
            || width % 2 != 0
            || height % 2 != 0
        {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        let mut converter = Self::new(
            device,
            context,
            Config {
                width: 64,
                height: 64,
                fps: 60,
                bitrate: 8_000_000,
            },
        )?;
        converter.config.width = width;
        converter.config.height = height;
        converter.receiving = true;
        Ok(converter)
    }
    pub fn convert(
        &mut self,
        input: &ID3D11Texture2D,
        width: u32,
        height: u32,
    ) -> Result<ID3D11Texture2D> {
        if width == 0 || height == 0 || width > 16384 || height > 16384 {
            return Err(Error::from_hresult(E_INVALIDARG));
        }
        unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            input.GetDesc(&mut desc);
            if desc.Width < width
                || desc.Height < height
                || desc.Format
                    != if self.receiving {
                        DXGI_FORMAT_NV12
                    } else {
                        DXGI_FORMAT_B8G8R8A8_UNORM
                    }
                || desc.SampleDesc.Count != 1
                || desc.ArraySize != 1
                || input.GetDevice()?.as_raw() != self.device.as_raw()
            {
                return Err(Error::from_hresult(E_INVALIDARG));
            }
            if self.source != (width, height) {
                let description = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                    InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                    InputFrameRate: DXGI_RATIONAL {
                        Numerator: self.config.fps,
                        Denominator: 1,
                    },
                    InputWidth: width,
                    InputHeight: height,
                    OutputFrameRate: DXGI_RATIONAL {
                        Numerator: self.config.fps,
                        Denominator: 1,
                    },
                    OutputWidth: self.config.width,
                    OutputHeight: self.config.height,
                    Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
                };
                let enumerator = self.video.CreateVideoProcessorEnumerator(&description)?;
                let input_support = enumerator.CheckVideoProcessorFormat(if self.receiving {
                    DXGI_FORMAT_NV12
                } else {
                    DXGI_FORMAT_B8G8R8A8_UNORM
                })?;
                let output_support = enumerator.CheckVideoProcessorFormat(if self.receiving {
                    DXGI_FORMAT_B8G8R8A8_UNORM
                } else {
                    DXGI_FORMAT_NV12
                })?;
                if input_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32 == 0
                    || output_support & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32 == 0
                {
                    return Err(Error::from_hresult(E_FAIL));
                }
                let processor = self.video.CreateVideoProcessor(&enumerator, 0)?;
                self.video_context.VideoProcessorSetStreamFrameFormat(
                    &processor,
                    0,
                    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                );
                self.video_context
                    .VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
                // D3D11 bitfields: full-range RGB in; BT.709 limited-range YUV out.
                self.video_context.VideoProcessorSetStreamColorSpace(
                    &processor,
                    0,
                    &D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                        _bitfield: if self.receiving { 0x14 } else { 0 },
                    },
                );
                self.video_context.VideoProcessorSetOutputColorSpace(
                    &processor,
                    &D3D11_VIDEO_PROCESSOR_COLOR_SPACE {
                        _bitfield: if self.receiving { 0 } else { 0x14 },
                    },
                );
                self.video_context.VideoProcessorSetOutputBackgroundColor(
                    &processor,
                    false,
                    &D3D11_VIDEO_COLOR {
                        Anonymous: D3D11_VIDEO_COLOR_0 {
                            RGBA: D3D11_VIDEO_COLOR_RGBA {
                                R: 0.,
                                G: 0.,
                                B: 0.,
                                A: 1.,
                            },
                        },
                    },
                );
                let target = RECT {
                    left: 0,
                    top: 0,
                    right: self.config.width as i32,
                    bottom: self.config.height as i32,
                };
                let original = RECT {
                    left: 0,
                    top: 0,
                    right: width as i32,
                    bottom: height as i32,
                };
                let fit = fit_rect((width, height), (self.config.width, self.config.height));
                self.video_context.VideoProcessorSetOutputTargetRect(
                    &processor,
                    true,
                    Some(&target),
                );
                self.video_context.VideoProcessorSetStreamSourceRect(
                    &processor,
                    0,
                    true,
                    Some(&original),
                );
                self.video_context
                    .VideoProcessorSetStreamDestRect(&processor, 0, true, Some(&fit));
                self.enumerator = Some(enumerator);
                self.processor = Some(processor);
                self.source = (width, height);
            }
            let enumerator = self
                .enumerator
                .as_ref()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?;
            let processor = self
                .processor
                .as_ref()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?;
            let mut description = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: if self.receiving {
                    DXGI_FORMAT_NV12
                } else {
                    DXGI_FORMAT_B8G8R8A8_UNORM
                },
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                ..Default::default()
            };
            let mut copied = None;
            self.device
                .CreateTexture2D(&description, None, Some(&mut copied))?;
            let copied = copied.ok_or_else(|| Error::from_hresult(E_FAIL))?;
            self.context.CopySubresourceRegion(
                &copied,
                0,
                0,
                0,
                0,
                input,
                0,
                Some(&D3D11_BOX {
                    left: 0,
                    top: 0,
                    front: 0,
                    right: width,
                    bottom: height,
                    back: 1,
                }),
            );
            description.Width = self.config.width;
            description.Height = self.config.height;
            description.Format = if self.receiving {
                DXGI_FORMAT_B8G8R8A8_UNORM
            } else {
                DXGI_FORMAT_NV12
            };
            let mut output = None;
            self.device
                .CreateTexture2D(&description, None, Some(&mut output))?;
            let output = output.ok_or_else(|| Error::from_hresult(E_FAIL))?;
            let mut input_view = None;
            let mut output_view = None;
            self.video.CreateVideoProcessorInputView(
                &copied,
                enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input_view),
            )?;
            self.video.CreateVideoProcessorOutputView(
                &output,
                enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output_view),
            )?;
            let output_view = output_view.ok_or_else(|| Error::from_hresult(E_FAIL))?;
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: ManuallyDrop::new(input_view),
                ..Default::default()
            };
            let result = self.video_context.VideoProcessorBlt(
                processor,
                &output_view,
                0,
                std::slice::from_ref(&stream),
            );
            ManuallyDrop::drop(&mut stream.pInputSurface);
            result?;
            self.context.Flush();
            Ok(output)
        }
    }
}
pub fn fit_rect(source: (u32, u32), output: (u32, u32)) -> RECT {
    let scale =
        (output.0 as f64 / source.0.max(1) as f64).min(output.1 as f64 / source.1.max(1) as f64);
    let width = ((source.0 as f64 * scale) as u32 & !1).max(2).min(output.0);
    let height = ((source.1 as f64 * scale) as u32 & !1).max(2).min(output.1);
    let left = (output.0 - width) / 2 & !1;
    let top = (output.1 - height) / 2 & !1;
    RECT {
        left: left as i32,
        top: top as i32,
        right: (left + width) as i32,
        bottom: (top + height) as i32,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aspect_fit_remains_even_and_inside_nv12_surface() {
        for source in [(1920, 1080), (1080, 1920), (16384, 100), (100, 16384)] {
            let rect = fit_rect(source, (2560, 1440));
            assert!(rect.left >= 0 && rect.top >= 0 && rect.right <= 2560 && rect.bottom <= 1440);
            assert!([rect.left, rect.top, rect.right, rect.bottom]
                .iter()
                .all(|v| v % 2 == 0));
            assert!(rect.right > rect.left && rect.bottom > rect.top);
        }
    }
    #[test]
    fn aspect_fit_exact_match_fills_entire_canvas() {
        let rect = fit_rect((1920, 1080), (1920, 1080));
        assert_eq!((rect.left, rect.top, rect.right, rect.bottom), (0, 0, 1920, 1080));
    }
    #[test]
    fn aspect_fit_ultrawide_centers_vertically() {
        // 21:9 source into 16:9 output (e.g. 2560x1080 into 2560x1440)
        let rect = fit_rect((2560, 1080), (2560, 1440));
        assert_eq!(rect.left, 0);
        assert_eq!(rect.right, 2560);
        assert!(rect.top > 0);
        assert_eq!(rect.top, 1440 - rect.bottom); // vertically centered
    }
    #[test]
    fn aspect_fit_portrait_centers_horizontally() {
        // 9:16 phone source into 16:9 output (e.g. 1080x1920 into 2560x1440)
        let rect = fit_rect((1080, 1920), (2560, 1440));
        assert_eq!(rect.top, 0);
        assert_eq!(rect.bottom, 1440);
        assert!(rect.left > 0);
        assert!((rect.left as i32 - (2560 - rect.right as i32)).abs() <= 2);
    }
    #[test]
    fn aspect_fit_tiny_and_degenerate_dimensions_clamp_safely() {
        let rect = fit_rect((0, 0), (1280, 720));
        assert!(rect.right > rect.left && rect.bottom > rect.top);
        assert!(rect.left % 2 == 0 && rect.top % 2 == 0);
    }
}
