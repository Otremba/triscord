use crate::{
    api::{self, Api, AUTH, HUB},
    error::{Error, Result},
    media::Media,
    model::{self, Model, Shared},
    screen::Screen,
    settings::Store,
    socket::Socket,
    vault::{Credential, Vault},
};
use reqwest::Method;
use serde::Deserialize;
use tauri::Manager;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Deserialize)]
#[serde(tag = "name", rename_all = "camelCase", deny_unknown_fields)]
pub enum Command {
    RequestSnapshot,
    ListShareSources,
    StartScreenShare {
        generation: String,
        index: usize,
        #[serde(default)]
        resolution: Option<String>,
        #[serde(default)]
        fps: Option<u32>,
    },
    StopScreenShare,
    GetOwnProfile,
    SaveOwnProfile {
        fields: Value,
    },
    BeginProfileMedia {
        kind: String,
        size: usize,
    },
    AppendProfileMedia {
        #[serde(rename = "uploadId")]
        upload_id: String,
        offset: usize,
        data: String,
    },
    FinishProfileMedia {
        #[serde(rename = "uploadId")]
        upload_id: String,
    },
    CancelProfileMedia {
        #[serde(rename = "uploadId")]
        upload_id: String,
    },
    RemoveProfileMedia {
        kind: String,
    },
    SignIn,
    SetNick {
        nick: String,
    },
    SignInNick {
        nick: String,
        password: Option<String>,
    },
    SignOut,
    SetPassword {
        password: String,
        #[serde(rename = "currentPassword")]
        current_password: Option<String>,
    },
    CreateServer {
        #[serde(rename = "serverName")]
        server_name: String,
    },
    SelectServer {
        #[serde(rename = "serverId")]
        server_id: String,
    },
    CreateInvite {
        #[serde(rename = "serverId")]
        server_id: String,
    },
    AcceptInvite {
        invite: String,
    },
    DeleteServer {
        #[serde(rename = "serverId")]
        server_id: String,
    },
    LeaveServer {
        #[serde(rename = "serverId")]
        server_id: String,
    },
    #[serde(alias = "selectChannel")]
    OpenTextRoom {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    CreateTextRoom {
        #[serde(rename = "channelName")]
        channel_name: String,
    },
    LeaveTextRoom,
    JoinVoice {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    LeaveVoice,
    SetMuted {
        muted: bool,
    },
    SetDeafened {
        deafened: bool,
    },
    SetSetting {
        key: String,
        value: Value,
    },
    RequestDevices,
    OpenSettings,
    SendChatMessage {
        text: String,
    },
    DeleteChatMessage {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    CreateChannel {
        #[serde(rename = "channelName")]
        channel_name: String,
        #[serde(default)]
        kind: Option<String>,
    },
    DeleteChannel {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    SetCustomStatus {
        text: String,
    },
    SetServerMuted {
        #[serde(rename = "socketId")]
        socket_id: String,
        muted: bool,
    },
    DisconnectParticipant {
        #[serde(rename = "socketId")]
        socket_id: String,
    },
    ToggleReaction {
        #[serde(rename = "messageId")]
        message_id: String,
        emoji: String,
    },
    CopyInvite {
        code: String,
    },
    CopyMessageText {
        #[serde(rename = "messageId")]
        message_id: String,
    },
    SetCallFullscreen {
        on: bool,
    },
    SetStreamHidden {
        #[serde(rename = "streamId")]
        stream_id: String,
        hidden: bool,
    },
    SetPeerAudio {
        #[serde(rename = "socketId")]
        socket_id: String,
        volume: Option<u32>,
        pan: Option<i32>,
        muted: Option<bool>,
        #[serde(rename = "streamVolume")]
        stream_volume: Option<u32>,
        #[serde(rename = "streamMuted")]
        stream_muted: Option<bool>,
    },
    PlaySound {
        #[serde(rename = "soundId")]
        sound_id: String,
    },
    PreviewSound {
        #[serde(rename = "soundId")]
        sound_id: String,
    },
    StopSoundPreview,
    #[serde(other)]
    Unsupported,
}

pub struct Core {
    api: Api,
    vault: Vault,
    credential: Option<Credential>,
    restored: bool,
    pub model: Shared,
    socket: Option<Socket>,
    media: Media,
    preferences: Store,
    upload: Option<crate::profiles::Upload>,
    screen: Screen,
    sources: Vec<crate::capture::Source>,
    sources_generation: String,
}
impl Core {
    pub fn new(
        directory: PathBuf,
        app: tauri::AppHandle,
        presenter: crate::presenter::Presenter,
    ) -> Result<Self> {
        let model = Arc::new(Mutex::new(Model {
            muted: true,
            ..Default::default()
        }));
        let media = Media::new(app.clone(), model.clone());
        let screen = Screen::new(app, model.clone(), presenter);
        let preferences = Store::new(directory.clone())?;
        Ok(Self {
            api: Api::new()?,
            vault: Vault::new(directory),
            credential: None,
            restored: false,
            model,
            socket: None,
            media,
            preferences,
            upload: None,
            screen,
            sources: Vec::new(),
            sources_generation: String::new(),
        })
    }
    fn reset(&mut self) {
        self.sources.clear();
        self.sources_generation.clear();
        self.model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset_connection();
        let generation = self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .generation;
        let _ = self.media.stop(generation);
        let _ = self.screen.leave(generation);
        self.socket = None;
    }
    fn clear_account(&mut self) {
        self.upload = None;
        self.reset();
        self.credential = None;
        let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
        model.account = None;
        model.profile = None;
        model.servers.clear();
        model.selected_server.clear();
        model.muted = true;
        model.deafened = false;
        model.preferences = Default::default();
    }
    fn install_account(&mut self, account: Value) {
        let preferences = self
            .preferences
            .account(account["id"].as_str().unwrap_or_default());
        let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
        model.account = Some(account);
        model.preferences = preferences;
        drop(model);
        let _ = self.media.devices();
    }
    async fn finish_sign_in(&mut self, app: &tauri::AppHandle, response: Value) -> Result<Value> {
        let account = public_account(&response["account"])?;
        let credential = Credential {
            session: response["session"]
                .as_str()
                .filter(|s| !s.is_empty() && s.len() <= 4096)
                .ok_or_else(Error::network)?
                .to_owned(),
            expires_at: response["expires_at"].as_u64().ok_or_else(Error::network)?,
        };
        self.vault.save(&credential)?;
        self.clear_account();
        self.credential = Some(credential);
        self.restored = true;
        self.install_account(account);
        model::publish(app, &self.model);
        let profile = crate::profiles::project(&self.api, &response["account"]).await;
        self.model.lock().unwrap_or_else(|e| e.into_inner()).profile = Some(profile);
        if self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .account
            .as_ref()
            .is_some_and(|a| a["nick"].as_str().is_some_and(|nick| !nick.is_empty()))
        {
            if let Err(error) = self.refresh_servers().await {
                if error.code == "unauthorized" {
                    return Err(error);
                }
                model::notice(
                    app,
                    "Login concluído; não foi possível atualizar os servidores. Use Atualizar.",
                );
            }
        }
        Ok(json!({"created":response["created"].as_bool().unwrap_or(false)}))
    }
    async fn authenticated(
        &mut self,
        method: Method,
        base: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let token = self.credential.as_ref().ok_or_else(Error::unauthorized)?;
        let result = self
            .api
            .request(method, base, path, Some(&token.session), body)
            .await;
        if result.as_ref().is_err_and(|e| e.code == "unauthorized") {
            self.clear_account();
            self.vault.clear()?;
        }
        result
    }
    async fn refresh_servers(&mut self) -> Result<()> {
        let value = self
            .authenticated(Method::GET, HUB, "/servers", None)
            .await?;
        let servers = value["servers"].as_array().ok_or_else(Error::network)?;
        let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
        model.servers = servers
            .iter()
            .filter(|s| {
                s["id"].as_str().is_some_and(|id| api::id(id).is_ok()) && s["name"].is_string()
            })
            .cloned()
            .collect();
        Ok(())
    }
    fn select(&mut self, app: &tauri::AppHandle, id: String) -> Result<()> {
        if id == "@me" {
            self.reset();
            {
                let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                model.selected_server = "@me".into();
                model.connection = "connected";
                model.rooms.clear();
                model.text_room = None;
                model.desired_room = None;
            }
            crate::model::publish(app, &self.model);
            return Ok(());
        }
        api::id(&id)?;
        if !self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .servers
            .iter()
            .any(|s| s["id"].as_str() == Some(&id))
        {
            return Err(Error::invalid());
        }
        if self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .selected_server
            == id
        {
            return Ok(());
        }
        let token = self
            .credential
            .as_ref()
            .ok_or_else(Error::unauthorized)?
            .session
            .clone();
        self.reset();
        let generation = {
            let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
            model.selected_server = id.clone();
            model.connection = "connecting";
            if let Some(cached) = model.server_rooms.get(&id) {
                let order: Vec<String> = cached
                    .iter()
                    .filter_map(|r| r["id"].as_str().map(str::to_owned))
                    .collect();
                model.rooms = cached.clone();
                for r_id in order {
                    if !model.room_order.contains(&r_id) {
                        model.room_order.push(r_id);
                    }
                }
            } else {
                model.rooms = vec![
                    json!({"id": "geral", "name": "Geral", "userCount": 0, "ownerUserId": "", "users": []}),
                    json!({"id": "jogos", "name": "Jogos", "userCount": 0, "ownerUserId": "", "users": []}),
                ];
                model.room_order = vec!["geral".into(), "jogos".into()];
            }
            model.generation
        };
        crate::model::publish(app, &self.model);
        self.socket = Some(Socket::start(
            app.clone(),
            self.model.clone(),
            id,
            token,
            generation,
            self.media.clone(),
            self.screen.clone(),
        ));
        Ok(())
    }
    fn send(&self, event: &str, payload: Value) -> Result<()> {
        if self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .connection
            != "connected"
        {
            return Err(Error::network());
        }
        self.socket
            .as_ref()
            .ok_or_else(Error::network)?
            .send(event, payload)
    }
    fn join_text(&self, id: String, name: String) -> Result<()> {
        api::id(&id)?;
        let generation = {
            let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
            model.screen_requested = false;
            model.screen_epoch += 1;
            model.membership_epoch += 1;
            model.streams.clear();
            model.generation
        };
        self.screen.leave(generation)?;
        self.model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .desired_room = Some(id.clone());
        // The room response admits screen reception and, after an explicit voice join, audio.
        let status = self.model.lock().unwrap_or_else(|e| e.into_inner()).preferences.custom_status.clone();
        self.send("join-room",json!({"roomId":id,"roomName":name,"mediaTransport":"livekit","userData":{"isMuted":true,"isDeafened":true,"status":status}}))
    }
    pub async fn dispatch(&mut self, app: &tauri::AppHandle, command: Command) -> Result<Value> {
        let deleting = matches!(&command, Command::DeleteServer { .. });
        match command {
            Command::ListShareSources => {
                self.sources = crate::capture::sources()?;
                self.sources_generation = uuid::Uuid::new_v4().to_string();
                Ok(
                    json!({"generation":self.sources_generation,"sources":self.sources.iter().enumerate().map(|(index,source)|json!({"index":index,"kind":source.kind,"name":source.name})).collect::<Vec<_>>()}),
                )
            }
            Command::StartScreenShare {
                generation,
                index,
                resolution,
                fps,
            } => {
                if generation != self.sources_generation {
                    return Err(Error::invalid());
                }
                let source = self
                    .sources
                    .get(index)
                    .cloned()
                    .ok_or_else(Error::invalid)?;
                let (generation, epoch, room) = {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    let room = model.text_room.clone().or_else(|| {
                        model
                            .rooms
                            .first()
                            .and_then(|r| r["id"].as_str())
                            .map(str::to_owned)
                    });
                    let Some(room) = room else {
                        return Err(Error::invalid());
                    };
                    if model.text_room.is_none() {
                        model.text_room = Some(room.clone());
                    }
                    model.screen_requested = true;
                    model.screen_admitting = false;
                    model.sharing = false;
                    model.sharing_name = source.name.to_string();
                    model.screen_epoch += 1;
                    (model.generation, model.screen_epoch, room)
                };
                let preferences = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .preferences
                    .clone();
                let config = match resolution.as_deref() {
                    Some("1440p") => crate::video_codec::Config {
                        width: 2560,
                        height: 1440,
                        fps: fps.unwrap_or(60).clamp(15, 60),
                        bitrate: if fps.unwrap_or(60) >= 60 { 14_000_000 } else { 8_000_000 },
                    },
                    Some("1080p") => crate::video_codec::Config {
                        width: 1920,
                        height: 1080,
                        fps: fps.unwrap_or(60).clamp(15, 60),
                        bitrate: if fps.unwrap_or(60) >= 60 { 8_000_000 } else { 4_500_000 },
                    },
                    Some("720p") => crate::video_codec::Config {
                        width: 1280,
                        height: 720,
                        fps: fps.unwrap_or(30).clamp(15, 60),
                        bitrate: if fps.unwrap_or(30) >= 60 { 4_000_000 } else { 2_500_000 },
                    },
                    _ => crate::video_codec::Config {
                        width: if preferences.share_hd { 1920 } else { 1280 },
                        height: if preferences.share_hd { 1080 } else { 720 },
                        fps: if preferences.share_mode == "screen" {
                            15
                        } else if preferences.share_hd {
                            60
                        } else {
                            30
                        },
                        bitrate: if preferences.share_hd {
                            8_000_000
                        } else {
                            2_500_000
                        },
                    },
                };
                self.screen.start(generation, epoch, source, config)?;
                self.send("media-refresh", json!({"kind":"screen","roomId":room}))?;
                if let Some(socket) = &self.socket {
                    let sender = socket.sender();
                    let model = self.model.clone();
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        for _ in 0..3 {
                            tokio::time::sleep(std::time::Duration::from_millis(3100)).await;
                            if !crate::screen::pending_admission(&model, generation, epoch) {
                                return;
                            }
                            let _ = sender.try_send((
                                "media-refresh".into(),
                                json!({"kind":"screen","roomId":room}),
                            ));
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        if crate::screen::pending_admission(&model, generation, epoch) {
                            {
                                let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
                                if model.generation == generation && model.screen_epoch == epoch {
                                    model.screen_requested = false;
                                    model.user_state_notify.notify_one();
                                }
                            }
                            model::publish(&app, &model);
                            model::notice(&app,"O servidor não respondeu à admissão da transmissão. Tente novamente.");
                        }
                    });
                }
                Ok(Value::Null)
            }
            Command::StopScreenShare => {
                let generation = {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    model.screen_requested = false;
                    model.screen_epoch += 1;
                    model.generation
                };
                self.screen.stop(generation)?;
                Ok(Value::Null)
            }
            Command::GetOwnProfile => {
                let response = self.authenticated(Method::GET, AUTH, "/me", None).await?;
                let profile = crate::profiles::project(&self.api, &response["account"]).await;
                self.model.lock().unwrap_or_else(|e| e.into_inner()).profile =
                    Some(profile.clone());
                Ok(profile)
            }
            Command::SaveOwnProfile { fields } => {
                crate::profiles::validate_fields(&fields)?;
                let response = self
                    .authenticated(Method::PATCH, AUTH, "/profile", Some(fields))
                    .await?;
                let profile = crate::profiles::project(&self.api, &response["account"]).await;
                self.model.lock().unwrap_or_else(|e| e.into_inner()).profile =
                    Some(profile.clone());
                Ok(profile)
            }
            Command::BeginProfileMedia { kind, size } => {
                let account = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .account
                    .as_ref()
                    .and_then(|a| a["id"].as_str())
                    .ok_or_else(Error::unauthorized)?
                    .to_owned();
                let upload = crate::profiles::Upload::new(kind, size, account)?;
                let id = upload.id.clone();
                self.upload = Some(upload);
                Ok(json!({"uploadId":id}))
            }
            Command::AppendProfileMedia {
                upload_id,
                offset,
                data,
            } => {
                let account = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .account
                    .as_ref()
                    .and_then(|a| a["id"].as_str())
                    .ok_or_else(Error::unauthorized)?
                    .to_owned();
                self.upload
                    .as_mut()
                    .ok_or_else(Error::invalid)?
                    .append(&upload_id, &account, offset, &data)?;
                Ok(Value::Null)
            }
            Command::CancelProfileMedia { upload_id } => {
                if self
                    .upload
                    .as_ref()
                    .is_some_and(|upload| upload.id == upload_id)
                {
                    self.upload = None;
                }
                Ok(Value::Null)
            }
            Command::FinishProfileMedia { upload_id } => {
                let account = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .account
                    .as_ref()
                    .and_then(|a| a["id"].as_str())
                    .ok_or_else(Error::unauthorized)?
                    .to_owned();
                let upload = self.upload.take().ok_or_else(Error::invalid)?;
                let kind = upload.kind.clone();
                let (mime, bytes) = upload.finish(&upload_id, &account)?;
                let token = self.credential.as_ref().ok_or_else(Error::unauthorized)?;
                let response = self
                    .api
                    .upload(&format!("/profile/{kind}"), &token.session, mime, bytes)
                    .await?;
                let profile = crate::profiles::project(&self.api, &response["account"]).await;
                self.model.lock().unwrap_or_else(|e| e.into_inner()).profile =
                    Some(profile.clone());
                Ok(profile)
            }
            Command::RemoveProfileMedia { kind } => {
                if !["avatar", "banner"].contains(&kind.as_str()) {
                    return Err(Error::invalid());
                }
                let response = self
                    .authenticated(Method::DELETE, AUTH, &format!("/profile/{kind}"), None)
                    .await?;
                let profile = crate::profiles::project(&self.api, &response["account"]).await;
                self.model.lock().unwrap_or_else(|e| e.into_inner()).profile =
                    Some(profile.clone());
                Ok(profile)
            }
            Command::SignIn => {
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .signing_in = true;
                model::publish(app, &self.model);
                let token = crate::oauth::sign_in().await;
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .signing_in = false;
                let token = token?;
                let response = self
                    .api
                    .request(
                        Method::POST,
                        AUTH,
                        "/auth/google",
                        None,
                        Some(json!({"id_token":token.as_str()})),
                    )
                    .await?;
                self.finish_sign_in(app, response).await
            }
            Command::SetNick { nick } => {
                let nick = clean_name(&nick, 32)?;
                let response = self
                    .authenticated(Method::POST, AUTH, "/nick", Some(json!({"nick":nick})))
                    .await?;
                self.install_account(public_account(&response["account"])?);
                self.refresh_servers().await?;
                Ok(Value::Null)
            }
            Command::RequestSnapshot => {
                if !self.restored {
                    self.credential = self.vault.load()?;
                    if let Some(credential) = &self.credential {
                        let now = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        if credential.expires_at <= now {
                            self.credential = None;
                            self.vault.clear()?;
                        }
                    }
                    if self.credential.is_some() {
                        // Network failure preserves the encrypted credential and allows retry.
                        let me = self.authenticated(Method::GET, AUTH, "/me", None).await?;
                        self.install_account(public_account(&me["account"])?);
                        model::publish(app, &self.model);
                        let profile = crate::profiles::project(&self.api, &me["account"]).await;
                        self.model.lock().unwrap_or_else(|e| e.into_inner()).profile =
                            Some(profile);
                    }
                    self.restored = true;
                    if self.credential.is_some()
                        && self
                            .model
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .account
                            .as_ref()
                            .is_some_and(|a| {
                                a["nick"].as_str().is_some_and(|nick| !nick.is_empty())
                            })
                    {
                        self.refresh_servers().await?;
                    }
                }
                Ok(Value::Null)
            }
            Command::SignInNick { nick, password } => {
                let nick = clean_name(&nick, 32)?;
                if nick.chars().count() < 2 || password.as_ref().is_some_and(|p| p.len() > 512) {
                    return Err(Error::invalid());
                }
                let response = self
                    .api
                    .request(
                        Method::POST,
                        AUTH,
                        "/auth/nick",
                        None,
                        Some(json!({"nick":nick,"password":password})),
                    )
                    .await?;
                self.finish_sign_in(app, response).await
            }
            Command::SignOut => {
                self.vault.clear()?; // Do not claim logout persisted if deletion failed.
                let credential = self.credential.take();
                self.clear_account();
                self.restored = true;
                model::publish(app, &self.model);
                let revoked = if let Some(token) = credential {
                    self.api
                        .request(
                            Method::POST,
                            AUTH,
                            "/logout",
                            Some(&token.session),
                            Some(json!({})),
                        )
                        .await
                        .is_ok()
                } else {
                    true
                };
                if !revoked {
                    model::notice(app,"A sessão foi removida deste computador; a revogação no servidor não pôde ser confirmada.");
                }
                Ok(Value::Null)
            }
            Command::SetPassword {
                password,
                current_password,
            } => {
                if password.encode_utf16().count() < 6 || password.encode_utf16().count() > 128 {
                    return Err(Error::invalid());
                }
                self.authenticated(
                    Method::POST,
                    AUTH,
                    "/password",
                    Some(json!({"password":password,"current_password":current_password})),
                )
                .await?;
                Ok(Value::Null)
            }
            Command::CreateServer { server_name } => {
                let name = clean_name(&server_name, 64)?;
                let value = self
                    .authenticated(Method::POST, HUB, "/servers", Some(json!({"name":name})))
                    .await?;
                let id = value["id"].as_str().ok_or_else(Error::network)?.to_owned();
                // A failed follow-up read must not make a successful creation look failed and invite duplication.
                api::id(&id)?;
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .servers
                    .push(value);
                self.select(app, id.clone())?;
                Ok(json!({"serverId":id}))
            }
            Command::SelectServer { server_id } => {
                self.select(app, server_id)?;
                Ok(Value::Null)
            }
            Command::CreateInvite { server_id } => {
                api::id(&server_id)?;
                let value = self
                    .authenticated(
                        Method::POST,
                        HUB,
                        &format!("/servers/{server_id}/invites"),
                        Some(json!({})),
                    )
                    .await?;
                let code = value["code"].as_str().ok_or_else(Error::network)?;
                Ok(json!({"code":api::invite(code)?}))
            }
            Command::AcceptInvite { invite } => {
                let code = api::invite(&invite)?;
                let value = self
                    .authenticated(
                        Method::POST,
                        HUB,
                        &format!("/invites/{code}/accept"),
                        Some(json!({})),
                    )
                    .await?;
                let id = value["serverId"]
                    .as_str()
                    .ok_or_else(Error::network)?
                    .to_owned();
                if self.refresh_servers().await.is_ok() {
                    self.select(app, id.clone())?;
                } else {
                    model::notice(
                        app,
                        "Convite aceito; use Atualizar para carregar o servidor.",
                    );
                }
                Ok(json!({"serverId":id}))
            }
            Command::DeleteServer { server_id } | Command::LeaveServer { server_id } => {
                api::id(&server_id)?;
                let path = if deleting {
                    format!("/servers/{server_id}")
                } else {
                    format!("/servers/{server_id}/leave")
                };
                self.authenticated(
                    if deleting {
                        Method::DELETE
                    } else {
                        Method::POST
                    },
                    HUB,
                    &path,
                    Some(json!({})),
                )
                .await?;
                if self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .selected_server
                    == server_id
                {
                    self.reset();
                    self.model
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .selected_server
                        .clear();
                }
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .servers
                    .retain(|s| s["id"].as_str() != Some(&server_id));
                Ok(Value::Null)
            }
            Command::OpenTextRoom { channel_id } => {
                // Selecting the current room is navigation, not a new media admission.
                if self.model.lock().unwrap_or_else(|e| e.into_inner()).room_selected(&channel_id) {
                    return Ok(Value::Null);
                }
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.voice_requested = false;
                    m.generation
                };
                self.media.stop(generation)?;
                let name = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .rooms
                    .iter()
                    .find(|r| r["id"].as_str() == Some(&channel_id))
                    .and_then(|r| r["name"].as_str())
                    .map(str::to_owned)
                    .ok_or_else(Error::invalid)?;
                self.join_text(channel_id, name)?;
                Ok(Value::Null)
            }
            Command::CreateTextRoom { channel_name } => {
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.voice_requested = false;
                    m.generation
                };
                self.media.stop(generation)?;
                self.join_text(
                    uuid::Uuid::new_v4().to_string(),
                    clean_name(&channel_name, 64)?,
                )?;
                Ok(Value::Null)
            }
            Command::LeaveTextRoom | Command::LeaveVoice => {
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.voice_requested = false;
                    m.desired_room = None;
                    m.generation
                };
                self.media.stop(generation)?;
                crate::sound::play_cue(crate::sound::CallSound::Leave);
                {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    model.screen_requested = false;
                    model.screen_epoch += 1;
                    model.membership_epoch += 1;
                    model.streams.clear();
                }
                self.screen.leave(generation)?;
                self.send("leave-room", json!({}))?;
                let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                model.text_room = None;
                model.chat.clear();
                model.speaking.clear();
                model.peer_muted.clear();
                model.peer_volume.clear();
                model.peer_pan.clear();
                model.peer_stream_volume.clear();
                model.peer_stream_muted.clear();
                model.connected_at = 0;
                model.call_focus = None;
                if std::mem::take(&mut model.call_fullscreen) {
                    drop(model);
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.set_fullscreen(false);
                    }
                }
                Ok(Value::Null)
            }
            Command::JoinVoice { channel_id } => {
                // A second click on the room we are in (or joining) must not tear the call down and start it again.
                let joining = {
                    let m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.voice_join_in_progress(&channel_id)
                };
                if joining {
                    return Ok(Value::Null);
                }
                let name = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .rooms
                    .iter()
                    .find(|r| r["id"].as_str() == Some(&channel_id))
                    .and_then(|r| r["name"].as_str())
                    .map(str::to_owned)
                    .ok_or_else(Error::invalid)?;
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.voice_requested = true;
                    m.voice_state = "connecting".into();
                    m.generation
                };
                self.media.stop(generation)?;
                if let Err(error) = self.join_text(channel_id, name) {
                    self.model
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .voice_requested = false;
                    return Err(error);
                }
                crate::sound::play_cue(crate::sound::CallSound::Join);
                Ok(Value::Null)
            }
            Command::SetMuted { muted } => {
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.muted = muted;
                    if muted && !m.self_socket.is_empty() {
                        let self_socket = m.self_socket.clone();
                        m.speaking.remove(&self_socket);
                    }
                    m.generation
                };
                self.media.configure(generation)?;
                crate::sound::play_cue(if muted {
                    crate::sound::CallSound::Mute
                } else {
                    crate::sound::CallSound::Unmute
                });
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .user_state_notify
                    .notify_one();
                model::publish(app, &self.model);
                Ok(Value::Null)
            }
            Command::SetDeafened { deafened } => {
                let generation = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.deafened = deafened;
                    if deafened && !m.self_socket.is_empty() {
                        let self_socket = m.self_socket.clone();
                        m.speaking.remove(&self_socket);
                    }
                    m.generation
                };
                self.media.configure(generation)?;
                crate::sound::play_cue(if deafened {
                    crate::sound::CallSound::Deafen
                } else {
                    crate::sound::CallSound::Undeafen
                });
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .user_state_notify
                    .notify_one();
                model::publish(app, &self.model);
                Ok(Value::Null)
            }
            Command::SetSetting { key, value } => {
                let (account, mut preferences, generation) = {
                    let model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    (
                        model
                            .account
                            .as_ref()
                            .and_then(|a| a["id"].as_str())
                            .ok_or_else(Error::unauthorized)?
                            .to_owned(),
                        model.preferences.clone(),
                        model.generation,
                    )
                };
                preferences.set(&key, value)?;
                self.preferences.save(account, preferences.clone())?;
                self.model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .preferences = preferences;
                self.media.configure(generation)?;
                Ok(Value::Null)
            }
            Command::RequestDevices | Command::OpenSettings => {
                self.media.devices()?;
                Ok(Value::Null)
            }
            Command::SendChatMessage { text } => {
                let text = clean_name(&text, 2000)?;
                let room = self
                    .model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .text_room
                    .clone()
                    .ok_or_else(Error::invalid)?;
                self.send("send-chat-message", json!({"roomId":room,"message":text}))?;
                Ok(Value::Null)
            }
            Command::DeleteChatMessage { message_id } => {
                api::id(&message_id)?;
                let model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                let account = model.account.as_ref().ok_or_else(Error::unauthorized)?;
                if !model.chat.iter().any(|m| {
                    m["id"].as_str() == Some(&message_id) && m["senderUserId"] == account["id"]
                }) {
                    return Err(Error::invalid());
                }
                let room = model.text_room.clone().ok_or_else(Error::invalid)?;
                drop(model);
                self.send(
                    "delete-chat-message",
                    json!({"messageId":message_id,"roomId":room}),
                )?;
                Ok(Value::Null)
            }
            Command::CreateChannel { channel_name, kind } => {
                let name = clean_name(&channel_name, 64)?;
                let is_text = kind.as_deref() == Some("text");
                if is_text {
                    let generation = {
                        let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                        m.voice_requested = false;
                        m.generation
                    };
                    self.media.stop(generation)?;
                    self.join_text(format!("text_{}", uuid::Uuid::new_v4()), name)?;
                } else {
                    let generation = {
                        let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                        m.voice_requested = true;
                        m.voice_state = "connecting".into();
                        m.generation
                    };
                    self.media.stop(generation)?;
                    if let Err(error) = self.join_text(format!("room_{}", uuid::Uuid::new_v4()), name) {
                        self.model
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .voice_requested = false;
                        return Err(error);
                    }
                }
                Ok(Value::Null)
            }
            Command::DeleteChannel { channel_id } => {
                api::id(&channel_id)?;
                let was_connected_voice = {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    let in_voice = m.desired_room.as_deref() == Some(&channel_id) && m.voice_requested;
                    if in_voice {
                        m.voice_requested = false;
                        m.desired_room = None;
                        m.connected_at = 0;
                    }
                    if m.text_room.as_deref() == Some(&channel_id) {
                        m.text_room = None;
                    }
                    in_voice
                };
                if was_connected_voice {
                    let generation = self.model.lock().unwrap_or_else(|e| e.into_inner()).generation;
                    let _ = self.media.stop(generation);
                    let _ = self.send("leave-room", json!({}));
                }
                self.send("delete-room", json!({"roomId": channel_id}))?;
                {
                    let mut m = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    m.rooms.retain(|r| r["id"].as_str() != Some(&channel_id));
                    m.chat.retain(|c| c["roomId"].as_str() != Some(&channel_id));
                }
                model::publish(app, &self.model);
                Ok(Value::Null)
            }
            Command::SetCustomStatus { text } => {
                let (account, mut preferences) = {
                    let model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    (
                        model
                            .account
                            .as_ref()
                            .and_then(|a| a["id"].as_str())
                            .ok_or_else(Error::unauthorized)?
                            .to_owned(),
                        model.preferences.clone(),
                    )
                };
                preferences.set_status(&text)?;
                self.preferences.save(account, preferences.clone())?;
                let status = preferences.custom_status.clone();
                let joined = {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    model.preferences = preferences;
                    model.text_room.is_some()
                };
                if joined {
                    // Partial state: the hub merges it into the user's row for everyone in the room.
                    let _ = self.send("user-state-change", json!({"status": status}));
                }
                Ok(Value::Null)
            }
            Command::SetServerMuted { socket_id, muted } => {
                api::id(&socket_id)?;
                self.send("force-mute-user", json!({"socketId":socket_id,"muted":muted}))?;
                Ok(Value::Null)
            }
            Command::DisconnectParticipant { socket_id } => {
                api::id(&socket_id)?;
                self.send("kick-user", json!({"socketId":socket_id}))?;
                Ok(Value::Null)
            }
            Command::ToggleReaction { message_id, emoji } => {
                api::id(&message_id)?;
                if emoji.is_empty() || emoji.chars().count() > 16 || emoji.contains('\0') {
                    return Err(Error::invalid());
                }
                self.send("add-reaction", json!({"messageId":message_id,"emoji":emoji}))?;
                Ok(Value::Null)
            }
            Command::CopyInvite { code } => {
                crate::clipboard::set_text(&api::invite(&code)?)?;
                Ok(Value::Null)
            }
            Command::CopyMessageText { message_id } => {
                api::id(&message_id)?;
                let text = {
                    let model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    model
                        .chat
                        .iter()
                        .find(|m| m["id"].as_str() == Some(message_id.as_str()))
                        .and_then(|m| m["text"].as_str())
                        .map(str::to_owned)
                }
                .ok_or_else(Error::invalid)?;
                crate::clipboard::set_text(&text)?;
                Ok(Value::Null)
            }
            Command::SetCallFullscreen { on } => {
                {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    if on && !(model.voice_requested && model.text_room.is_some()) {
                        return Err(Error::invalid());
                    }
                    model.call_fullscreen = on;
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_fullscreen(on);
                }
                Ok(Value::Null)
            }
            Command::SetStreamHidden { stream_id, hidden } => {
                api::id(&stream_id)?;
                let known = {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    match model.streams.iter_mut().find(|s| s["id"].as_str() == Some(stream_id.as_str())) {
                        Some(stream) => {
                            stream["hidden"] = json!(hidden);
                            true
                        }
                        None => false,
                    }
                };
                if !known {
                    return Err(Error::invalid());
                }
                app.state::<crate::presenter::Presenter>().hide(&stream_id, hidden);
                Ok(Value::Null)
            }
            Command::SetPeerAudio {
                socket_id,
                volume,
                pan,
                muted,
                stream_volume,
                stream_muted,
            } => {
                api::id(&socket_id)?;
                if let Some(v) = volume {
                    if v > 200 {
                        return Err(Error::invalid());
                    }
                }
                if let Some(p) = pan {
                    if !(-100..=100).contains(&p) {
                        return Err(Error::invalid());
                    }
                }
                if let Some(sv) = stream_volume {
                    if sv > 200 {
                        return Err(Error::invalid());
                    }
                }
                let generation = {
                    let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(muted) = muted {
                        if muted {
                            model.peer_muted.insert(socket_id.clone());
                        } else {
                            model.peer_muted.remove(&socket_id);
                        }
                    }
                    if let Some(volume) = volume {
                        if volume == 100 {
                            model.peer_volume.remove(&socket_id);
                        } else {
                            model.peer_volume.insert(socket_id.clone(), volume);
                        }
                    }
                    if let Some(pan) = pan {
                        if pan == 0 {
                            model.peer_pan.remove(&socket_id);
                        } else {
                            model.peer_pan.insert(socket_id.clone(), pan);
                        }
                    }
                    if let Some(stream_volume) = stream_volume {
                        if stream_volume == 100 {
                            model.peer_stream_volume.remove(&socket_id);
                        } else {
                            model.peer_stream_volume.insert(socket_id.clone(), stream_volume);
                        }
                    }
                    if let Some(stream_muted) = stream_muted {
                        if stream_muted {
                            model.peer_stream_muted.insert(socket_id.clone());
                        } else {
                            model.peer_stream_muted.remove(&socket_id);
                        }
                    }
                    model.generation
                };
                self.media.configure(generation)?;
                model::publish(app, &self.model);
                Ok(Value::Null)
            }
            Command::PlaySound { sound_id } => {
                if !crate::sound::catalog().iter().any(|s| s["id"] == sound_id) {
                    return Err(Error::invalid());
                }
                if let Some(socket) = &self.socket {
                    let _ = socket.sender().try_send((
                        "soundboard-play".into(),
                        serde_json::json!({"soundId": sound_id}),
                    ));
                }
                crate::sound::play_sound(&sound_id);
                Ok(Value::Null)
            }
            Command::PreviewSound { sound_id } => {
                if !crate::sound::catalog().iter().any(|s| s["id"] == sound_id) {
                    return Err(Error::invalid());
                }
                crate::sound::play_sound(&sound_id);
                Ok(Value::Null)
            }
            Command::StopSoundPreview => {
                crate::sound::stop_playback();
                Ok(Value::Null)
            },
            Command::Unsupported => Err(Error::unsupported()),
        }
    }
    pub async fn refresh(&mut self) -> Result<Value> {
        self.refresh_servers().await?;
        Ok(Value::Null)
    }
}
fn public_account(value: &Value) -> Result<Value> {
    let id = value["id"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .ok_or_else(Error::network)?;
    let nick = value["nick"].as_str().unwrap_or_default();
    Ok(json!({"id":id,"nick":nick}))
}
fn clean_name(value: &str, limit: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.encode_utf16().count() > limit || value.contains('\0') {
        return Err(Error::invalid());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn renderer_cannot_choose_endpoints_or_session_credentials() {
        assert!(serde_json::from_value::<Command>(
            json!({"name":"signInNick","nick":"Nick","session":"stolen"})
        )
        .is_err());
        assert!(serde_json::from_value::<Command>(
            json!({"name":"selectServer","serverId":"a","url":"http://evil"})
        )
        .is_err());
    }
    #[test]
    fn text_limits_match_worker_utf16_lengths() {
        assert!(clean_name(&"😀".repeat(1000), 2000).is_ok());
        assert!(clean_name(&"😀".repeat(1001), 2000).is_err());
    }
    #[test]
    fn unknown_commands_cannot_execute_privileged_operations() {
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"name":"executeShell","command":"arbitrary"}))
                .unwrap(),
            Command::Unsupported
        ));
    }
    #[test]
    fn sound_commands_deserialization_works() {
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"name":"playSound","soundId":"quack"})).unwrap(),
            Command::PlaySound { sound_id } if sound_id == "quack"
        ));
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"name":"previewSound","soundId":"airhorn"})).unwrap(),
            Command::PreviewSound { sound_id } if sound_id == "airhorn"
        ));
        assert!(matches!(
            serde_json::from_value::<Command>(json!({"name":"stopSoundPreview"})).unwrap(),
            Command::StopSoundPreview
        ));
    }
    #[test]
    fn command_select_channel_alias_deserializes_to_open_text_room() {
        let cmd: Command = serde_json::from_value(json!({
            "name": "selectChannel",
            "channelId": "chan-123"
        }))
        .unwrap();
        assert!(matches!(cmd, Command::OpenTextRoom { channel_id } if channel_id == "chan-123"));
    }
    #[test]
    fn command_open_text_room_deserializes_normally() {
        let cmd: Command = serde_json::from_value(json!({
            "name": "openTextRoom",
            "channelId": "chan-456"
        }))
        .unwrap();
        assert!(matches!(cmd, Command::OpenTextRoom { channel_id } if channel_id == "chan-456"));
    }
    #[test]
    fn command_send_chat_message_deserializes() {
        let cmd: Command = serde_json::from_value(json!({
            "name": "sendChatMessage",
            "text": "Hello Triscord!"
        }))
        .unwrap();
        assert!(matches!(cmd, Command::SendChatMessage { text } if text == "Hello Triscord!"));
    }
    #[test]
    fn command_voice_and_audio_controls_deserialize() {
        let join: Command = serde_json::from_value(json!({
            "name": "joinVoice",
            "channelId": "voice-1"
        }))
        .unwrap();
        assert!(matches!(join, Command::JoinVoice { channel_id } if channel_id == "voice-1"));
        let leave: Command = serde_json::from_value(json!({"name": "leaveVoice"})).unwrap();
        assert!(matches!(leave, Command::LeaveVoice));
        let muted: Command = serde_json::from_value(json!({"name": "setMuted", "muted": true})).unwrap();
        assert!(matches!(muted, Command::SetMuted { muted: true }));
        let deaf: Command = serde_json::from_value(json!({"name": "setDeafened", "deafened": false})).unwrap();
        assert!(matches!(deaf, Command::SetDeafened { deafened: false }));
    }
    #[test]
    fn command_set_peer_audio_deserializes() {
        let cmd: Command = serde_json::from_value(json!({
            "name": "setPeerAudio",
            "socketId": "sock-peer-1",
            "volume": 120,
            "pan": -30,
            "muted": false,
            "streamVolume": 180,
            "streamMuted": true
        }))
        .unwrap();
        assert!(matches!(
            cmd,
            Command::SetPeerAudio {
                socket_id,
                volume: Some(120),
                pan: Some(-30),
                muted: Some(false),
                stream_volume: Some(180),
                stream_muted: Some(true)
            } if socket_id == "sock-peer-1"
        ));
    }
    #[test]
    fn command_delete_channel_deserializes() {
        let cmd: Command = serde_json::from_value(json!({
            "name": "deleteChannel",
            "channelId": "chan-del-123"
        }))
        .unwrap();
        assert!(matches!(cmd, Command::DeleteChannel { channel_id } if channel_id == "chan-del-123"));
    }
    #[test]
    fn command_server_management_deserializes() {
        let create: Command = serde_json::from_value(json!({
            "name": "createServer",
            "serverName": "My Community"
        }))
        .unwrap();
        assert!(matches!(create, Command::CreateServer { server_name } if server_name == "My Community"));
        let delete: Command = serde_json::from_value(json!({
            "name": "deleteServer",
            "serverId": "srv-99"
        }))
        .unwrap();
        assert!(matches!(delete, Command::DeleteServer { server_id } if server_id == "srv-99"));
        let leave: Command = serde_json::from_value(json!({
            "name": "leaveServer",
            "serverId": "srv-99"
        }))
        .unwrap();
        assert!(matches!(leave, Command::LeaveServer { server_id } if server_id == "srv-99"));
    }
    #[test]
    fn command_moderation_actions_deserialize() {
        let server_mute: Command = serde_json::from_value(json!({
            "name": "setServerMuted",
            "socketId": "sock-peer",
            "muted": true
        }))
        .unwrap();
        assert!(matches!(server_mute, Command::SetServerMuted { socket_id, muted: true } if socket_id == "sock-peer"));
        let kick: Command = serde_json::from_value(json!({
            "name": "disconnectParticipant",
            "socketId": "sock-bad"
        }))
        .unwrap();
        assert!(matches!(kick, Command::DisconnectParticipant { socket_id } if socket_id == "sock-bad"));
    }
    #[test]
    fn command_screen_share_actions_deserialize() {
        let start: Command = serde_json::from_value(json!({
            "name": "startScreenShare",
            "generation": "gen-1",
            "index": 0
        }))
        .unwrap();
        assert!(matches!(start, Command::StartScreenShare { generation, index: 0, .. } if generation == "gen-1"));
        let start_1440p: Command = serde_json::from_value(json!({
            "name": "startScreenShare",
            "generation": "gen-2",
            "index": 1,
            "resolution": "1440p",
            "fps": 60
        }))
        .unwrap();
        assert!(matches!(start_1440p, Command::StartScreenShare { generation, index: 1, resolution: Some(res), fps: Some(60) } if generation == "gen-2" && res == "1440p"));
        let stop: Command = serde_json::from_value(json!({"name": "stopScreenShare"})).unwrap();
        assert!(matches!(stop, Command::StopScreenShare));
    }
    #[test]
    fn command_profile_media_chunk_deserializes() {
        let chunk: Command = serde_json::from_value(json!({
            "name": "appendProfileMedia",
            "uploadId": "upl-1",
            "offset": 24576,
            "data": "aW1hZ2VkYXRh"
        }))
        .unwrap();
        assert!(matches!(chunk, Command::AppendProfileMedia { upload_id, offset: 24576, data } if upload_id == "upl-1" && data == "aW1hZ2VkYXRh"));
        let finish: Command = serde_json::from_value(json!({
            "name": "finishProfileMedia",
            "uploadId": "upl-1"
        }))
        .unwrap();
        assert!(matches!(finish, Command::FinishProfileMedia { upload_id } if upload_id == "upl-1"));
    }
    #[test]
    fn clean_name_rejects_empty_whitespace_and_null_bytes() {
        assert!(clean_name("", 100).is_err());
        assert!(clean_name("   ", 100).is_err());
        assert!(clean_name("\t\n\r", 100).is_err());
        assert!(clean_name("hello\0world", 100).is_err());
        assert_eq!(clean_name("  valid name  ", 100).unwrap(), "valid name");
    }
    #[test]
    fn clean_name_exact_utf16_boundary_checks() {
        let exactly_limit = "a".repeat(64);
        assert!(clean_name(&exactly_limit, 64).is_ok());
        let one_over = "a".repeat(65);
        assert!(clean_name(&one_over, 64).is_err());
    }
    #[test]
    fn public_account_validation_rules() {
        let valid = json!({"id": "acc-123", "nick": "Alice"});
        let result = public_account(&valid).unwrap();
        assert_eq!(result["id"], "acc-123");
        assert_eq!(result["nick"], "Alice");

        let empty_id = json!({"id": "", "nick": "Bob"});
        assert!(public_account(&empty_id).is_err());

        let missing_id = json!({"nick": "Charlie"});
        assert!(public_account(&missing_id).is_err());

        let long_id = json!({"id": "x".repeat(129), "nick": "Dave"});
        assert!(public_account(&long_id).is_err());
    }
    #[test]
    fn command_fuzzing_rejects_unknown_fields_and_malformed_structures() {
        // Unknown command falls back to Unsupported
        let unknown: Command = serde_json::from_value(json!({"name": "nonExistentOp"})).unwrap();
        assert!(matches!(unknown, Command::Unsupported));

        // Unknown extra fields on known commands are denied by serde deny_unknown_fields
        assert!(serde_json::from_value::<Command>(json!({
            "name": "joinVoice",
            "channelId": "voice-1",
            "extraInjectedField": "malicious"
        })).is_err());

        // Wrong types for known fields return Err, never panic
        assert!(serde_json::from_value::<Command>(json!({
            "name": "joinVoice",
            "channelId": 12345
        })).is_err());
        assert!(serde_json::from_value::<Command>(json!({
            "name": "setMuted",
            "muted": "not-a-boolean"
        })).is_err());
        assert!(serde_json::from_value::<Command>(json!({
            "name": "setPeerAudio",
            "socketId": "s1",
            "volume": -50
        })).is_err());

        // Malformed JSON structures (e.g. primitives or arrays instead of object)
        assert!(serde_json::from_value::<Command>(json!(null)).is_err());
        assert!(serde_json::from_value::<Command>(json!([])).is_err());
        assert!(serde_json::from_value::<Command>(json!("joinVoice")).is_err());
        assert!(serde_json::from_value::<Command>(json!(42)).is_err());
    }
    #[test]
    fn command_fuzzing_handles_extreme_strings_and_special_unicode() {
        // 50,000-character chat text deserializes safely without panic
        let huge_text = "A".repeat(50000);
        let cmd: Command = serde_json::from_value(json!({
            "name": "sendChatMessage",
            "text": huge_text
        })).unwrap();
        if let Command::SendChatMessage { text } = cmd {
            assert_eq!(text.len(), 50000);
        } else {
            panic!("Expected SendChatMessage");
        }

        // Extreme unicode: RTL, emojis, zero-width joiners, surrogate pairs
        let complex_unicode = "مرحبا بالعالم! 👨‍👩‍👧‍👦 \u{200B}\u{200E}\u{FEFF} 🎮🔥💻";
        let cmd: Command = serde_json::from_value(json!({
            "name": "sendChatMessage",
            "text": complex_unicode
        })).unwrap();
        if let Command::SendChatMessage { text } = cmd {
            assert_eq!(text, complex_unicode);
        } else {
            panic!("Expected SendChatMessage");
        }
    }
    #[test]
    fn command_fuzzing_channel_and_moderation_variants() {
        // Toggle reaction
        let react: Command = serde_json::from_value(json!({
            "name": "toggleReaction",
            "messageId": "msg-123",
            "emoji": "🔥"
        })).unwrap();
        assert!(matches!(react, Command::ToggleReaction { message_id, emoji } if message_id == "msg-123" && emoji == "🔥"));

        // Set call fullscreen and stream hidden
        let fs: Command = serde_json::from_value(json!({
            "name": "setCallFullscreen",
            "on": true
        })).unwrap();
        assert!(matches!(fs, Command::SetCallFullscreen { on: true }));

        let hide: Command = serde_json::from_value(json!({
            "name": "setStreamHidden",
            "streamId": "str-99",
            "hidden": true
        })).unwrap();
        assert!(matches!(hide, Command::SetStreamHidden { stream_id, hidden: true } if stream_id == "str-99"));

        // Custom status
        let status: Command = serde_json::from_value(json!({
            "name": "setCustomStatus",
            "text": "Coding in Rust 🦀"
        })).unwrap();
        assert!(matches!(status, Command::SetCustomStatus { text } if text == "Coding in Rust 🦀"));

        // Select server supports @me home indicator
        let select_me: Command = serde_json::from_value(json!({
            "name": "selectServer",
            "serverId": "@me"
        })).unwrap();
        assert!(matches!(select_me, Command::SelectServer { server_id } if server_id == "@me"));
    }
}
