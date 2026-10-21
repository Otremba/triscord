use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallSound {
    Join,
    Leave,
    Mute,
    Unmute,
    Deafen,
    Undeafen,
}

const JOIN_WAV: &[u8] = include_bytes!("../../../desktop/assets/call-sounds/join.wav");
const LEAVE_WAV: &[u8] = include_bytes!("../../../desktop/assets/call-sounds/leave.wav");
const MUTE_WAV: &[u8] = include_bytes!("../../../desktop/assets/call-sounds/mute.wav");
const UNMUTE_WAV: &[u8] = include_bytes!("../../../desktop/assets/call-sounds/unmute.wav");

/// Returns the bundled soundboard catalog for Triscord.
pub fn catalog() -> Vec<Value> {
    let mut items = vec![
        json!({"id": "quack", "name": "Quack", "emoji": "🦆"}),
        json!({"id": "airhorn", "name": "Airhorn", "emoji": "📢"}),
        json!({"id": "applause", "name": "Palmas", "emoji": "👏"}),
        json!({"id": "crickets", "name": "Grilos", "emoji": "🦗"}),
        json!({"id": "badumtss", "name": "Ba-dum-tss", "emoji": "🥁"}),
    ];
    if let Ok(server_sounds) = serde_json::from_str::<Vec<Value>>(include_str!("../../../shared/soundboard_catalog.json")) {
        for s in server_sounds {
            if !items.iter().any(|i| i["id"] == s["id"]) {
                items.push(s);
            }
        }
    }
    items
}

/// Synthesizes a clean audio tone buffer (48kHz, mono, 16-bit PCM) with smooth attack/decay envelope.
pub fn synthesize_tone(frequency_hz: f32, duration_ms: u32, volume_percent: u8) -> Vec<i16> {
    let sample_rate = 48000;
    let total_samples = (sample_rate as f32 * (duration_ms as f32 / 1000.0)) as usize;
    let volume = (volume_percent.min(100) as f32) / 100.0;
    let attack_samples = (sample_rate as f32 * 0.01) as usize; // 10ms attack
    let decay_samples = (sample_rate as f32 * 0.02) as usize; // 20ms decay

    let mut buffer = Vec::with_capacity(total_samples);
    for i in 0..total_samples {
        let envelope = if i < attack_samples {
            i as f32 / attack_samples as f32
        } else if i + decay_samples > total_samples {
            (total_samples - i) as f32 / decay_samples as f32
        } else {
            1.0
        };

        let t = i as f32 / sample_rate as f32;
        let sample = (t * frequency_hz * 2.0 * std::f32::consts::PI).sin();
        let scaled = (sample * envelope * volume * i16::MAX as f32) as i16;
        buffer.push(scaled);
    }
    buffer
}

/// Packs 16-bit PCM audio samples into a standard 44-byte RIFF/WAVE memory container.
pub fn pcm_to_wav(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let data_len = (samples.len() * 2) as u32;
    let mut wav = Vec::with_capacity(44 + samples.len() * 2);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_len).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&channels.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&byte_rate.to_le_bytes());
    wav.extend_from_slice(&block_align.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&data_len.to_le_bytes());
    for &sample in samples {
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    wav
}

#[cfg(windows)]
fn is_injected_audio() -> bool {
    std::env::var("TRISCORD_AUDIO_MODE").as_deref() == Ok("injected")
}

#[cfg(windows)]
pub fn play_wav_bytes(bytes: &'static [u8]) {
    if is_injected_audio() {
        return;
    }
    unsafe {
        #[link(name = "winmm")]
        extern "system" {
            fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
        }
        // SND_MEMORY (0x4) | SND_ASYNC (0x1) | SND_NODEFAULT (0x2)
        PlaySoundW(bytes.as_ptr() as *const u16, 0, 0x0004 | 0x0001 | 0x0002);
    }
}

#[cfg(not(windows))]
pub fn play_wav_bytes(_bytes: &'static [u8]) {}

pub fn play_dynamic_wav(wav: Vec<u8>) {
    #[cfg(windows)]
    {
        if is_injected_audio() {
            return;
        }
        std::thread::spawn(move || {
            unsafe {
                #[link(name = "winmm")]
                extern "system" {
                    fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
                }
                // SND_MEMORY (0x4) | SND_SYNC (0x0) | SND_NODEFAULT (0x2)
                PlaySoundW(wav.as_ptr() as *const u16, 0, 0x0004 | 0x0000 | 0x0002);
            }
        });
    }
}

pub fn stop_playback() {
    #[cfg(windows)]
    {
        if is_injected_audio() {
            return;
        }
        unsafe {
            #[link(name = "winmm")]
            extern "system" {
                fn PlaySoundW(pszSound: *const u16, hmod: usize, fdwSound: u32) -> i32;
            }
            // SND_PURGE (0x40)
            PlaySoundW(std::ptr::null(), 0, 0x0040);
        }
    }
}

pub fn play_cue(cue: CallSound) {
    match cue {
        CallSound::Join => play_wav_bytes(JOIN_WAV),
        CallSound::Leave => play_wav_bytes(LEAVE_WAV),
        CallSound::Mute => play_wav_bytes(MUTE_WAV),
        CallSound::Unmute => play_wav_bytes(UNMUTE_WAV),
        CallSound::Deafen => {
            let pcm = synthesize_tone(350.0, 140, 75);
            play_dynamic_wav(pcm_to_wav(&pcm, 48000, 1));
        }
        CallSound::Undeafen => {
            let pcm = synthesize_tone(550.0, 140, 75);
            play_dynamic_wav(pcm_to_wav(&pcm, 48000, 1));
        }
    }
}

pub fn play_sound(sound_id: &str) {
    let (freq, duration, volume) = match sound_id {
        "quack" => (320.0, 200, 90),
        "airhorn" => (466.0, 300, 95),
        "applause" => (600.0, 250, 80),
        "crickets" => (800.0, 150, 70),
        "badumtss" => (220.0, 350, 90),
        _ => {
            let hash = sound_id.bytes().fold(0u32, |acc, b| acc.wrapping_add(b as u32));
            let f = 300.0 + (hash % 600) as f32;
            (f, 250, 85)
        }
    };
    let pcm = synthesize_tone(freq, duration, volume);
    play_dynamic_wav(pcm_to_wav(&pcm, 48000, 1));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_bounded_and_contains_standard_sounds() {
        let sounds = catalog();
        assert!(!sounds.is_empty());
        assert!(sounds.len() <= 64);
        assert!(sounds.iter().any(|s| s["id"] == "quack"));
        assert!(sounds.iter().any(|s| s["id"] == "airhorn"));
    }

    #[test]
    fn tone_generation_matches_duration_and_sample_rate() {
        let pcm = synthesize_tone(440.0, 100, 80);
        assert_eq!(pcm.len(), 4800);
        assert!(pcm.iter().any(|&s| s != 0));
        assert!(pcm.iter().all(|&s| s <= (i16::MAX as f32 * 0.81) as i16));
    }

    #[test]
    fn zero_volume_produces_silence() {
        let pcm = synthesize_tone(440.0, 50, 0);
        assert_eq!(pcm.len(), 2400);
        assert!(pcm.iter().all(|&s| s == 0));
    }

    #[test]
    fn catalog_items_contain_required_metadata() {
        let sounds = catalog();
        for item in sounds {
            assert!(item.get("id").and_then(|v| v.as_str()).is_some());
            assert!(item.get("name").and_then(|v| v.as_str()).is_some());
        }
    }

    #[test]
    fn synthesize_tone_zero_duration_is_empty() {
        let pcm = synthesize_tone(440.0, 0, 100);
        assert!(pcm.is_empty());
    }

    #[test]
    fn envelope_smooths_first_and_last_sample() {
        let pcm = synthesize_tone(880.0, 100, 100);
        assert!(!pcm.is_empty());
        assert_eq!(pcm[0], 0);
    }

    #[test]
    fn pcm_to_wav_header_is_valid() {
        let pcm = synthesize_tone(440.0, 50, 80);
        let wav = pcm_to_wav(&pcm, 48000, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(wav.len(), 44 + pcm.len() * 2);
    }
}
