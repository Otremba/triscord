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
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            noise_suppression: true,
            automatic_gain_control: true,
            input_device: String::new(),
            output_device: String::new(),
            theme: "darker".into(),
        }
    }
}
impl Preferences {
    pub fn set(&mut self, key: &str, value: Value) -> Result<()> {
        match key {
            "noiseSuppression" => {
                self.noise_suppression = value.as_bool().ok_or_else(Error::invalid)?
            }
            "automaticGainControl" => {
                self.automatic_gain_control = value.as_bool().ok_or_else(Error::invalid)?
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
    pub fn snapshot(&self, inputs: &[Value], outputs: &[Value]) -> Value {
        json!({"inputDevices":inputs,"outputDevices":outputs,"cameraDevices":[],"inputDevice":self.input_device,"outputDevice":self.output_device,"cameraDevice":"",
            "noiseSuppression":self.noise_suppression,"automaticGainControl":self.automatic_gain_control,"theme":self.theme,
            "inputVolume":100,"outputVolume":100,"soundboardVolume":100,"desktopNotifications":false,"taskbarAlert":false,"shareMode":"game","shareHd":false,"shareAudio":false})
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
        store.save("alice".into(), preferences).unwrap();
        let restored = Store::new(directory.path().to_path_buf()).unwrap();
        assert!(!restored.account("alice").noise_suppression);
        assert!(restored.account("bob").noise_suppression);
    }
    #[test]
    fn settings_reject_unknown_keys_and_invalid_values() {
        let mut preferences = Preferences::default();
        assert!(preferences.set("mediaUrl", json!("wss://evil")).is_err());
        assert!(preferences.set("noiseSuppression", json!("false")).is_err());
        assert!(preferences.set("theme", json!("invalid")).is_err());
    }
}
