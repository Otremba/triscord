use crate::{
    api::{self, Api, AUTH, HUB},
    error::{Error, Result},
    model::{self, Model, Shared},
    socket::Socket,
    vault::{Credential, Vault},
};
use reqwest::Method;
use serde::Deserialize;
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
    OpenTextRoom {
        #[serde(rename = "channelId")]
        channel_id: String,
    },
    CreateTextRoom {
        #[serde(rename = "channelName")]
        channel_name: String,
    },
    LeaveTextRoom,
    SendChatMessage {
        text: String,
    },
    DeleteChatMessage {
        #[serde(rename = "messageId")]
        message_id: String,
    },
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
}
impl Core {
    pub fn new(directory: PathBuf) -> Result<Self> {
        Ok(Self {
            api: Api::new()?,
            vault: Vault::new(directory),
            credential: None,
            restored: false,
            model: Arc::new(Mutex::new(Model::default())),
            socket: None,
        })
    }
    fn reset(&mut self) {
        self.model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reset_connection();
        self.socket = None;
    }
    fn clear_account(&mut self) {
        self.reset();
        self.credential = None;
        let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
        model.account = None;
        model.servers.clear();
        model.selected_server.clear();
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
            model.generation
        };
        self.socket = Some(Socket::start(
            app.clone(),
            self.model.clone(),
            id,
            token,
            generation,
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
        // This preview joins membership/chat only, never claims to publish/receive audio.
        // The hub uses the LiveKit admission format for compatibility with native SFU rooms.
        self.send("join-room",json!({"roomId":id,"roomName":name,"mediaTransport":"livekit","userData":{"isMuted":true,"isDeafened":true}}))
    }
    pub async fn dispatch(&mut self, app: &tauri::AppHandle, command: Command) -> Result<Value> {
        let deleting = matches!(&command, Command::DeleteServer { .. });
        match command {
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
                        self.model.lock().unwrap_or_else(|e| e.into_inner()).account =
                            Some(public_account(&me["account"])?);
                    }
                    self.restored = true;
                    if self.credential.is_some() {
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
                self.model.lock().unwrap_or_else(|e| e.into_inner()).account = Some(account);
                // Sign-in remains successful if the independent directory is temporarily unavailable.
                if self.refresh_servers().await.is_err() {
                    model::notice(
                        app,
                        "Login concluído; não foi possível atualizar os servidores. Use Atualizar.",
                    );
                }
                Ok(json!({"created":response["created"].as_bool().unwrap_or(false)}))
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
                self.join_text(
                    uuid::Uuid::new_v4().to_string(),
                    clean_name(&channel_name, 64)?,
                )?;
                Ok(Value::Null)
            }
            Command::LeaveTextRoom => {
                self.send("leave-room", json!({}))?;
                let mut model = self.model.lock().unwrap_or_else(|e| e.into_inner());
                model.text_room = None;
                model.chat.clear();
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
    let nick = value["nick"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(Error::network)?;
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
    fn media_commands_are_explicitly_unavailable() {
        assert!(matches!(
            serde_json::from_value::<Command>(
                json!({"name":"startScreenShare","generation":"x","index":0})
            )
            .unwrap(),
            Command::Unsupported
        ));
    }
}
