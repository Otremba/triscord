use crate::{
    error::{Error, Result},
    model::{notice, publish, Shared},
};
use livekit::{
    options::TrackPublishOptions, prelude::*, AudioProcessingOptions, PlatformAudio,
    PlayoutDeviceId, RecordingDeviceId,
};
use serde_json::Value;
use std::{collections::HashMap, time::Duration};
use tokio::{sync::mpsc, time::timeout};
use zeroize::{Zeroize, Zeroizing};

pub struct Credentials {
    pub(crate) url: String,
    pub(crate) token: String,
}
impl Drop for Credentials {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
impl Credentials {
    pub fn parse(value: &Value) -> Result<Self> {
        let url = value["url"].as_str().ok_or_else(Error::invalid)?;
        let parsed = reqwest::Url::parse(url).map_err(|_| Error::invalid())?;
        if parsed.scheme() != "wss"
            || parsed.port().is_some_and(|port| port != 443)
            || parsed.path() != "/"
            || !["triscord.217-9-14-79.sslip.io", "217-9-14-79.nip.io", "triscord.duckdns.org"]
                .contains(&parsed.host_str().unwrap_or_default())
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(Error::invalid());
        }
        let token = value["token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 16384)
            .ok_or_else(Error::invalid)?;
        Ok(Self {
            url: url.to_owned(),
            token: token.to_owned(),
        })
    }
}

enum Action {
    Connect {
        generation: u64,
        room: String,
        credentials: Credentials,
    },
    Stop(u64),
    Configure(u64),
    Devices,
}
#[derive(Clone)]
pub struct Media {
    sender: mpsc::Sender<Action>,
}
impl Media {
    pub fn new(app: tauri::AppHandle, model: Shared) -> Self {
        let (sender, mut receiver) = mpsc::channel(16);
        // The actor is the sole owner of device lifecycle. No devices are initialized at startup.
        tauri::async_runtime::spawn(async move {
            let mut active: Option<Voice> = None;
            loop {
                let action = tokio::select! {
                    action=receiver.recv()=>match action {Some(action)=>action,None=>break},
                    event=next_event(&mut active)=> {
                        if let Some(event)=event {
                            if let Some(voice)=&mut active {
                                match event {
                                    RoomEvent::TrackSubscribed {track:RemoteTrack::Audio(track),participant,..}=> {
                                        let socket=socket_of(&participant.identity().to_string()).unwrap_or_default();
                                        voice.remote.insert(track.sid().to_string(),(socket,track));
                                        voice.configure(&model);
                                    }
                                    RoomEvent::ActiveSpeakersChanged {speakers}=> {
                                        let heard=speakers.iter().filter_map(|speaker|socket_of(&speaker.identity().to_string())).collect();
                                        if speaking(&model,voice.generation,heard) {publish(&app,&model);}
                                    }
                                    RoomEvent::TrackUnsubscribed {track:RemoteTrack::Audio(track),..}=> {voice.remote.remove(&track.sid().to_string());}
                                    RoomEvent::TrackPublished {..}=> {voice.configure(&model);}
                                    RoomEvent::Reconnecting=>status(&app,&model,voice.generation,"reconnecting"),
                                    RoomEvent::Reconnected=> {voice.configure(&model);status(&app,&model,voice.generation,"connected");}
                                    RoomEvent::Disconnected {..}=> {
                                        let generation=voice.generation;
                                        close(&mut active).await;
                                        status(&app,&model,generation,"error");
                                        notice(&app,"A conexão de voz terminou. Use Reconectar voz para solicitar uma nova admissão.");
                                    }
                                    RoomEvent::DataReceived { payload, participant, .. } => {
                                        if let Ok(value) = serde_json::from_slice::<Value>(&payload) {
                                            if value["type"] == "user-state" {
                                                let socket = participant.as_ref().and_then(|p| socket_of(&p.identity().to_string())).unwrap_or_default();
                                                if !socket.is_empty() {
                                                    let changed = model.lock().unwrap_or_else(|e| e.into_inner()).update(
                                                        voice.generation,
                                                        "user-state-updated",
                                                        serde_json::json!({
                                                            "socketId": socket,
                                                            "state": value["state"]
                                                        }),
                                                    );
                                                    if changed {
                                                        publish(&app, &model);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    _=>{}
                                }
                            }
                        } else {close(&mut active).await;}
                        continue;
                    }
                };
                match action {
                    Action::Devices => {
                        if let Some(voice) = &active {
                            devices(&app, &model, &voice.audio);
                        } else if let Ok(audio) = PlatformAudio::new() {
                            devices(&app, &model, &audio);
                        } else {
                            notice(&app, "Não foi possível listar os dispositivos de áudio.");
                        }
                    }
                    Action::Stop(generation) => {
                        if active.as_ref().is_some_and(|v| v.generation <= generation) {
                            close(&mut active).await;
                        }
                        if !model.lock().unwrap_or_else(|e| e.into_inner()).voice_requested {
                            status(&app, &model, generation, "idle");
                        }
                    }
                    Action::Configure(generation) => {
                        if let Some(voice) = active.as_mut().filter(|v| v.generation == generation)
                        {
                            if !voice.configure(&model) {
                                close(&mut active).await;
                                status(&app, &model, generation, "error");
                                notice(&app,"O dispositivo de áudio falhou. A voz foi encerrada; reconecte para tentar novamente.");
                            }
                        }
                    }
                    Action::Connect {
                        generation,
                        room,
                        credentials,
                    } => {
                        if !wanted(&model, generation, &room) {
                            continue;
                        }
                        close(&mut active).await;
                        status(&app, &model, generation, "connecting");
                        match Voice::connect(generation, &credentials).await {
                            Ok(mut voice) => {
                                // A user can leave/switch servers while the SDK awaits ICE. Never start a stale microphone.
                                if !wanted(&model, generation, &room) {
                                    let _ =
                                        timeout(Duration::from_secs(5), voice.room.close()).await;
                                    continue;
                                }
                                if voice.configure(&model) {
                                    status(&app, &model, generation, "connected");
                                    active = Some(voice);
                                } else {
                                    let _ =
                                        timeout(Duration::from_secs(5), voice.room.close()).await;
                                    status(&app, &model, generation, "error");
                                    notice(&app,"Não foi possível iniciar o dispositivo de áudio. Confira o dispositivo e reconecte a voz.");
                                }
                            }
                            Err(error) => {
                                status(&app, &model, generation, "error");
                                notice(&app,error.message);
                            }
                        }
                    }
                }
            }
            close(&mut active).await;
        });
        Self { sender }
    }
    pub fn connect(&self, generation: u64, room: String, value: &Value) -> Result<()> {
        self.sender
            .try_send(Action::Connect {
                generation,
                room,
                credentials: Credentials::parse(value)?,
            })
            .map_err(|_| Error::network())
    }
    pub fn stop(&self, generation: u64) -> Result<()> {
        self.sender
            .try_send(Action::Stop(generation))
            .map_err(|_| Error::network())
    }
    pub fn configure(&self, generation: u64) -> Result<()> {
        self.sender
            .try_send(Action::Configure(generation))
            .map_err(|_| Error::network())
    }
    pub fn devices(&self) -> Result<()> {
        self.sender
            .try_send(Action::Devices)
            .map_err(|_| Error::network())
    }
}
struct Voice {
    generation: u64,
    room: Room,
    events: mpsc::UnboundedReceiver<RoomEvent>,
    audio: PlatformAudio,
    microphone: LocalAudioTrack,
    /// Remote audio tracks by track id, with the hub socket id of whoever publishes each one.
    remote: HashMap<String, (String, RemoteAudioTrack)>,
    input_device: String,
    output_device: String,
}
impl Voice {
    async fn connect(generation: u64, credentials: &Credentials) -> Result<Self> {
        let audio = PlatformAudio::new().map_err(|_| Error::unavailable("O Windows não conseguiu inicializar os dispositivos de áudio."))?;
        audio
            .configure_audio_processing(AudioProcessingOptions::default())
            .map_err(|_| Error::network())?;
        let token = Zeroizing::new(credentials.token.clone());
        let mut options = RoomOptions::default();
        options.auto_subscribe = true;
        let (room, events) = timeout(
            Duration::from_secs(20),
            Room::connect(&credentials.url, &token, options),
        )
        .await
        .map_err(|_| Error::unavailable("A conexão de voz com a VPS excedeu 20 segundos. Use Reconectar voz."))?
        .map_err(|_| Error::unavailable("Não foi possível estabelecer a conexão de voz com a VPS. Use Reconectar voz."))?;
        let microphone = LocalAudioTrack::create_audio_track("microphone", audio.rtc_source());
        microphone.mute();
        let published = timeout(
            Duration::from_secs(10),
            room.local_participant().publish_track(
                LocalTrack::Audio(microphone.clone()),
                TrackPublishOptions {
                    source: TrackSource::Microphone,
                    ..Default::default()
                },
            ),
        )
        .await;
        if !published.is_ok_and(|result| result.is_ok()) {
            let _ = timeout(Duration::from_secs(5), room.close()).await;
            return Err(Error::unavailable("A VPS não confirmou a publicação do microfone. Use Reconectar voz."));
        }
        Ok(Self {
            generation,
            room,
            events,
            audio,
            microphone,
            remote: HashMap::new(),
            input_device: String::new(),
            output_device: String::new(),
        })
    }
    fn configure(&mut self, model: &Shared) -> bool {
        let (muted, deafened, ns, agc, silenced) = {
            let model = model.lock().unwrap_or_else(|e| e.into_inner());
            (
                model.muted || model.server_muted || model.deafened || !model.voice_requested,
                model.deafened,
                model.preferences.noise_suppression,
                model.preferences.automatic_gain_control,
                model.peer_muted.clone(),
            )
        };
        let preferences = model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .preferences
            .clone();
        let Ok(input_device) = crate::audio_device::resolve(&preferences.input_device, true) else { return false; };
        let Ok(output_device) = crate::audio_device::resolve(&preferences.output_device, false) else { return false; };
        if self.input_device != input_device {
            if self
                .audio
                .switch_recording_device(&RecordingDeviceId::from_unchecked_guid(
                    &input_device,
                ))
                .is_err()
            {
                return false;
            }
            self.input_device = input_device;
        }
        if self.output_device != output_device
        {
            if self
                .audio
                .switch_playout_device(&PlayoutDeviceId::from_unchecked_guid(
                    &output_device,
                ))
                .is_err()
            {
                return false;
            }
            self.output_device = output_device;
        }
        if self
            .audio
            .configure_audio_processing(AudioProcessingOptions {
                noise_suppression: ns,
                auto_gain_control: agc,
                ..Default::default()
            })
            .is_err()
        {
            self.microphone.mute();
            let _ = self.audio.stop_recording();
            return false;
        }
        if muted {
            self.microphone.mute();
            let _ = self.audio.stop_recording();
        } else {
            if self.audio.start_recording().is_err() {
                self.microphone.mute();
                return false;
            }
            self.microphone.unmute();
        }
        for (socket, track) in self.remote.values() {
            if deafened || silenced.contains(socket) {
                track.disable();
            } else {
                track.enable();
            }
        }
        for participant in self.room.remote_participants().values() {
            for publication in participant.track_publications().values() {
                if publication.kind() == TrackKind::Audio && publication.is_desired() == deafened {
                    publication.set_subscribed(!deafened);
                }
            }
        }
        true
    }
}
async fn next_event(active: &mut Option<Voice>) -> Option<RoomEvent> {
    if let Some(voice) = active {
        voice.events.recv().await
    } else {
        std::future::pending().await
    }
}
async fn close(active: &mut Option<Voice>) {
    if let Some(voice) = active.take() {
        voice.microphone.mute();
        let _ = voice.audio.stop_recording();
        let _ = timeout(Duration::from_secs(5), voice.room.close()).await;
    }
}
fn wanted(model: &Shared, generation: u64, room: &str) -> bool {
    let model = model.lock().unwrap_or_else(|e| e.into_inner());
    model.generation == generation
        && model.voice_requested
        && model.text_room.as_deref() == Some(room)
        && model.desired_room.as_deref() == Some(room)
}
fn devices(app: &tauri::AppHandle, model: &Shared, audio: &PlatformAudio) {
    let inputs = audio
        .recording_devices()
        .map(|d| serde_json::json!({"id":d.id.as_str(),"name":d.name}))
        .collect();
    let outputs = audio
        .playout_devices()
        .map(|d| serde_json::json!({"id":d.id.as_str(),"name":d.name}))
        .collect();
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        model.input_devices = inputs;
        model.output_devices = outputs;
    }
    publish(app, model);
}
/// The hub socket id inside a LiveKit identity (`<socket>/<uuid>/<kind>`, media_tokens.js), or None for anything else.
pub fn socket_of(identity: &str) -> Option<String> {
    identity
        .split('/')
        .next()
        .filter(|id| !id.is_empty() && id.len() <= 64)
        .map(str::to_owned)
}
fn speaking(model: &Shared, generation: u64, heard: std::collections::HashSet<String>) -> bool {
    let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
    model.generation == generation && model.set_speaking(heard)
}
fn status(app: &tauri::AppHandle, model: &Shared, generation: u64, value: &str) {
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        if model.generation != generation {
            return;
        }
        if value != "connected" {
            model.speaking.clear();
        }
        model.voice_state = value.to_owned();
        model.user_state_notify.notify_one();
    }
    publish(app, model);
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn media_endpoint_is_pinned_and_token_never_debugged() {
        for url in [
            "wss://triscord.217-9-14-79.sslip.io",
            "wss://217-9-14-79.nip.io",
            "wss://triscord.duckdns.org",
        ] {
            assert!(Credentials::parse(&json!({"url":url,"token":"synthetic"})).is_ok());
        }
        for url in [
            "ws://triscord.217-9-14-79.sslip.io",
            "wss://evil.test",
            "wss://triscord.217-9-14-79.sslip.io?token=bad",
            "wss://user@triscord.217-9-14-79.sslip.io",
        ] {
            assert!(Credentials::parse(&json!({"url":url,"token":"synthetic"})).is_err());
        }
    }
    #[test]
    fn a_livekit_identity_names_the_hub_socket_that_owns_it() {
        assert_eq!(socket_of("sock-1/9f1c/voice").as_deref(), Some("sock-1"));
        assert_eq!(socket_of("sock-1").as_deref(), Some("sock-1"));
        assert_eq!(socket_of("/9f1c/voice"), None);
        assert_eq!(socket_of(&"x".repeat(65)), None);
    }
    #[test]
    fn speaking_updates_only_for_the_current_connection() {
        let model = std::sync::Arc::new(std::sync::Mutex::new(crate::model::Model {
            generation: 3,
            ..Default::default()
        }));
        assert!(!speaking(&model, 2, ["a".to_string()].into()));
        assert!(speaking(&model, 3, ["a".to_string()].into()));
        assert!(!speaking(&model, 3, ["a".to_string()].into()), "unchanged: nothing to publish");
    }
    #[test]
    fn stale_admission_cannot_start_audio_after_leave() {
        let model = std::sync::Arc::new(std::sync::Mutex::new(crate::model::Model::default()));
        {
            let mut model = model.lock().unwrap();
            model.generation = 2;
            model.voice_requested = true;
            model.text_room = Some("room".into());
            model.desired_room = Some("room".into());
        }
        assert!(!wanted(&model, 1, "room"));
        assert!(wanted(&model, 2, "room"));
        model.lock().unwrap().voice_requested = false;
        assert!(!wanted(&model, 2, "room"));
    }
    #[test]
    fn data_channel_user_state_updates_room_participants() {
        let mut model = crate::model::Model {
            generation: 1,
            ..Default::default()
        };
        model.rooms.push(json!({
            "id": "room-1",
            "name": "General",
            "users": [{"socketId": "sock-2", "username": "Peer", "isMuted": false, "isDeafened": false}]
        }));
        let changed = model.update(
            1,
            "user-state-updated",
            json!({
                "socketId": "sock-2",
                "state": {"isMuted": true, "isDeafened": true}
            }),
        );
        assert!(changed);
        assert_eq!(model.rooms[0]["users"][0]["isMuted"], true);
        assert_eq!(model.rooms[0]["users"][0]["isDeafened"], true);
    }
}
