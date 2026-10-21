use crate::{
    api::HUB,
    control::{self, Packet},
    error::{Error, Result},
    media::Media,
    model::{notice, publish, Shared},
};
use futures_util::{Sink, SinkExt, StreamExt};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{sleep, sleep_until, timeout, Instant},
};
use tokio_tungstenite::tungstenite::{protocol::WebSocketConfig, Message};
use zeroize::Zeroizing;

pub struct Socket {
    sender: mpsc::Sender<(String, Value)>,
    task: JoinHandle<()>,
}
impl Drop for Socket {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Socket {
    pub fn start(
        app: tauri::AppHandle,
        model: Shared,
        server: String,
        token: String,
        generation: u64,
        media: Media,
    ) -> Self {
        let (sender, mut receiver) = mpsc::channel::<(String, Value)>(32);
        let task = tokio::spawn(async move {
            let token = Zeroizing::new(token);
            let mut attempt = 0;
            let mut desired_room: Option<Value> = None;
            loop {
                set_status(
                    &app,
                    &model,
                    generation,
                    if attempt == 0 {
                        "connecting"
                    } else {
                        "reconnecting"
                    },
                );
                let mut url = reqwest::Url::parse(HUB).expect("constant URL");
                url.set_scheme("wss").expect("constant scheme");
                url.set_path("/socket.io/");
                url.query_pairs_mut()
                    .append_pair("EIO", "4")
                    .append_pair("transport", "websocket")
                    .append_pair("serverId", &server)
                    .append_pair("sessionToken", &token);
                // URLs carry a bearer token. Never propagate tungstenite error text to logs or IPC.
                let connect = timeout(
                    Duration::from_secs(10),
                    tokio_tungstenite::connect_async_with_config(
                        url.as_str(),
                        Some(
                            WebSocketConfig::default()
                                .max_message_size(Some(2 * 1024 * 1024))
                                .max_frame_size(Some(2 * 1024 * 1024)),
                        ),
                        false,
                    ),
                )
                .await;
                if let Ok(Ok((mut socket, _))) = connect {
                    let mut opened = false;
                    let mut ready = false;
                    let mut heartbeat = Duration::from_secs(45);
                    let mut deadline = Instant::now() + Duration::from_secs(15);
                    let connected_at = Instant::now();
                    let mut terminal = false;
                    loop {
                        tokio::select! {
                            _=sleep_until(deadline) => break,
                            outgoing=receiver.recv() => {
                                let Some((name,payload))=outgoing else { return; };
                                if !ready { continue; } // Never replay stale commands across a reconnect.
                                if name=="join-room" { desired_room=Some(payload.clone()); }
                                if name=="leave-room" { desired_room=None; }
                                if !send(&mut socket,Message::Text(format!("42{}",json!([name,payload])).into())).await { break; }
                            }
                            incoming=socket.next() => {
                                let Some(Ok(message))=incoming else { break; };
                                match message {
                                    Message::Text(text) => match control::parse(&text) {
                                        Ok(Packet::Open {heartbeat:duration}) if !opened => {
                                            opened=true; heartbeat=duration; deadline=Instant::now()+heartbeat;
                                            if !send(&mut socket,Message::Text("40".into())).await { break; }
                                        }
                                        Ok(Packet::Pong(value)) if opened => {
                                            deadline=Instant::now()+heartbeat;
                                            if !send(&mut socket,Message::Text(value.into())).await { break; }
                                        }
                                        Ok(Packet::Ready) if opened && !ready => {
                                            ready=true;
                                            set_status(&app,&model,generation,"connected");
                                            if let Some(payload)=&desired_room {
                                                if !send(&mut socket,Message::Text(format!("42{}",json!(["join-room",payload])).into())).await { break; }
                                            }
                                        }
                                        Ok(Packet::Event(name,payload)) if ready => {
                                            if name=="room-join-denied" || name=="kicked" { desired_room=None; notice(&app,"A entrada na sala foi recusada ou encerrada pelo servidor."); }
                                            let changed=model.lock().unwrap_or_else(|e|e.into_inner()).update(generation,&name,payload.clone());
                                            if name=="room-joined" {
                                                let (voice_requested,muted,deafened)={let m=model.lock().unwrap_or_else(|e|e.into_inner());(m.voice_requested,m.muted||m.server_muted||!m.voice_requested,m.deafened)};
                                                if voice_requested {
                                                    if payload["mediaTransport"]!="livekit" || media.connect(generation,payload["roomId"].as_str().unwrap_or_default().to_owned(),&payload["media"]["voice"]).is_err() {notice(&app,"Esta sala não forneceu uma admissão de voz válida. Atualize os clientes ou entre em uma sala nova.");}
                                                }
                                                if !send(&mut socket,Message::Text(format!("42{}",json!(["user-state-change",{"isMuted":muted,"isDeafened":deafened}])).into())).await { break; }
                                            }
                                            if name=="kicked" {let _=media.stop(generation);}
                                            if name=="force-muted" {let _=media.configure(generation);}
                                            if name=="request-error" || name=="service-limit" || name=="chat-rate-limited" { notice(&app,"O servidor recusou a operação. Aguarde antes de tentar novamente."); }
                                            if changed { publish(&app,&model); }
                                        }
                                        Ok(Packet::Closed) | Err(_) => break,
                                        _ => {}
                                    },
                                    Message::Close(frame) => {
                                        terminal=frame.is_some_and(|f|u16::from(f.code)==1008);
                                        break;
                                    }
                                    Message::Ping(bytes) => { if !send(&mut socket,Message::Pong(bytes)).await { break; } }
                                    _ => {}
                                }
                            }
                        }
                    }
                    clear_membership(&app, &model, generation);
                    let _ = media.stop(generation);
                    if terminal {
                        set_status(&app, &model, generation, "offline");
                        notice(&app,"A sessão foi recusada. Entre novamente ou selecione o servidor para tentar outra vez.");
                        return;
                    }
                    // Short-lived connections do not reset backoff and create a tight retry loop.
                    if connected_at.elapsed() > Duration::from_secs(60) {
                        attempt = 0;
                    }
                }
                while receiver.try_recv().is_ok() {} // Commands from the failed connection are stale.
                set_status(&app, &model, generation, "reconnecting");
                sleep(control::retry_delay(attempt)).await;
                attempt = attempt.saturating_add(1);
            }
        });
        Self { sender, task }
    }
    pub fn send(&self, name: &str, payload: Value) -> Result<()> {
        self.sender
            .try_send((name.to_owned(), payload))
            .map_err(|_| Error::network())
    }
}
async fn send<S: Sink<Message> + Unpin>(socket: &mut S, message: Message) -> bool {
    // A blocked TCP writer must not suspend the heartbeat/reconnect state machine indefinitely.
    timeout(Duration::from_secs(5), socket.send(message))
        .await
        .is_ok_and(|result| result.is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    struct Blocked;
    impl Sink<Message> for Blocked {
        type Error = ();
        fn poll_ready(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), ()>> {
            Poll::Pending
        }
        fn start_send(self: Pin<&mut Self>, _: Message) -> std::result::Result<(), ()> {
            Ok(())
        }
        fn poll_flush(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), ()>> {
            Poll::Pending
        }
        fn poll_close(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), ()>> {
            Poll::Ready(Ok(()))
        }
    }
    #[tokio::test(start_paused = true)]
    async fn blocked_writer_cannot_freeze_reconnection() {
        let started = Instant::now();
        assert!(!send(&mut Blocked, Message::Text("3".into())).await);
        assert_eq!(started.elapsed(), Duration::from_secs(5));
    }
}
fn set_status(app: &tauri::AppHandle, model: &Shared, generation: u64, status: &'static str) {
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        if model.generation != generation {
            return;
        }
        model.connection = status;
    }
    publish(app, model);
}
fn clear_membership(app: &tauri::AppHandle, model: &Shared, generation: u64) {
    {
        let mut model = model.lock().unwrap_or_else(|e| e.into_inner());
        if model.generation != generation {
            return;
        }
        model.text_room = None;
        model.chat.clear();
    }
    publish(app, model);
}
