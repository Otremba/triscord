use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    path::PathBuf,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub noise_suppression: bool,
    pub automatic_gain_control: bool,
    pub input_device: String,
    pub output_device: String,
    pub theme: String,
    pub share_hd: bool,
    pub share_mode: String,
    /// "Status personalizado" of the account menu, shown to the room and beside the name.
    pub custom_status: String,
    pub input_volume: u32,
    pub output_volume: u32,
    pub soundboard_volume: u32,
    pub noise_suppression_strength: u32,
    pub noise_suppression_mode: String,
    pub call_sounds: bool,
    pub desktop_notifications: bool,
    pub taskbar_alert: bool,
    pub close_to_tray: bool,
    pub start_minimized: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            noise_suppression: true,
            automatic_gain_control: true,
            input_device: String::new(),
            output_device: String::new(),
            theme: "darker".into(),
            share_hd: false,
            share_mode: "game".into(),
            custom_status: String::new(),
            input_volume: 100,
            output_volume: 100,
            soundboard_volume: 70,
            noise_suppression_strength: 100,
            noise_suppression_mode: "high".into(),
            call_sounds: true,
            desktop_notifications: true,
            taskbar_alert: true,
            close_to_tray: true,
            start_minimized: false,
        }
    }
}
fn boolean(value: &Value) -> Result<bool> {
    value.as_bool().ok_or_else(Error::invalid)
}
fn percent(value: &Value, max: u32) -> Result<u32> {
    value
        .as_f64()
        .filter(|n| n.fract() == 0. && (0. ..=max as f64).contains(n))
        .map(|n| n as u32)
        .ok_or_else(Error::invalid)
}
impl Preferences {
    pub fn set_status(&mut self, text: &str) -> Result<()> {
        let text = text.trim();
        if text.chars().count() > 64 || text.contains('\0') {
            return Err(Error::invalid());
        }
        self.custom_status = text.to_owned();
        Ok(())
    }
    pub fn set(&mut self, key: &str, value: Value) -> Result<()> {
        match key {
            "shareHd" => self.share_hd = boolean(&value)?,
            "shareMode" => {
                self.share_mode = value
                    .as_str()
                    .filter(|mode| ["game", "screen"].contains(mode))
                    .ok_or_else(Error::invalid)?
                    .to_owned()
            }
            // The screen's own audio is not ported yet; keeping it off is the only state this core can honour.
            "shareAudio" if value == false => {}
            "noiseSuppression" => self.noise_suppression = boolean(&value)?,
            "automaticGainControl" => self.automatic_gain_control = boolean(&value)?,
            "callSounds" => self.call_sounds = boolean(&value)?,
            "desktopNotifications" => self.desktop_notifications = boolean(&value)?,
            "taskbarAlert" => self.taskbar_alert = boolean(&value)?,
            "closeToTray" => self.close_to_tray = boolean(&value)?,
            "startMinimized" => self.start_minimized = boolean(&value)?,
            "inputVolume" => self.input_volume = percent(&value, 100)?,
            "outputVolume" => self.output_volume = percent(&value, 200)?,
            "soundboardVolume" => self.soundboard_volume = percent(&value, 100)?,
            "noiseSuppressionStrength" => self.noise_suppression_strength = percent(&value, 100)?,
            "noiseSuppressionMode" => {
                self.noise_suppression_mode = value
                    .as_str()
                    .filter(|mode| ["standard", "high"].contains(mode))
                    .ok_or_else(Error::invalid)?
                    .to_owned()
            }
            "inputDevice" | "outputDevice" => {
                let id = value
                    .as_str()
                    .filter(|s| s.len() <= 512 && !s.contains('\0'))
                    .ok_or_else(Error::invalid)?
                    .to_owned();
                if key == "inputDevice" {
                    self.input_device = id;
                } else {
                    self.output_device = id;
                }
            }
            "theme" => {
                self.theme = value
                    .as_str()
                    .filter(|s| ["light", "dark", "darker", "midnight", "cotton-candy"].contains(s))
                    .ok_or_else(Error::invalid)?
                    .to_owned()
            }
            _ => return Err(Error::unsupported()),
        }
        Ok(())
    }
    /// The settings page's state. Fields for features this core does not have yet (camera, start with Windows, the log
    /// upload) say so, and the page leaves their controls out or disabled.
    pub fn snapshot(&self, inputs: &[Value], outputs: &[Value]) -> Value {
        json!({"inputDevices":inputs,"outputDevices":outputs,"cameraDevices":[],"inputDevice":self.input_device,"outputDevice":self.output_device,"cameraDevice":"",
            "inputVolume":self.input_volume,"outputVolume":self.output_volume,"soundboardVolume":self.soundboard_volume,
            "noiseSuppression":self.noise_suppression,"noiseSuppressionStrength":self.noise_suppression_strength,
            "noiseSuppressionMode":self.noise_suppression_mode,"noiseSuppressionHighAvailable":false,
            "automaticGainControl":self.automatic_gain_control,"theme":self.theme,"callSounds":self.call_sounds,
            "desktopNotifications":self.desktop_notifications,"taskbarAlert":self.taskbar_alert,
            "closeToTray":self.close_to_tray,"startMinimized":self.start_minimized,"openAtLogin":false,"loginSupported":false,
            "errorReports":false,"errorReportsAvailable":false,
            "shareMode":self.share_mode,"shareHd":self.share_hd,"shareAudio":false})
    }
}
pub struct Store {
    path: PathBuf,
    accounts: BTreeMap<String, Preferences>,
}
impl Store {
    pub fn new(directory: PathBuf) -> Result<Self> {
        let path = directory.join("preferences.json");
        let accounts = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut data = Vec::new();
                file.take(262145)
                    .read_to_end(&mut data)
                    .map_err(|_| Error::storage())?;
                if data.len() > 262144 {
                    return Err(Error::storage());
                }
                serde_json::from_slice(&data).map_err(|_| Error::storage())?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(_) => return Err(Error::storage()),
        };
        Ok(Self { path, accounts })
    }
    pub fn account(&self, id: &str) -> Preferences {
        self.accounts.get(id).cloned().unwrap_or_default()
    }
    pub fn save(&mut self, id: String, preferences: Preferences) -> Result<()> {
        let mut accounts = self.accounts.clone();
        accounts.insert(id, preferences);
        let bytes = serde_json::to_vec(&accounts).map_err(|_| Error::storage())?;
        if bytes.len() > 262144 {
            return Err(Error::storage());
        }
        let parent = self.path.parent().ok_or_else(Error::storage)?;
        std::fs::create_dir_all(parent).map_err(|_| Error::storage())?;
        let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::storage())?;
        file.write_all(&bytes).map_err(|_| Error::storage())?;
        file.as_file().sync_all().map_err(|_| Error::storage())?;
        file.persist(&self.path).map_err(|_| Error::storage())?;
        self.accounts = accounts;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_preferences_survive_restart_without_crossing_accounts() {
        let directory = tempfile::tempdir().unwrap();
        let mut store = Store::new(directory.path().to_path_buf()).unwrap();
        let mut preferences = Preferences::default();
        preferences.set("noiseSuppression", json!(false)).unwrap();
        preferences.set("outputVolume", json!(150)).unwrap();
        preferences.set_status("jogando").unwrap();
        store.save("alice".into(), preferences).unwrap();
        let restored = Store::new(directory.path().to_path_buf()).unwrap();
        assert!(!restored.account("alice").noise_suppression);
        assert_eq!(restored.account("alice").output_volume, 150);
        assert_eq!(restored.account("alice").custom_status, "jogando");
        assert!(restored.account("bob").noise_suppression);
        assert!(restored.account("bob").custom_status.is_empty());
    }
    #[test]
    fn preferences_written_by_an_older_preview_still_load() {
        let old: Preferences = serde_json::from_value(json!({"noiseSuppression":false,"theme":"dark"})).unwrap();
        assert!(!old.noise_suppression);
        assert_eq!(old.theme, "dark");
        assert_eq!((old.input_volume, old.output_volume, old.soundboard_volume), (100, 100, 70));
        assert!(old.close_to_tray && old.call_sounds);
    }
    #[test]
    fn settings_reject_unknown_keys_and_invalid_values() {
        let mut preferences = Preferences::default();
        assert!(preferences.set("mediaUrl", json!("wss://evil")).is_err());
        assert!(preferences.set("noiseSuppression", json!("false")).is_err());
        assert!(preferences.set("theme", json!("invalid")).is_err());
        assert!(preferences.set("shareAudio", json!(true)).is_err());
        assert!(preferences.set("shareAudio", json!(false)).is_ok());
    }
    #[test]
    fn volumes_are_whole_numbers_inside_their_ranges() {
        let mut preferences = Preferences::default();
        assert!(preferences.set("inputVolume", json!(100)).is_ok());
        assert!(preferences.set("inputVolume", json!(101)).is_err());
        assert!(preferences.set("inputVolume", json!(-1)).is_err());
        assert!(preferences.set("inputVolume", json!(50.5)).is_err());
        assert!(preferences.set("outputVolume", json!(200)).is_ok());
        assert!(preferences.set("outputVolume", json!(201)).is_err());
        assert!(preferences.set("noiseSuppressionMode", json!("standard")).is_ok());
        assert!(preferences.set("noiseSuppressionMode", json!("ultra")).is_err());
    }
    #[test]
    fn status_is_trimmed_and_bounded() {
        let mut preferences = Preferences::default();
        preferences.set_status("  na call  ").unwrap();
        assert_eq!(preferences.custom_status, "na call");
        assert!(preferences.set_status(&"x".repeat(65)).is_err());
        assert!(preferences.set_status("a\0b").is_err());
        preferences.set_status("").unwrap();
        assert!(preferences.custom_status.is_empty());
    }
    #[test]
    fn the_settings_page_gets_every_field_it_reads() {
        let page = Preferences::default().snapshot(&[], &[]);
        for key in [
            "inputDevices", "outputDevices", "cameraDevices", "inputDevice", "outputDevice", "cameraDevice", "inputVolume", "outputVolume",
            "noiseSuppression", "automaticGainControl", "desktopNotifications", "taskbarAlert", "soundboardVolume", "theme", "shareMode",
            "shareHd", "shareAudio",
        ] {
            assert!(page.get(key).is_some(), "missing {key}");
        }
    }
    #[test]
    fn all_valid_themes_can_be_set_and_invalid_themes_rejected() {
        let mut preferences = Preferences::default();
        for theme in ["light", "dark", "darker", "midnight", "cotton-candy"] {
            assert!(preferences.set("theme", json!(theme)).is_ok());
            assert_eq!(preferences.theme, theme);
        }
        assert!(preferences.set("theme", json!("neon")).is_err());
        assert!(preferences.set("theme", json!("")).is_err());
        assert!(preferences.set("theme", json!(123)).is_err());
    }
    #[test]
    fn all_boolean_preference_toggles_accept_booleans_only() {
        let mut preferences = Preferences::default();
        for key in [
            "shareHd", "noiseSuppression", "automaticGainControl", "callSounds",
            "desktopNotifications", "taskbarAlert", "closeToTray", "startMinimized",
        ] {
            assert!(preferences.set(key, json!(true)).is_ok(), "{key} should accept true");
            assert!(preferences.set(key, json!(false)).is_ok(), "{key} should accept false");
            assert!(preferences.set(key, json!("true")).is_err(), "{key} should reject string");
            assert!(preferences.set(key, json!(1)).is_err(), "{key} should reject int");
        }
    }
    #[test]
    fn soundboard_and_noise_strength_volumes_are_bounded_zero_to_hundred() {
        let mut preferences = Preferences::default();
        assert!(preferences.set("soundboardVolume", json!(0)).is_ok());
        assert!(preferences.set("soundboardVolume", json!(100)).is_ok());
        assert!(preferences.set("soundboardVolume", json!(101)).is_err());
        assert!(preferences.set("soundboardVolume", json!(-1)).is_err());

        assert!(preferences.set("noiseSuppressionStrength", json!(0)).is_ok());
        assert!(preferences.set("noiseSuppressionStrength", json!(100)).is_ok());
        assert!(preferences.set("noiseSuppressionStrength", json!(101)).is_err());
    }
    #[test]
    fn device_id_selection_sanitizes_id() {
        let mut preferences = Preferences::default();
        assert!(preferences.set("inputDevice", json!("mic-default-guid-123")).is_ok());
        assert_eq!(preferences.input_device, "mic-default-guid-123");
        assert!(preferences.set("outputDevice", json!("speaker-guid-456")).is_ok());
        assert_eq!(preferences.output_device, "speaker-guid-456");

        // Reject null bytes and oversize
        assert!(preferences.set("inputDevice", json!("mic\0evil")).is_err());
        assert!(preferences.set("inputDevice", json!("x".repeat(513))).is_err());
    }
}
