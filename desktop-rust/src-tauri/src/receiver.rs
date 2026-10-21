use crate::{
    error::{Error, Result},
    model::{publish, Shared},
    presenter::Presenter,
};
use futures_util::StreamExt;
use livekit::{prelude::*, webrtc::video_stream::native::NativeVideoStream};
use serde_json::json;
use tauri::async_runtime::JoinHandle;

pub struct Reader {
    id: String,
    presenter: Presenter,
    model: Shared,
    app: tauri::AppHandle,
    task: JoinHandle<()>,
}
impl Reader {
    pub fn start(
        track: RemoteVideoTrack,
        title: String,
        owner: String,
        generation: u64,
        epoch: u64,
        model: Shared,
        app: tauri::AppHandle,
        presenter: Presenter,
    ) -> Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        presenter.register(&id)?;
        {
            let mut state = model.lock().unwrap_or_else(|e| e.into_inner());
            if state.generation != generation
                || state.membership_epoch != epoch
                || state.streams.len() >= 8
            {
                presenter.remove(&id);
                return Err(Error::invalid());
            }
            state.streams.push(json!({"id":id,"kind":"screen","ownerId":owner,"title":title,"width":0,"height":0,"loading":true,"hidden":false,"path":"native-overlay"}));
        }
        publish(&app, &model);
        let (frame_id, frame_model, frame_presenter, frame_app) =
            (id.clone(), model.clone(), presenter.clone(), app.clone());
        let task = tauri::async_runtime::spawn(async move {
            let mut stream = NativeVideoStream::new(track.rtc_track());
            let mut dimensions = (0, 0);
            while let Some(frame) = stream.next().await {
                let current = {
                    let state = frame_model.lock().unwrap_or_else(|e| e.into_inner());
                    state.generation == generation && state.membership_epoch == epoch
                };
                if !current {
                    break;
                }
                let size = (frame.buffer.width(), frame.buffer.height());
                if dimensions != size {
                    dimensions = size;
                    if let Some(value) = frame_model
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .streams
                        .iter_mut()
                        .find(|value| value["id"] == frame_id)
                    {
                        value["loading"] = false.into();
                        value["width"] = size.0.into();
                        value["height"] = size.1.into();
                    }
                    publish(&frame_app, &frame_model);
                }
                frame_presenter.submit(&frame_id, frame);
            }
            stream.close();
            let current = {
                let state = frame_model.lock().unwrap_or_else(|e| e.into_inner());
                state.generation == generation && state.membership_epoch == epoch
            };
            if current {
                frame_presenter.remove(&frame_id);
                frame_model
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .streams
                    .retain(|value| value["id"] != frame_id);
                publish(&frame_app, &frame_model);
                crate::model::notice(&frame_app, "A recepção de uma transmissão terminou.");
            }
        });
        Ok(Self {
            id,
            presenter,
            model,
            app,
            task,
        })
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.task.abort();
        self.presenter.remove(&self.id);
        self.model
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .streams
            .retain(|value| value["id"] != self.id);
        publish(&self.app, &self.model);
    }
}
