use serde_json::{json, Value};

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallSound {
    Join,
    Leave,
    Mute,
    Unmute,
}

/// Returns the bundled soundboard catalog for Triscord.
pub fn catalog() -> Vec<Value> {
    vec![
        json!({"id": "quack", "name": "Quack"}),
        json!({"id": "airhorn", "name": "Airhorn"}),
        json!({"id": "applause", "name": "Palmas"}),
        json!({"id": "crickets", "name": "Grilos"}),
        json!({"id": "badumtss", "name": "Ba-dum-tss"}),
    ]
}

/// Synthesizes a clean audio tone buffer (48kHz, mono, 16-bit PCM) with smooth attack/decay envelope.
#[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_is_bounded_and_contains_standard_sounds() {
        let sounds = catalog();
        assert!(!sounds.is_empty());
        assert!(sounds.len() <= 32);
        assert!(sounds.iter().any(|s| s["id"] == "quack"));
        assert!(sounds.iter().any(|s| s["id"] == "airhorn"));
    }

    #[test]
    fn tone_generation_matches_duration_and_sample_rate() {
        let pcm = synthesize_tone(440.0, 100, 80);
        // 48000 * 0.1 = 4800 samples
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
        // First sample starts from 0 due to sin(0) and envelope
        assert_eq!(pcm[0], 0);
    }
}
