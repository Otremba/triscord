use crate::{
    capture::{Pipeline, Source},
    error::{Error, Result},
    media::Credentials,
    model::{notice, publish, Shared},
    video_codec::Config,
};
use livekit::{
    options::{TrackPublishOptions, VideoCodec, VideoEncoding},
    prelude::*,
    webrtc::video_source::{native::NativeVideoSource, RtcVideoSource, VideoResolution},
};
use std::{sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};
enum Action {
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
struct Published {
    generation: u64,
    epoch: u64,
    room: Room,
    _capture: Pipeline,
}
impl Screen {
    pub fn new(app: tauri::AppHandle, model: Shared) -> Self {
        let (sender, mut receiver) = mpsc::channel(8);
        let failures = sender.clone();
        let controller_model = model.clone();
        tauri::async_runtime::spawn(async move {
            let mut wanted: Option<(u64, u64, Source, Config)> = None;
            let mut active: Option<Published> = None;
            while let Some(action) = receiver.recv().await {
                match action {
                    Action::Publish {
                        generation,
                        epoch,
                        source,
                        config,
                    } => {
                        close(&mut active).await;
                        wanted = Some((generation, epoch, source, config));
                    }
                    Action::Stop { generation, epoch } => {
                        if active.as_ref().is_some_and(|state| {
                            state.generation < generation
                                || (state.generation == generation && state.epoch <= epoch)
                        }) {
                            close(&mut active).await;
                        }
                        if wanted.as_ref().is_some_and(|state| {
                            state.0 < generation || (state.0 == generation && state.1 <= epoch)
                        }) {
                            wanted = None;
                        }
                        set_sharing(&app, &model, generation, Some(epoch), false);
                    }
                    Action::Failed { generation, epoch } => {
                        if active.as_ref().is_some_and(|state| {
                            state.generation == generation && state.epoch == epoch
                        }) {
                            close(&mut active).await;
                        }
                        set_sharing(&app, &model, generation, Some(epoch), false);
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
                        let result = connect(
                            generation,
                            epoch,
                            &room,
                            &credentials,
                            source,
                            config,
                            app.clone(),
                            model.clone(),
                            failures.clone(),
                        )
                        .await;
                        match result {
                            Ok(session) => {
                                if !is_current(&model, generation, epoch, &room) {
                                    let mut stale = Some(session);
                                    close(&mut stale).await;
                                    continue;
                                }
                                active = Some(session);
                                set_sharing(&app, &model, generation, Some(epoch), true);
                            }
                            Err(_) => {
                                if is_current(&model, generation, epoch, &room) {
                                    set_sharing(&app, &model, generation, Some(epoch), false);
                                    notice(&app,"Não foi possível iniciar a transmissão por GPU. Confira a fonte e o driver de vídeo.");
                                }
                            }
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
}
async fn connect(
    generation: u64,
    epoch: u64,
    room_id: &str,
    credentials: &Credentials,
    source: Source,
    config: Config,
    app: tauri::AppHandle,
    model: Shared,
    failures: mpsc::Sender<Action>,
) -> Result<Published> {
    let mut options = RoomOptions::default();
    options.auto_subscribe = false;
    let (room, mut events) = timeout(
        Duration::from_secs(20),
        Room::connect(&credentials.url, &credentials.token, options),
    )
    .await
    .map_err(|_| Error::network())?
    .map_err(|_| Error::network())?;
    let video = NativeVideoSource::new_encoded(VideoResolution {
        width: config.width,
        height: config.height,
    });
    let track =
        LocalVideoTrack::create_video_track("screen", RtcVideoSource::Native(video.clone()));
    let result = timeout(
        Duration::from_secs(10),
        room.local_participant().publish_track(
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
    .await;
    if !result.is_ok_and(|result| result.is_ok()) {
        let _ = timeout(Duration::from_secs(5), room.close()).await;
        return Err(Error::network());
    }
    if !is_current(&model, generation, epoch, room_id) {
        let _ = timeout(Duration::from_secs(5), room.close()).await;
        return Err(Error::invalid());
    }
    let failure_app = app.clone();
    let failure_model = model.clone();
    let event_failures = failures.clone();
    let capture = Pipeline::start(
        source,
        config,
        video,
        Arc::new(move || {
            let current = {
                let model = failure_model.lock().unwrap_or_else(|e| e.into_inner());
                model.generation == generation
                    && model.screen_epoch == epoch
                    && model.screen_requested
            };
            if !current {
                return;
            }
            set_sharing(&failure_app, &failure_model, generation, Some(epoch), false);
            let _ = failures.try_send(Action::Failed { generation, epoch });
            notice(&failure_app,"A captura ou o codificador de vídeo foi encerrado. Inicie a transmissão novamente para tentar outra fonte.");
        }),
    );
    let capture = match capture {
        Ok(capture) => capture,
        Err(error) => {
            let _ = timeout(Duration::from_secs(5), room.close()).await;
            return Err(error);
        }
    };
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let current = {
                let model = model.lock().unwrap_or_else(|e| e.into_inner());
                model.generation == generation
                    && model.screen_epoch == epoch
                    && model.screen_requested
            };
            if !current {
                break;
            }
            match event {
                RoomEvent::Disconnected { .. } => {
                    set_sharing(&app, &model, generation, Some(epoch), false);
                    let _ = event_failures.try_send(Action::Failed { generation, epoch });
                    notice(&app, "A conexão da transmissão terminou.");
                    break;
                }
                RoomEvent::Reconnecting => notice(&app, "Reconectando a transmissão…"),
                _ => {}
            }
        }
    });
    Ok(Published {
        generation,
        epoch,
        room,
        _capture: capture,
    })
}
async fn close(active: &mut Option<Published>) {
    if let Some(active) = active.take() {
        drop(active._capture);
        let _ = timeout(Duration::from_secs(5), active.room.close()).await;
    }
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
fn set_sharing(
    app: &tauri::AppHandle,
    model: &Shared,
    generation: u64,
    epoch: Option<u64>,
    on: bool,
) {
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        if model.generation != generation || epoch.is_some_and(|epoch| model.screen_epoch != epoch)
        {
            return;
        }
        model.sharing = on;
        if !on {
            model.screen_requested = false;
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
        let model = std::sync::Arc::new(std::sync::Mutex::new(crate::model::Model {
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
        let model = std::sync::Arc::new(std::sync::Mutex::new(crate::model::Model {
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
}
