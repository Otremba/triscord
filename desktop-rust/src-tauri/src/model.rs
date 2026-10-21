use serde_json::{json, Value};
use std::collections::HashSet;
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
    /// Rooms of the shown server, from the hub's `rooms-update`: id, name, owner and the users in each room.
    pub rooms: Vec<Value>,
    /// Order in which each room was first seen: the hub lists rooms in its map order, which moves when a room is saved.
    pub room_order: Vec<String>,
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
    /// Name of what is being shared (the voice panel's stream row).
    pub sharing_name: String,
    pub screen_epoch: u64,
    pub screen_admitting: bool,
    pub user_state_notify: std::sync::Arc<tokio::sync::Notify>,
    pub membership_epoch: u64,
    pub streams: Vec<Value>,
    /// The hub's id for this connection: how the room's user list says which row is ours.
    pub self_socket: String,
    /// Hub socket ids heard speaking in the call (LiveKit active speakers).
    pub speaking: HashSet<String>,
    /// Milliseconds since the epoch when the current room was joined (the call timer); 0 outside a room.
    pub connected_at: u64,
    pub call_fullscreen: bool,
    pub call_focus: Option<Value>,
    /// Hub socket ids this user silenced for themselves (`localMuted`); their audio track is disabled, not unsubscribed.
    pub peer_muted: HashSet<String>,
}

fn truncate(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}
fn flag(value: &Value, key: &str) -> bool {
    value[key].as_bool().unwrap_or(false)
}
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// Only what the interface shows about a person in a room; everything else the hub sends stays here.
fn clean_user(user: &Value) -> Option<Value> {
    let socket = user["socketId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 64)?;
    Some(json!({
        "socketId": socket,
        "userId": truncate(user["userId"].as_str().unwrap_or_default(), 128),
        "username": truncate(user["username"].as_str().unwrap_or_default(), 64),
        "authenticated": flag(user, "authenticated"),
        "status": truncate(user["status"].as_str().unwrap_or_default(), 64),
        "isMuted": flag(user, "isMuted"), "isDeafened": flag(user, "isDeafened"), "isServerMuted": flag(user, "isServerMuted"),
        "isCameraOn": flag(user, "isCameraOn"), "isScreenSharing": flag(user, "isScreenSharing"),
    }))
}
fn clean_room(room: &Value) -> Option<Value> {
    let id = room["id"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 64)?;
    let name = room["name"].as_str()?;
    let users: Vec<Value> = room["users"]
        .as_array()
        .into_iter()
        .flatten()
        .take(32)
        .filter_map(clean_user)
        .collect();
    Some(json!({
        "id": id, "name": truncate(name, 64), "userCount": users.len(),
        "ownerUserId": truncate(room["ownerUserId"].as_str().unwrap_or_default(), 128), "users": users,
    }))
}

impl Model {
    fn account_id(&self) -> &str {
        self.account
            .as_ref()
            .and_then(|a| a["id"].as_str())
            .unwrap_or("")
    }
    /// A room as the interface lists it: the people in it with their live state, and who owns it.
    fn channel(&self, room: &Value) -> Value {
        let mut owner = String::new();
        let users: Vec<Value> = room["users"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|user| {
                let socket = user["socketId"].as_str().unwrap_or_default();
                let is_self = !self.self_socket.is_empty() && socket == self.self_socket;
                let account = user["userId"].as_str().unwrap_or_default();
                let authenticated = flag(user, "authenticated");
                if !room["ownerUserId"].as_str().unwrap_or_default().is_empty()
                    && user["userId"] == room["ownerUserId"]
                {
                    owner = socket.to_owned();
                }
                json!({
                    "id": socket, "name": user["username"], "self": is_self, "profileAvailable": authenticated,
                    "avatarUrl": if is_self { self.profile.as_ref().and_then(|p| p["avatarDataUrl"].as_str()).unwrap_or_default() } else { "" },
                    "accountId": if authenticated { account } else { "" },
                    "localMuted": self.peer_muted.contains(socket), "volume": 100, "pan": 0, "streamVolume": 100, "streamMuted": false,
                    "muted": flag(user, "isMuted"), "deafened": flag(user, "isDeafened"),
                    "customStatus": user["status"], "speaking": self.speaking.contains(socket),
                    "camera": flag(user, "isCameraOn"), "live": flag(user, "isScreenSharing") || (is_self && self.sharing),
                    "serverMuted": flag(user, "isServerMuted"),
                })
            })
            .collect();
        let mut channel = json!({"id": room["id"], "name": room["name"], "kind": "voice", "users": users});
        if !owner.is_empty() {
            channel["ownerId"] = json!(owner);
        }
        channel
    }
    fn chat_message(&self, message: &Value, me: &str) -> Value {
        let reactions: Vec<Value> = message["reactions"]
            .as_object()
            .into_iter()
            .flatten()
            .filter_map(|(emoji, users)| {
                let users = users.as_array()?;
                Some(json!({"emoji": emoji, "count": users.len(), "me": users.iter().any(|u| u.as_str() == Some(me))}))
            })
            .take(32)
            .collect();
        json!({
            "id": message["id"], "authorId": message["senderUserId"], "authorName": message["senderName"], "text": message["text"],
            "timestamp": message["timestamp"], "own": message["senderUserId"].as_str() == Some(me), "reactions": reactions,
        })
    }
    pub fn snapshot(&mut self) -> Value {
        self.revision += 1;
        let account = self.account.as_ref();
        let account_id = self.account_id().to_owned();
        let nick = account
            .and_then(|a| a["nick"].as_str())
            .unwrap_or("Visitante");
        // A room is "connected" once the hub admitted us with voice wanted; until then the click only selects it.
        let connected_channel = if self.voice_requested { self.text_room.clone() } else { None };
        let mut rooms: Vec<&Value> = self.rooms.iter().collect();
        rooms.sort_by_key(|room| {
            self.room_order
                .iter()
                .position(|id| room["id"].as_str() == Some(id))
                .unwrap_or(usize::MAX)
        });
        let channels: Vec<Value> = rooms.iter().map(|room| self.channel(room)).collect();
        let call_channel = connected_channel
            .as_deref()
            .and_then(|id| self.rooms.iter().find(|room| room["id"].as_str() == Some(id)))
            .map(|room| self.channel(room));
        let custom_status = self.preferences.custom_status.clone();
        let display_name = self
            .profile
            .as_ref()
            .and_then(|p| p["display_name"].as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(nick);
        let mut session = json!({
            "runtime": { "name": "tauri", "preview": false, "voice": true, "screen": true, "camera": false, "googleLogin": crate::oauth::configured(),
                "screenAudio": true, "soundboard": true, "popout": false },
            "soundboard": crate::sound::catalog(),
            "voiceState": if self.voice_state.is_empty() {"idle"} else {&self.voice_state}, "voiceRequested": self.voice_requested,
            "sharing": self.sharing, "sharingName": self.sharing_name,
            "streams": self.streams,
            "callFocus": self.call_focus,
            "settings": self.preferences.snapshot(&self.input_devices, &self.output_devices),
            "profile": self.profile,
            "account": { "id": account_id, "displayName": display_name, "username": nick,
                "avatarUrl": self.profile.as_ref().and_then(|p| p["avatarDataUrl"].as_str()).unwrap_or_default(),
                "customStatus": custom_status, "status": if account.is_some() { "online" } else { "offline" } },
            "auth": { "state": if self.signing_in {"signingIn"} else if account.is_some() && nick.is_empty() {"needsNick"} else if account.is_some() { "signedIn" } else { "signedOut" } },
            "servers": self.servers.iter().map(|s| json!({"id": s["id"], "name": s["name"], "owned": s["ownerAccountId"].as_str() == Some(account_id.as_str())})).collect::<Vec<_>>(),
            "selectedServerId": self.selected_server, "callServerId": self.selected_server,
            "categories": [{"id": "voice", "name": "Canais de Voz", "channels": channels}],
            "rooms": self.rooms.iter().map(|r| json!({"id": r["id"], "name": r["name"], "userCount": r["userCount"]})).collect::<Vec<_>>(),
            "textRoomId": self.text_room,
            "selectedChannelId": self.text_room.clone().or_else(|| self.desired_room.clone()).or_else(|| self.rooms.first().and_then(|r| r["id"].as_str()).map(str::to_owned)),
            "chat": self.chat.iter().map(|m| self.chat_message(m, &account_id)).collect::<Vec<_>>(),
            "connection": if self.connection.is_empty() { "offline" } else { self.connection },
            "muted": self.muted || self.server_muted || self.deafened, "deafened": self.deafened,
            "callFullscreen": self.call_fullscreen && connected_channel.is_some(),
        });
        if let Some(id) = connected_channel {
            session["connectedChannelId"] = json!(id);
            if self.connected_at > 0 {
                session["connectedAt"] = json!(self.connected_at);
            }
        }
        if let Some(channel) = call_channel {
            session["callChannel"] = channel;
        }
        json!({ "v": 1, "type": "snapshot", "revision": self.revision, "session": session })
    }
    pub fn reset_connection(&mut self) -> u64 {
        self.membership_epoch += 1;
        self.streams.clear();
        self.screen_requested = false;
        self.screen_admitting = false;
        self.sharing = false;
        self.sharing_name.clear();
        self.screen_epoch += 1;
        self.generation += 1;
        self.connection = "offline";
        self.rooms.clear();
        self.room_order.clear();
        self.text_room = None;
        self.chat.clear();
        self.voice_requested = false;
        self.desired_room = None;
        self.voice_state = "idle".into();
        self.server_muted = false;
        self.self_socket.clear();
        self.speaking.clear();
        self.peer_muted.clear();
        self.connected_at = 0;
        self.call_fullscreen = false;
        self.call_focus = None;
        self.generation
    }
    /// The people LiveKit hears speaking, as hub socket ids. Returns whether anything changed.
    pub fn set_speaking(&mut self, sockets: HashSet<String>) -> bool {
        if self.speaking == sockets {
            return false;
        }
        self.speaking = sockets;
        true
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
                    .filter_map(clean_room)
                    .collect();
                for room in &self.rooms {
                    let id = room["id"].as_str().unwrap_or_default();
                    if !self.room_order.iter().any(|known| known == id) {
                        self.room_order.push(id.to_owned());
                    }
                }
            }
            "user-state-updated" => {
                let Some(socket) = payload["socketId"].as_str() else {
                    return false;
                };
                let state = &payload["state"];
                let mut changed = false;
                for room in self.rooms.iter_mut() {
                    for user in room["users"].as_array_mut().into_iter().flatten() {
                        if user["socketId"].as_str() != Some(socket) {
                            continue;
                        }
                        for key in ["isMuted", "isDeafened", "isServerMuted", "isCameraOn", "isScreenSharing"] {
                            if let Some(value) = state[key].as_bool() {
                                if user[key].as_bool() != Some(value) {
                                    user[key] = json!(value);
                                    changed = true;
                                }
                            }
                        }
                        if let Some(status) = state["status"].as_str() {
                            let status = truncate(status, 64);
                            if user["status"].as_str() != Some(status.as_str()) {
                                user["status"] = json!(status);
                                changed = true;
                            }
                        }
                    }
                }
                return changed;
            }
            "user-left" => {
                let Some(socket) = payload["socketId"].as_str() else {
                    return false;
                };
                return self.speaking.remove(socket);
            }
            "room-joined" => {
                let Some(id) = payload["roomId"].as_str() else {
                    return false;
                };
                self.text_room = Some(id.to_owned());
                self.connected_at = now_ms();
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
            "message-reaction-updated" => {
                let Some(reactions) = payload["reactions"].as_object().filter(|r| r.len() <= 64) else {
                    return false;
                };
                let Some(message) = self.chat.iter_mut().find(|m| m["id"] == payload["messageId"]) else {
                    return false;
                };
                message["reactions"] = Value::Object(reactions.clone());
            }
            "force-muted" => {
                self.server_muted = payload["muted"].as_bool().unwrap_or(true);
            }
            "kicked" => {
                self.membership_epoch += 1;
                self.screen_epoch += 1;
                self.streams.clear();
                self.screen_requested = false;
                self.sharing = false;
                self.sharing_name.clear();
                self.text_room = None;
                self.chat.clear();
                self.voice_requested = false;
                self.desired_room = None;
                self.speaking.clear();
                self.connected_at = 0;
                self.call_fullscreen = false;
                self.call_focus = None;
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
    fn user(socket: &str, account: &str, name: &str) -> Value {
        json!({"socketId":socket,"userId":account,"username":name,"authenticated":true,"status":"","isMuted":false,"isDeafened":false,
            "isServerMuted":false,"isCameraOn":false,"isScreenSharing":false,"avatar":"#5865f2","sessionToken":"secret-token"})
    }
    fn directory() -> Value {
        json!([
            {"id":"geral","name":"Geral","ownerUserId":"acc-a","userCount":2,"users":[user("s1","acc-a","Ana"),user("s2","acc-b","Bia")]},
            {"id":"jogos","name":"Jogos","ownerUserId":"","userCount":0,"users":[]},
        ])
    }
    fn signed_in() -> Model {
        let mut model = Model {
            account: Some(json!({"id":"acc-a","nick":"Ana"})),
            self_socket: "s1".into(),
            selected_server: "srv".into(),
            ..Default::default()
        };
        model.update(0, "rooms-update", directory());
        model
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
        model.update(0, "rooms-update", directory());
        let snapshot = model.snapshot().to_string();
        assert!(!snapshot.contains("secret"), "tokens in the hub's user records never reach the page");
        assert!(!snapshot.contains("private"));
        assert!(snapshot.contains("\"camera\":false"));
    }
    #[test]
    fn rooms_become_a_channel_list_with_who_is_in_each() {
        let mut model = signed_in();
        let snapshot = model.snapshot();
        let channels = &snapshot["session"]["categories"][0]["channels"];
        assert_eq!(channels.as_array().unwrap().len(), 2);
        assert_eq!(channels[0]["id"], "geral");
        assert_eq!(channels[0]["kind"], "voice");
        assert_eq!(channels[0]["ownerId"], "s1", "the owner is the user whose account owns the room");
        let users = channels[0]["users"].as_array().unwrap();
        assert_eq!(users.len(), 2);
        assert_eq!(users[0]["id"], "s1");
        assert_eq!(users[0]["self"], true);
        assert_eq!(users[1]["self"], false);
        assert_eq!(users[1]["accountId"], "acc-b");
        assert!(channels[1].get("ownerId").is_none());
    }
    #[test]
    fn rooms_keep_the_order_they_were_first_seen_in() {
        let mut model = signed_in();
        // The hub saved "Jogos" again and now lists it first.
        let mut swapped = directory();
        swapped.as_array_mut().unwrap().reverse();
        model.update(0, "rooms-update", swapped);
        let snapshot = model.snapshot();
        let channels = &snapshot["session"]["categories"][0]["channels"];
        assert_eq!(channels[0]["id"], "geral");
        assert_eq!(channels[1]["id"], "jogos");
    }
    #[test]
    fn joining_with_voice_marks_the_channel_connected_and_starts_the_timer() {
        let mut model = signed_in();
        model.voice_requested = true;
        model.desired_room = Some("geral".into());
        let pending = model.snapshot();
        assert!(pending["session"].get("connectedChannelId").is_none(), "not connected until the hub admits us");
        assert_eq!(pending["session"]["selectedChannelId"], "geral", "but the click already selects the channel");
        model.update(0, "room-joined", json!({"roomId":"geral","chatHistory":[]}));
        let snapshot = model.snapshot();
        assert_eq!(snapshot["session"]["connectedChannelId"], "geral");
        assert!(snapshot["session"]["connectedAt"].as_u64().unwrap() > 0);
        assert_eq!(snapshot["session"]["callChannel"]["id"], "geral");
        model.voice_requested = false;
        assert!(model.snapshot()["session"].get("connectedChannelId").is_none(), "a chat-only join is not a call");
    }
    #[test]
    fn live_user_state_reaches_the_rows_without_another_rooms_update() {
        let mut model = signed_in();
        assert!(model.update(0, "user-state-updated", json!({"socketId":"s2","state":{"isMuted":true,"isScreenSharing":true,"status":"jogando"}})));
        assert!(!model.update(0, "user-state-updated", json!({"socketId":"s2","state":{"isMuted":true}})), "no change, no publish");
        assert!(!model.update(0, "user-state-updated", json!({"socketId":"nobody","state":{"isMuted":true}})));
        let snapshot = model.snapshot();
        let row = &snapshot["session"]["categories"][0]["channels"][0]["users"][1];
        assert_eq!(row["muted"], true);
        assert_eq!(row["live"], true);
        assert_eq!(row["customStatus"], "jogando");
    }
    #[test]
    fn speaking_follows_livekit_and_clears_when_someone_leaves() {
        let mut model = signed_in();
        assert!(model.set_speaking(["s2".to_string()].into()));
        assert!(!model.set_speaking(["s2".to_string()].into()));
        assert_eq!(model.snapshot()["session"]["categories"][0]["channels"][0]["users"][1]["speaking"], true);
        assert!(model.update(0, "user-left", json!({"socketId":"s2"})));
        assert_eq!(model.snapshot()["session"]["categories"][0]["channels"][0]["users"][1]["speaking"], false);
    }
    #[test]
    fn own_screen_share_marks_the_own_row_live() {
        let mut model = signed_in();
        model.sharing = true;
        let snapshot = model.snapshot();
        assert_eq!(snapshot["session"]["categories"][0]["channels"][0]["users"][0]["live"], true);
        assert_eq!(snapshot["session"]["categories"][0]["channels"][0]["users"][1]["live"], false);
    }
    #[test]
    fn reactions_are_counted_per_emoji_and_know_which_are_ours() {
        let mut model = signed_in();
        model.text_room = Some("geral".into());
        model.update(0, "new-chat-message", message(1, "geral"));
        assert!(model.update(0, "message-reaction-updated", json!({"messageId":"1","reactions":{"👍":["acc-a","acc-b"],"😂":["acc-b"]}})));
        assert!(!model.update(0, "message-reaction-updated", json!({"messageId":"missing","reactions":{}})));
        let snapshot = model.snapshot();
        let reactions = snapshot["session"]["chat"][0]["reactions"].as_array().unwrap();
        let thumbs = reactions.iter().find(|r| r["emoji"] == "👍").unwrap();
        assert_eq!((thumbs["count"].as_u64(), thumbs["me"].as_bool()), (Some(2), Some(true)));
        let laugh = reactions.iter().find(|r| r["emoji"] == "😂").unwrap();
        assert_eq!((laugh["count"].as_u64(), laugh["me"].as_bool()), (Some(1), Some(false)));
    }
    #[test]
    fn leaving_the_connection_forgets_who_we_were() {
        let mut model = signed_in();
        model.set_speaking(["s2".to_string()].into());
        model.connected_at = 5;
        model.reset_connection();
        assert!(model.self_socket.is_empty() && model.speaking.is_empty() && model.rooms.is_empty());
        assert_eq!(model.connected_at, 0);
    }
    #[test]
    fn selected_channel_id_falls_back_to_first_room_when_no_room_is_selected() {
        let mut model = signed_in();
        model.desired_room = None;
        model.text_room = None;
        let snapshot = model.snapshot();
        assert_eq!(
            snapshot["session"]["selectedChannelId"], "geral",
            "must fall back to first room in rooms list, preventing black screen"
        );
    }
    #[test]
    fn server_selection_updates_selected_server_in_snapshot() {
        let mut model = signed_in();
        model.selected_server = "custom-server-42".into();
        let snapshot = model.snapshot();
        assert_eq!(snapshot["session"]["selectedServerId"], "custom-server-42");
    }
    #[test]
    fn chat_message_deletion_removes_target_message_from_history() {
        let mut model = signed_in();
        model.text_room = Some("geral".into());
        model.update(0, "new-chat-message", message(10, "geral"));
        model.update(0, "new-chat-message", message(20, "geral"));
        assert_eq!(model.chat.len(), 2);
        assert!(model.update(
            0,
            "chat-message-deleted",
            json!({"roomId": "geral", "messageId": "10"})
        ));
        assert_eq!(model.chat.len(), 1);
        assert_eq!(model.chat[0]["id"], "20");
        assert!(!model.update(
            0,
            "chat-message-deleted",
            json!({"roomId": "wrong-room", "messageId": "20"})
        ));
    }
    #[test]
    fn multiple_reactions_can_be_updated_and_cleared() {
        let mut model = signed_in();
        model.text_room = Some("geral".into());
        model.update(0, "new-chat-message", message(1, "geral"));
        model.update(
            0,
            "message-reaction-updated",
            json!({"messageId": "1", "reactions": {"🔥": ["acc-a"]}}),
        );
        let snap1 = model.snapshot();
        assert_eq!(snap1["session"]["chat"][0]["reactions"][0]["emoji"], "🔥");
        // Clear reactions
        model.update(
            0,
            "message-reaction-updated",
            json!({"messageId": "1", "reactions": {}}),
        );
        let snap2 = model.snapshot();
        assert_eq!(snap2["session"]["chat"][0]["reactions"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn empty_rooms_update_clears_directory_without_panic() {
        let mut model = signed_in();
        assert!(model.update(0, "rooms-update", json!([])));
        assert!(model.rooms.is_empty());
        let snapshot = model.snapshot();
        assert_eq!(snapshot["session"]["categories"][0]["channels"].as_array().unwrap().len(), 0);
    }
    #[test]
    fn peer_muted_state_tracks_and_clears_per_socket() {
        let mut model = signed_in();
        assert!(!model.peer_muted.contains("s2"));
        model.peer_muted.insert("s2".into());
        assert!(model.peer_muted.contains("s2"));
        model.peer_muted.remove("s2");
        assert!(!model.peer_muted.contains("s2"));
    }
    #[test]
    fn custom_status_updates_on_user_state_change() {
        let mut model = signed_in();
        model.update(
            0,
            "user-state-updated",
            json!({"socketId": "s2", "state": {"status": "ouvindo musica"}}),
        );
        let snap = model.snapshot();
        let s2 = &snap["session"]["categories"][0]["channels"][0]["users"][1];
        assert_eq!(s2["customStatus"], "ouvindo musica");
    }
    #[test]
    fn call_focus_is_preserved_in_snapshot_and_cleared_on_leave() {
        let mut model = signed_in();
        assert!(model.snapshot()["session"]["callFocus"].is_null());
        model.call_focus = Some(json!({"key": "scr:s2", "filmOpen": true}));
        let snap = model.snapshot();
        assert_eq!(snap["session"]["callFocus"]["key"], "scr:s2");
        assert_eq!(snap["session"]["callFocus"]["filmOpen"], true);
        assert!(model.update(0, "kicked", json!({})));
        assert!(model.snapshot()["session"]["callFocus"].is_null());
        model.call_focus = Some(json!({"key": "scr:s2", "filmOpen": true}));
        model.reset_connection();
        assert!(model.snapshot()["session"]["callFocus"].is_null());
    }
}

