use crate::error::{Error, Result};

/// Configuration for WASAPI Process-Loopback audio capture.
/// Captures audio specifically emitted by a target game/application process tree.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopbackConfig {
    pub target_pid: u32,
    pub sample_rate: u32,
    pub channels: u16,
}

#[allow(dead_code)]
impl LoopbackConfig {
    pub fn new(target_pid: u32, sample_rate: u32, channels: u16) -> Result<Self> {
        if target_pid == 0 || target_pid == std::process::id() {
            return Err(Error::invalid());
        }
        if !(8000..=192000).contains(&sample_rate) {
            return Err(Error::invalid());
        }
        if channels != 1 && channels != 2 {
            return Err(Error::invalid());
        }
        Ok(Self {
            target_pid,
            sample_rate,
            channels,
        })
    }
}

/// Converts interleaved 32-bit float PCM samples into normalized 16-bit signed integer PCM.
#[allow(dead_code)]
pub fn float_to_i16_pcm(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|&s| {
            let clamped = s.clamp(-1.0, 1.0);
            if clamped >= 0.0 {
                (clamped * i16::MAX as f32) as i16
            } else {
                (-clamped * i16::MIN as f32) as i16
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_config_validates_pid() {
        assert!(LoopbackConfig::new(0, 48000, 2).is_err());
        assert!(LoopbackConfig::new(std::process::id(), 48000, 2).is_err());
        assert!(LoopbackConfig::new(12345, 48000, 2).is_ok());
        assert!(LoopbackConfig::new(12345, 44100, 1).is_ok());
        assert!(LoopbackConfig::new(12345, 1000, 2).is_err());
        assert!(LoopbackConfig::new(12345, 48000, 6).is_err());
    }

    #[test]
    fn audio_samples_clamped_and_interleaved() {
        let input = vec![-2.0, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0];
        let pcm = float_to_i16_pcm(&input);
        assert_eq!(pcm[0], i16::MIN);
        assert_eq!(pcm[1], i16::MIN);
        assert_eq!(pcm[3], 0);
        assert_eq!(pcm[5], i16::MAX);
        assert_eq!(pcm[6], i16::MAX);
    }

    #[test]
    fn float_to_i16_pcm_handles_empty_and_preserves_size() {
        assert!(float_to_i16_pcm(&[]).is_empty());
        let frames = vec![0.1f32; 960];
        assert_eq!(float_to_i16_pcm(&frames).len(), 960);
    }

    #[test]
    fn loopback_config_sample_rate_and_channel_boundaries() {
        // Allowed: 8000..=192000 Hz, 1 or 2 channels
        assert!(LoopbackConfig::new(9999, 8000, 1).is_ok());
        assert!(LoopbackConfig::new(9999, 192000, 2).is_ok());
        assert!(LoopbackConfig::new(9999, 7999, 2).is_err());
        assert!(LoopbackConfig::new(9999, 192001, 2).is_err());
        assert!(LoopbackConfig::new(9999, 48000, 0).is_err());
        assert!(LoopbackConfig::new(9999, 48000, 3).is_err());
    }
}
