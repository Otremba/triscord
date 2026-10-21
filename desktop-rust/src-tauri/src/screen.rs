use crate::{
    capture::{Pipeline, Source},
    error::{Error, Result},
    media::Credentials,
    model::{notice, publish, Shared},
    presenter::Presenter,
    receiver::Reader,
    video_codec::Config,
};
use livekit::{
    options::{TrackPublishOptions, VideoCodec, VideoEncoding},
    prelude::*,
    webrtc::video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};

enum Action {
    Watch {
        generation: u64,
        membership: u64,
        room: String,
        credentials: Credentials,
    },
    Publish {
        generation: u64,
        epoch: u64,
        source: Source,
        config: Config,
    },
    Admission {
        generation: u64,
        room: String,
        credentials: Credentials,
    },
    Stop {
        generation: u64,
        epoch: u64,
    },
    Leave {
        generation: u64,
        membership: u64,
    },
    Failed {
        generation: u64,
        epoch: u64,
    },
}
#[derive(Clone)]
pub struct Screen {
    sender: mpsc::Sender<Action>,
    model: Shared,
}
struct Publication {
    epoch: u64,
    track: LocalTrackPublication,
    capture: Pipeline,
}
struct Session {
    generation: u64,
    membership: u64,
    room_id: String,
    room: Room,
    events: mpsc::UnboundedReceiver<RoomEvent>,
    readers: HashMap<String, Reader>,
    publication: Option<Publication>,
}
impl Session {
    async fn connect(
        generation: u64,
        membership: u64,
        room_id: String,
        credentials: &Credentials,
    ) -> Result<Self> {
        let mut options = RoomOptions::default();
        options.auto_subscribe = false;
        let (room, events) = timeout(
            Duration::from_secs(20),
            Room::connect(&credentials.url, &credentials.token, options),
        )
        .await
        .map_err(|_| Error::unavailable("A conexão das transmissões com a VPS excedeu 20 segundos. Entre novamente na sala."))?
        .map_err(|_| Error::unavailable("Não foi possível estabelecer a conexão das transmissões com a VPS. Entre novamente na sala."))?;
        let session = Self {
            generation,
            membership,
            room_id,
            room,
            events,
            readers: HashMap::new(),
            publication: None,
        };
        session.subscribe();
        Ok(session)
    }
    fn subscribe(&self) {
        let mut count = 0;
        for participant in self.room.remote_participants().values() {
            for publication in participant.track_publications().values() {
                if publication.kind() == TrackKind::Video
                    && publication.source() == TrackSource::Screenshare
                {
                    if publication.is_desired() != (count < 8) { publication.set_subscribed(count < 8); }
                    count += 1;
                } else {
                    if publication.is_desired() { publication.set_subscribed(false); }
                }
            }
        }
    }
    async fn stop_publish(&mut self) {
        if let Some(publication) = self.publication.take() {
            drop(publication.capture);
            let _ = timeout(
                Duration::from_secs(5),
                self.room
                    .local_participant()
                    .unpublish_track(&publication.track.sid()),
            )
            .await;
        }
    }
    async fn publish(
        &mut self,
        generation: u64,
        epoch: u64,
        source: Source,
        config: Config,
        model: Shared,
        app: tauri::AppHandle,
        failures: mpsc::WeakSender<Action>,
    ) -> Result<()> {
        self.stop_publish().await;
        if !is_current(&model, generation, epoch, &self.room_id) {
            return Err(Error::invalid());
        }
        let video = NativeVideoSource::new_encoded(VideoResolution {
            width: config.width,
            height: config.height,
        });
        let track =
            LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(video.clone()));
        let publication = timeout(
            Duration::from_secs(10),
            self.room.local_participant().publish_track(
                LocalTrack::Video(track),
                TrackPublishOptions {
                    source: TrackSource::Screenshare,
                    video_codec: VideoCodec::H264,
                    video_encoding: Some(VideoEncoding {
                        max_bitrate: config.bitrate as u64,
                        max_framerate: config.fps as f64,
                    }),
                    simulcast: false,
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|_| Error::network())?
        .map_err(|_| Error::network())?;
        if !is_current(&model, generation, epoch, &self.room_id) {
            let _ = timeout(
                Duration::from_secs(5),
                self.room
                    .local_participant()
                    .unpublish_track(&publication.sid()),
            )
            .await;
            return Err(Error::invalid());
        }
        let failure_model = model.clone();
        let failure_app = app.clone();
        let capture = Pipeline::start(
            source,
            config,
            video,
            Arc::new(move || {
                let current = {
                    let state = failure_model.lock().unwrap_or_else(|e| e.into_inner());
                    state.generation == generation
                        && state.screen_epoch == epoch
                        && state.screen_requested
                };
                if !current {
                    return;
                }
                set_sharing(&failure_app, &failure_model, generation, epoch, false);
                if let Some(sender) = failures.upgrade() {
                    let _ = sender.try_send(Action::Failed { generation, epoch });
                }
                notice(
                    &failure_app,
                    "A captura ou o codificador terminou. Inicie a transmissão novamente.",
                );
            }),
        );
        match capture {
            Ok(capture) => {
                self.publication = Some(Publication {
                    epoch,
                    track: publication,
                    capture,
                });
                set_sharing(&app, &model, generation, epoch, true);
                Ok(())
            }
            Err(error) => {
                let _ = timeout(
                    Duration::from_secs(5),
                    self.room
                        .local_participant()
                        .unpublish_track(&publication.sid()),
                )
                .await;
                Err(error)
            }
        }
    }
}
impl Screen {
    pub fn new(app: tauri::AppHandle, model: Shared, presenter: Presenter) -> Self {
        let (sender, mut receiver) = mpsc::channel(16);
        let failures = sender.downgrade();
        let controller_model = model.clone();
        tauri::async_runtime::spawn(async move {
            let mut active: Option<Session> = None;
            let mut wanted: Option<(u64, u64, Source, Config)> = None;
            loop {
                let action = tokio::select! {
                    action=receiver.recv()=>match action {Some(action)=>action,None=>break},
                    event=next_event(&mut active)=>{
                        let Some(session)=active.as_mut() else {continue};
                        let current=watching(&model,session.generation,session.membership,&session.room_id);
                        if !current {close(&mut active).await;continue;}
                        match event {
                            Some(RoomEvent::TrackSubscribed {track:RemoteTrack::Video(track),participant,publication})=>{
                                let sid=publication.sid().to_string();
                                if !session.readers.contains_key(&sid)&&session.readers.len()<8&&publication.source()==TrackSource::Screenshare {
                                    if let Ok(reader)=Reader::start(track,participant.name(),crate::media::socket_of(&participant.identity().to_string()).unwrap_or_default(),session.generation,session.membership,model.clone(),app.clone(),presenter.clone()){session.readers.insert(sid,reader);}
                                }
                            },
                            Some(RoomEvent::TrackUnsubscribed {publication,..})=>{session.readers.remove(&publication.sid().to_string());},
                            Some(RoomEvent::TrackPublished {..})|Some(RoomEvent::Reconnected)=>session.subscribe(),
                            Some(RoomEvent::Reconnecting)=>notice(&app,"Reconectando as transmissões…"),
                            Some(RoomEvent::Disconnected {..})|None=>{
                                let generation=session.generation;let epoch=model.lock().unwrap_or_else(|e|e.into_inner()).screen_epoch;
                                close(&mut active).await;set_sharing(&app,&model,generation,epoch,false);
                                notice(&app,"A conexão das transmissões terminou. Entre novamente na sala para recuperar a recepção.");
                            },
                            _=>{}
                        }
                        continue;
                    }
                };
                match action {
                    Action::Watch {
                        generation,
                        membership,
                        room,
                        credentials,
                    } => {
                        if !watching(&model, generation, membership, &room) {
                            continue;
                        }
                        close(&mut active).await;
                        wanted = None;
                        match Session::connect(generation, membership, room.clone(), &credentials)
                            .await
                        {
                            Ok(session) if watching(&model, generation, membership, &room) => {
                                active = Some(session)
                            }
                            Ok(session) => {
                                let mut stale = Some(session);
                                close(&mut stale).await;
                            }
                            Err(error) => {
                                if watching(&model, generation, membership, &room) {
                                    notice(
                                        &app,
                                        error.message,
                                    );
                                }
                            }
                        }
                    }
                    Action::Publish {
                        generation,
                        epoch,
                        source,
                        config,
                    } => {
                        wanted = Some((generation, epoch, source, config));
                    }
                    Action::Admission {
                        generation,
                        room,
                        credentials,
                    } => {
                        let Some((wanted_generation, epoch, _, _)) = wanted.as_ref() else {
                            continue;
                        };
                        if *wanted_generation != generation
                            || !is_current(&model, generation, *epoch, &room)
                        {
                            continue;
                        }
                        let (_, epoch, source, config) = wanted.take().expect("validated request");
                        let membership = model
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .membership_epoch;
                        if !active.as_ref().is_some_and(|session| {
                            session.generation == generation
                                && session.membership == membership
                                && session.room_id == room
                        }) {
                            close(&mut active).await;
                            if let Ok(session) =
                                Session::connect(generation, membership, room.clone(), &credentials)
                                    .await
                            {
                                active = Some(session);
                            }
                        }
                        if !is_current(&model, generation, epoch, &room) {
                            continue;
                        }
                        let result = if let Some(session) = active.as_mut() {
                            session
                                .publish(
                                    generation,
                                    epoch,
                                    source,
                                    config,
                                    model.clone(),
                                    app.clone(),
                                    failures.clone(),
                                )
                                .await
                        } else {
                            Err(Error::network())
                        };
                        if result.is_err() && is_current(&model, generation, epoch, &room) {
                            set_sharing(&app, &model, generation, epoch, false);
                            notice(&app,"Não foi possível iniciar a transmissão por GPU. Confira a fonte e o driver de vídeo.");
                        }
                    }
                    Action::Stop { generation, epoch } | Action::Failed { generation, epoch } => {
                        if let Some(session) = active.as_mut().filter(|session| {
                            session.generation == generation
                                && session
                                    .publication
                                    .as_ref()
                                    .is_some_and(|publication| publication.epoch <= epoch)
                        }) {
                            session.stop_publish().await;
                        }
                        if wanted
                            .as_ref()
                            .is_some_and(|request| request.0 == generation && request.1 <= epoch)
                        {
                            wanted = None;
                        }
                        set_sharing(&app, &model, generation, epoch, false);
                    }
                    Action::Leave {
                        generation,
                        membership,
                    } => {
                        if active.as_ref().is_some_and(|session| {
                            session.generation < generation
                                || (session.generation == generation
                                    && session.membership <= membership)
                        }) {
                            close(&mut active).await;
                        }
                        if wanted
                            .as_ref()
                            .is_some_and(|request| request.0 <= generation)
                        {
                            wanted = None;
                        }
                    }
                }
            }
            close(&mut active).await;
        });
        Self {
            sender,
            model: controller_model,
        }
    }
    pub fn watch(&self, generation: u64, room: String, value: &serde_json::Value) -> Result<()> {
        let membership = self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .membership_epoch;
        self.sender
            .try_send(Action::Watch {
                generation,
                membership,
                room,
                credentials: Credentials::parse(value)?,
            })
            .map_err(|_| Error::network())
    }
    pub fn start(&self, generation: u64, epoch: u64, source: Source, config: Config) -> Result<()> {
        self.sender
            .try_send(Action::Publish {
                generation,
                epoch,
                source,
                config,
            })
            .map_err(|_| Error::network())
    }
    pub fn admission(
        &self,
        generation: u64,
        room: String,
        value: &serde_json::Value,
    ) -> Result<()> {
        self.sender
            .try_send(Action::Admission {
                generation,
                room,
                credentials: Credentials::parse(value)?,
            })
            .map_err(|_| Error::network())
    }
    pub fn stop(&self, generation: u64) -> Result<()> {
        let epoch = self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .screen_epoch;
        self.sender
            .try_send(Action::Stop { generation, epoch })
            .map_err(|_| Error::network())
    }
    pub fn leave(&self, generation: u64) -> Result<()> {
        let membership = self
            .model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .membership_epoch;
        self.sender
            .try_send(Action::Leave {
                generation,
                membership,
            })
            .map_err(|_| Error::network())
    }
}
async fn next_event(active: &mut Option<Session>) -> Option<RoomEvent> {
    match active {
        Some(session) => session.events.recv().await,
        None => std::future::pending().await,
    }
}
async fn close(active: &mut Option<Session>) {
    if let Some(mut session) = active.take() {
        session.readers.clear();
        session.stop_publish().await;
        let _ = timeout(Duration::from_secs(5), session.room.close()).await;
    }
}
fn watching(model: &Shared, generation: u64, membership: u64, room: &str) -> bool {
    let model = model.lock().unwrap_or_else(|e| e.into_inner());
    model.generation == generation
        && model.membership_epoch == membership
        && model.text_room.as_deref() == Some(room)
}
fn is_current(model: &Shared, generation: u64, epoch: u64, room: &str) -> bool {
    let model = model.lock().unwrap_or_else(|e| e.into_inner());
    model.generation == generation
        && model.screen_epoch == epoch
        && model.text_room.as_deref() == Some(room)
        && model.screen_requested
}
pub fn pending_admission(model: &Shared, generation: u64, epoch: u64) -> bool {
    let model = model.lock().unwrap_or_else(|e| e.into_inner());
    model.generation == generation
        && model.screen_epoch == epoch
        && model.screen_requested
        && !model.screen_admitting
}
fn set_sharing(app: &tauri::AppHandle, model: &Shared, generation: u64, epoch: u64, on: bool) {
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        if model.generation != generation || model.screen_epoch != epoch {
            return;
        }
        model.sharing = on;
        if !on {
            model.screen_requested = false;
            model.sharing_name.clear();
        }
        model.user_state_notify.notify_one();
    }
    publish(app, model);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_new_share_invalidates_an_older_publish_in_the_same_connection() {
        let model = Arc::new(std::sync::Mutex::new(crate::model::Model {
            generation: 4,
            screen_epoch: 2,
            screen_requested: true,
            text_room: Some("room".into()),
            ..Default::default()
        }));
        assert!(!is_current(&model, 4, 1, "room"));
        assert!(is_current(&model, 4, 2, "room"));
        model.lock().unwrap().text_room = Some("other".into());
        assert!(!is_current(&model, 4, 2, "room"));
    }
    #[test]
    fn admission_retries_stop_after_reply_cancel_or_replacement() {
        let model = Arc::new(std::sync::Mutex::new(crate::model::Model {
            generation: 4,
            screen_epoch: 2,
            screen_requested: true,
            ..Default::default()
        }));
        assert!(pending_admission(&model, 4, 2));
        model.lock().unwrap().screen_admitting = true;
        assert!(!pending_admission(&model, 4, 2));
        model.lock().unwrap().screen_admitting = false;
        model.lock().unwrap().screen_epoch = 3;
        assert!(!pending_admission(&model, 4, 2));
        model.lock().unwrap().screen_requested = false;
        assert!(!pending_admission(&model, 4, 3));
    }
    #[test]
    fn leaving_and_rejoining_the_same_room_invalidates_old_readers() {
        let model = Arc::new(std::sync::Mutex::new(crate::model::Model {
            generation: 4,
            membership_epoch: 2,
            text_room: Some("room".into()),
            ..Default::default()
        }));
        assert!(watching(&model, 4, 2, "room"));
        model.lock().unwrap().membership_epoch += 1;
        assert!(!watching(&model, 4, 2, "room"));
    }
}
