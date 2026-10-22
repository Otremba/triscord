use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Emitter;

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Calculates an intuitive audio volume level (0 to 100%) from 32-bit float PCM samples.
pub fn calculate_f32_rms_level(samples: &[f32]) -> u8 {
    if samples.is_empty() {
        return 0;
    }
    let sum_sq: f32 = samples.iter().map(|&s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    if rms < 0.002 {
        return 0;
    }
    let normalized = (rms * 3.5).clamp(0.0, 1.0);
    (normalized * 100.0) as u8
}

/// Calculates an intuitive audio volume level (0 to 100%) from 16-bit integer PCM samples.
pub fn calculate_i16_rms_level(samples: &[i16]) -> u8 {
    if samples.is_empty() {
        return 0;
    }
    let sum_sq: f64 = samples
        .iter()
        .map(|&s| {
            let norm = s as f64 / i16::MAX as f64;
            norm * norm
        })
        .sum();
    let rms = (sum_sq / samples.len() as f64).sqrt();
    if rms < 0.002 {
        return 0;
    }
    let normalized = (rms * 3.5).clamp(0.0, 1.0);
    (normalized * 100.0) as u8
}

/// Checks if the mic test loopback is currently running.
pub fn is_running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

/// Stops the mic test loopback.
pub fn stop() {
    RUNNING.store(false, Ordering::SeqCst);
}

/// Starts the mic test loopback in a background thread.
/// Captures from `input_device_id` (or default if empty) and plays back to `output_device_id` (or default if empty),
/// emitting `mic-test-level` events with `{ "level": u8 }`.
pub fn start(app: tauri::AppHandle, input_device_id: String, output_device_id: String) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        // Already running; restarting with new parameters.
        std::thread::sleep(Duration::from_millis(60));
        RUNNING.store(true, Ordering::SeqCst);
    }

    std::thread::spawn(move || {
        #[cfg(windows)]
        {
            if std::env::var("TRISCORD_AUDIO_MODE").as_deref() == Ok("injected") {
                simulate_test(&app);
                return;
            }
            if let Err(e) = run_wasapi_loopback(&app, &input_device_id, &output_device_id) {
                // If real WASAPI hardware capture fails (e.g. no microphone plugged in), emit 0 level and stop
                let _ = app.emit("mic-test-level", serde_json::json!({ "level": 0 }));
                eprintln!("[mic_test] WASAPI loopback stopped or failed: {e:?}");
            }
        }
        #[cfg(not(windows))]
        {
            simulate_test(&app);
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

#[allow(dead_code)]
fn simulate_test(app: &tauri::AppHandle) {
    while RUNNING.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(50));
        let _ = app.emit("mic-test-level", serde_json::json!({ "level": 15 }));
    }
}

#[cfg(windows)]
fn run_wasapi_loopback(
    app: &tauri::AppHandle,
    input_device_id: &str,
    output_device_id: &str,
) -> windows::core::Result<()> {
    use windows::{
        core::HSTRING,
        Win32::{
            Media::Audio::*,
            System::Com::*,
        },
    };

    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        let owns_com = initialized.is_ok();
        if initialized.is_err() && initialized != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            initialized.ok()?;
        }

        let run = || -> windows::core::Result<()> {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;

            // Resolve capture endpoint
            let capture_device: IMMDevice = if !input_device_id.is_empty() {
                enumerator.GetDevice(&HSTRING::from(input_device_id))?
            } else {
                enumerator.GetDefaultAudioEndpoint(eCapture, eCommunications)?
            };

            // Resolve render endpoint
            let render_device: Option<IMMDevice> = if !output_device_id.is_empty() {
                enumerator.GetDevice(&HSTRING::from(output_device_id)).ok()
            } else {
                enumerator.GetDefaultAudioEndpoint(eRender, eCommunications).ok()
            };

            let capture_client_audio: IAudioClient =
                capture_device.Activate(CLSCTX_ALL, None)?;
            let wave_format_ptr = capture_client_audio.GetMixFormat()?;
            let wave_format = *wave_format_ptr;

            capture_client_audio.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                0,
                10_000_000, // 1 second buffer
                0,
                wave_format_ptr,
                None,
            )?;

            let capture: IAudioCaptureClient = capture_client_audio.GetService()?;

            // Attempt render client initialization on the output device with matching or compatible format
            let render_setup: Option<(IAudioClient, IAudioRenderClient)> = (|| {
                let dev = render_device?;
                let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).ok()?;
                let render_format = client.GetMixFormat().ok()?;
                client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        0,
                        10_000_000,
                        0,
                        render_format,
                        None,
                    )
                    .ok()?;
                let render_service: IAudioRenderClient = client.GetService().ok()?;
                client.Start().ok()?;
                Some((client, render_service))
            })();

            capture_client_audio.Start()?;

            let is_float = wave_format.wFormatTag == 3 /* WAVE_FORMAT_IEEE_FLOAT */
                || (wave_format.wFormatTag == 0xFFFE /* WAVE_FORMAT_EXTENSIBLE */
                    && wave_format.wBitsPerSample == 32);

            let mut last_emit = std::time::Instant::now();
            let mut current_level = 0u8;

            while RUNNING.load(Ordering::SeqCst) {
                let Ok(mut packet_length) = capture.GetNextPacketSize() else {
                    break;
                };

                while packet_length > 0 && RUNNING.load(Ordering::SeqCst) {
                    let mut data_ptr = std::ptr::null_mut();
                    let mut frames_available = 0u32;
                    let mut flags = 0u32;

                    if capture
                        .GetBuffer(
                            &mut data_ptr,
                            &mut frames_available,
                            &mut flags,
                            None,
                            None,
                        )
                        .is_ok()
                    {
                        let channels = wave_format.nChannels as usize;
                        let total_samples = (frames_available as usize) * channels;

                        if (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data_ptr.is_null() {
                            current_level = 0;
                        } else if is_float {
                            let slice = std::slice::from_raw_parts(data_ptr as *const f32, total_samples);
                            current_level = calculate_f32_rms_level(slice);

                            // Loopback render to playback device
                            if let Some((_, ref render_service)) = render_setup {
                                if let Ok(render_buffer) = render_service.GetBuffer(frames_available) {
                                    std::ptr::copy_nonoverlapping(data_ptr, render_buffer, (frames_available as usize) * (wave_format.nBlockAlign as usize));
                                    let _ = render_service.ReleaseBuffer(frames_available, 0);
                                }
                            }
                        } else {
                            let slice = std::slice::from_raw_parts(data_ptr as *const i16, total_samples);
                            current_level = calculate_i16_rms_level(slice);

                            if let Some((_, ref render_service)) = render_setup {
                                if let Ok(render_buffer) = render_service.GetBuffer(frames_available) {
                                    std::ptr::copy_nonoverlapping(data_ptr, render_buffer, (frames_available as usize) * (wave_format.nBlockAlign as usize));
                                    let _ = render_service.ReleaseBuffer(frames_available, 0);
                                }
                            }
                        }

                        let _ = capture.ReleaseBuffer(frames_available);
                    }

                    packet_length = capture.GetNextPacketSize().unwrap_or(0);
                }

                if last_emit.elapsed() >= Duration::from_millis(40) {
                    let _ = app.emit("mic-test-level", serde_json::json!({ "level": current_level }));
                    last_emit = std::time::Instant::now();
                }

                std::thread::sleep(Duration::from_millis(10));
            }

            let _ = capture_client_audio.Stop();
            if let Some((ref render_client, _)) = render_setup {
                let _ = render_client.Stop();
            }

            CoTaskMemFree(Some(wave_format_ptr as *const _));
            Ok(())
        };

        let result = run();
        if owns_com {
            CoUninitialize();
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculate_f32_rms_handles_silence_and_signal() {
        assert_eq!(calculate_f32_rms_level(&[]), 0);
        assert_eq!(calculate_f32_rms_level(&[0.0; 100]), 0);
        assert_eq!(calculate_f32_rms_level(&[0.0001; 100]), 0);

        let moderate = vec![0.1f32; 100];
        let mod_level = calculate_f32_rms_level(&moderate);
        assert!(mod_level > 10 && mod_level < 60, "moderate level: {mod_level}");

        let loud = vec![0.8f32; 100];
        let loud_level = calculate_f32_rms_level(&loud);
        assert!(loud_level >= 80, "loud level: {loud_level}");
    }

    #[test]
    fn calculate_i16_rms_handles_silence_and_signal() {
        assert_eq!(calculate_i16_rms_level(&[]), 0);
        assert_eq!(calculate_i16_rms_level(&[0; 100]), 0);

        let moderate = vec![i16::MAX / 10; 100];
        let mod_level = calculate_i16_rms_level(&moderate);
        assert!(mod_level > 10 && mod_level < 60, "mod_level: {mod_level}");

        let loud = vec![i16::MAX / 2; 100];
        let loud_level = calculate_i16_rms_level(&loud);
        assert!(loud_level >= 80, "loud_level: {loud_level}");
    }

    #[test]
    fn state_transitions_are_safe() {
        stop();
        assert!(!is_running());
        RUNNING.store(true, Ordering::SeqCst);
        assert!(is_running());
        stop();
        assert!(!is_running());
    }
}
