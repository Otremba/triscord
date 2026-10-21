use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::Emitter;

pub type Shared = Arc<Mutex<Model>>;

#[derive(Default)]
pub struct Model {
    pub revision: u64,
    pub generation: u64,
    pub account: Option<Value>,
    pub servers: Vec<Value>,
    pub selected_server: String,
    pub rooms: Vec<Value>,
    pub text_room: Option<String>,
    pub chat: Vec<Value>,
    pub connection: &'static str,
    pub voice_requested: bool,
    pub desired_room: Option<String>,
    pub voice_state: String,
    pub muted: bool,
    pub deafened: bool,
    pub server_muted: bool,
    pub preferences: crate::settings::Preferences,
    pub input_devices: Vec<Value>,
    pub output_devices: Vec<Value>,
    pub signing_in: bool,
    pub profile: Option<Value>,
    pub screen_requested: bool,
    pub sharing: bool,
    pub screen_epoch: u64,
    pub screen_admitting: bool,
    pub user_state_notify: std::sync::Arc<tokio::sync::Notify>,
}

impl Model {
    pub fn snapshot(&mut self) -> Value {
        self.revision += 1;
        let account = self.account.as_ref();
        let account_id = account.and_then(|a| a["id"].as_str()).unwrap_or("");
        let nick = account
            .and_then(|a| a["nick"].as_str())
            .unwrap_or("Visitante");
        json!({ "v": 1, "type": "snapshot", "revision": self.revision, "session": {
            "runtime": { "name": "tauri", "preview": true, "voice": true, "screen": false, "camera": false, "googleLogin": crate::oauth::configured(), "screenAudio":false },
            "voiceState": if self.voice_state.is_empty() {"idle"} else {&self.voice_state}, "voiceRequested":self.voice_requested,
            "sharing":self.sharing,
            "settings":self.preferences.snapshot(&self.input_devices,&self.output_devices),
            "profile":self.profile,
            "account": { "id": account_id, "displayName": self.profile.as_ref().and_then(|p|p["display_name"].as_str()).filter(|s|!s.is_empty()).unwrap_or(nick), "username": nick, "avatarUrl":self.profile.as_ref().and_then(|p|p["avatarDataUrl"].as_str()).unwrap_or_default(), "status": if account.is_some() { "online" } else { "offline" } },
            "auth": { "state": if self.signing_in {"signingIn"} else if account.is_some() && nick.is_empty() {"needsNick"} else if account.is_some() { "signedIn" } else { "signedOut" } },
            "servers": self.servers.iter().map(|s| json!({"id": s["id"], "name": s["name"], "owned": s["ownerAccountId"].as_str() == Some(account_id)})).collect::<Vec<_>>(),
            "selectedServerId": self.selected_server,
            "categories": [], "rooms": self.rooms,
            "textRoomId": self.text_room,
            "chat": self.chat.iter().map(|m| json!({ "id":m["id"], "authorId":m["senderUserId"], "authorName":m["senderName"], "text":m["text"], "timestamp":m["timestamp"], "own":m["senderUserId"].as_str()==Some(account_id), "reactions":[] })).collect::<Vec<_>>(),
            "connection": if self.connection.is_empty() { "offline" } else { self.connection },
            "muted": self.muted || self.server_muted || self.deafened, "deafened": self.deafened
        }})
    }
    pub fn reset_connection(&mut self) -> u64 {
        self.screen_requested = false;
        self.screen_admitting = false;
        self.sharing = false;
        self.screen_epoch += 1;
        self.generation += 1;
        self.connection = "offline";
        self.rooms.clear();
        self.text_room = None;
        self.chat.clear();
        self.voice_requested = false;
        self.desired_room = None;
        self.voice_state = "idle".into();
        self.server_muted = false;
        self.generation
    }
    pub fn update(&mut self, generation: u64, event: &str, payload: Value) -> bool {
        if self.generation != generation {
            return false;
        }
        match event {
            "rooms-update" => {
                self.rooms = payload
                    .as_array()
                    .into_iter()
                    .flatten()
                    .take(100)
                    .filter(|r| r["id"].is_string() && r["name"].is_string())
                    .map(|r| json!({"id":r["id"], "name":r["name"], "userCount":r["userCount"]}))
                    .collect();
            }
            "room-joined" => {
                let Some(id) = payload["roomId"].as_str() else {
                    return false;
                };
                self.text_room = Some(id.to_owned());
                self.server_muted = payload["isServerMuted"].as_bool().unwrap_or(false);
                self.chat = payload["chatHistory"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|m| valid_chat(m) && m["roomId"].as_str() == Some(id))
                    .rev()
                    .take(200)
                    .cloned()
                    .collect();
                self.chat.reverse();
            }
            "new-chat-message"
                if valid_chat(&payload)
                    && payload["roomId"].as_str() == self.text_room.as_deref() =>
            {
                if self.chat.iter().any(|m| m["id"] == payload["id"]) {
                    return false;
                }
                self.chat.push(payload);
                if self.chat.len() > 200 {
                    self.chat.remove(0);
                }
            }
            "chat-message-deleted" if payload["roomId"].as_str() == self.text_room.as_deref() => {
                self.chat.retain(|m| m["id"] != payload["messageId"]);
            }
            "force-muted" => {
                self.server_muted = payload["muted"].as_bool().unwrap_or(true);
            }
            "kicked" => {
                self.text_room = None;
                self.chat.clear();
                self.voice_requested = false;
                self.desired_room = None;
            }
            _ => return false,
        }
        true
    }
}
fn valid_chat(value: &Value) -> bool {
    value["id"].as_str().is_some_and(|v| v.len() <= 64)
        && value["senderUserId"].is_string()
        && value["senderName"].is_string()
        && value["text"]
            .as_str()
            .is_some_and(|v| v.chars().count() <= 2000)
        && value["timestamp"].is_number()
}
pub fn publish(app: &tauri::AppHandle, model: &Shared) {
    // Hold the lock through emit so concurrent producers cannot deliver revisions backwards.
    let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
    let snapshot = model.snapshot();
    let _ = app.emit("triscord-core", snapshot);
}
pub fn notice(app: &tauri::AppHandle, message: &str) {
    let _ = app.emit("triscord-notice", message);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(id: usize, room: &str) -> Value {
        json!({"id":id.to_string(),"roomId":room,"senderUserId":"u","senderName":"User","text":"hello","timestamp":1})
    }
    #[test]
    fn old_connection_cannot_overwrite_new_session() {
        let mut model = Model::default();
        let old = model.reset_connection();
        let new = model.reset_connection();
        assert!(!model.update(old, "room-joined", json!({"roomId":"old"})));
        assert!(model.update(new, "room-joined", json!({"roomId":"new"})));
        assert_eq!(model.text_room.as_deref(), Some("new"));
    }
    #[test]
    fn chat_is_bounded_deduplicated_and_scoped_to_room() {
        let mut model = Model {
            text_room: Some("a".into()),
            ..Default::default()
        };
        for id in 0..250 {
            model.update(0, "new-chat-message", message(id, "a"));
        }
        assert_eq!(model.chat.len(), 200);
        assert!(!model.update(0, "new-chat-message", message(249, "a")));
        assert!(!model.update(0, "new-chat-message", message(300, "b")));
        assert_eq!(model.chat[0]["id"], "50");
    }
    #[test]
    fn snapshots_exclude_auth_and_media_credentials() {
        let mut model = Model {
            account: Some(json!({"id":"u","nick":"Nick","email":"private","session":"secret"})),
            ..Default::default()
        };
        model.update(
            0,
            "room-joined",
            json!({"roomId":"a","media":{"token":"secret-media"}}),
        );
        let snapshot = model.snapshot().to_string();
        assert!(!snapshot.contains("secret"));
        assert!(!snapshot.contains("private"));
        assert!(snapshot.contains("\"screen\":false"));
    }
}
