#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
mod capture;
mod clipboard;
mod control;
mod core;
mod error;
mod media;
mod model;
mod oauth;
mod presenter;
mod profiles;
mod receiver;
mod screen;
mod settings;
mod socket;
mod vault;
mod video_codec;
mod video_gpu;
mod audio_loopback;
mod sound;
mod updater;
mod window;

use tauri::Manager;
use tokio::sync::Mutex;

#[tauri::command]
async fn dispatch(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<core::Core>>,
    command: serde_json::Value,
) -> error::Result<serde_json::Value> {
    if command.to_string().len() > 65536 {
        return Err(error::Error::invalid());
    }
    // Geometry, window moves and the page's telemetry must not contend with a slow login or REST request holding the
    // core lock (they come many times a second and an "operation busy" answer to them would be an error toast).
    let presenter = app.state::<presenter::Presenter>();
    match command["name"].as_str() {
        Some("videoSurface") => {
            let id = command["streamId"]
                .as_str()
                .filter(|id| id.len() <= 64)
                .ok_or_else(error::Error::invalid)?;
            let rect = serde_json::from_value(command["rect"].clone())
                .map_err(|_| error::Error::invalid())?;
            presenter.layout(
                id,
                rect,
                command["scale"]
                    .as_f64()
                    .ok_or_else(error::Error::invalid)?,
            )?;
            return Ok(serde_json::Value::Null);
        }
        Some("videoOccluders") => {
            presenter.occluders(
                serde_json::from_value(command["rects"].clone())
                    .map_err(|_| error::Error::invalid())?,
            )?;
            return Ok(serde_json::Value::Null);
        }
        Some("videoStageOccluders") => {
            presenter.stage_occluders(
                serde_json::from_value(command["rects"].clone())
                    .map_err(|_| error::Error::invalid())?,
            )?;
            return Ok(serde_json::Value::Null);
        }
        Some("videoRole") => {
            let id = command["streamId"]
                .as_str()
                .filter(|id| id.len() <= 64)
                .ok_or_else(error::Error::invalid)?;
            presenter.role(id, command["role"].as_str().unwrap_or_default())?;
            return Ok(serde_json::Value::Null);
        }
        // Frame-pacing telemetry of the C++ overlays and the focused-card hint: the GPU presenter needs neither.
        Some("videoIdle" | "videoStats" | "videoAck" | "setCallFocus") => {
            return Ok(serde_json::Value::Null)
        }
        Some("window") => return window::action(&app, command["action"].as_str().unwrap_or_default()),
        _ => {}
    }
    let mut core = state.try_lock().map_err(|_| error::Error {
        code: "busy",
        message: "Aguarde a operação atual terminar.",
    })?;
    let result = if command["name"] == "refreshServers" {
        core.refresh().await
    } else {
        match serde_json::from_value(command) {
            Ok(command) => core.dispatch(&app, command).await,
            Err(_) => Err(error::Error::invalid()),
        }
    };
    model::publish(&app, &core.model);
    result
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // Separate identifier/data directory; never read Qt settings or the installed app's session.
            let directory = app.path().app_local_data_dir()?;
            // Development validation must never reuse a session from another running build.
            #[cfg(debug_assertions)]
            let directory = match std::env::var_os("TRISCORD_TEST_DATA_DIR") {
                Some(path) => {
                    let path = std::path::PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err(std::io::Error::other("TRISCORD_TEST_DATA_DIR must be absolute").into());
                    }
                    path
                }
                None => directory,
            };
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| std::io::Error::other("main window missing"))?;
            let presenter =
                presenter::Presenter::new(window.hwnd()?.0 as usize, app.handle().clone());
            app.manage(presenter.clone());
            let core = core::Core::new(directory, app.handle().clone(), presenter)
                .map_err(|e| std::io::Error::other(e.message))?;
            app.manage(Mutex::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .run(tauri::generate_context!())
        .expect("could not initialize Triscord Rust Preview");
}
