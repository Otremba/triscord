#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
mod audio_device;
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
mod mic_test;
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
        Some("setCallFocus") => {
            let key = command["key"]
                .as_str()
                .filter(|k| !k.is_empty() && k.len() <= 64)
                .map(str::to_owned);
            let film_open = command["filmOpen"].as_bool().unwrap_or(true);
            let focus = key.map(|k| serde_json::json!({ "key": k, "filmOpen": film_open }));
            let core = state.lock().await;
            core.model.lock().unwrap_or_else(|e| e.into_inner()).call_focus = focus;
            model::publish(&app, &core.model);
            return Ok(serde_json::Value::Null);
        }
        // Frame-pacing telemetry of the C++ overlays: the GPU presenter needs neither.
        Some("videoIdle" | "videoStats" | "videoAck") => {
            return Ok(serde_json::Value::Null)
        }
        Some("startMicTest") => {
            let input = command["inputDevice"].as_str().unwrap_or_default().to_string();
            let output = command["outputDevice"].as_str().unwrap_or_default().to_string();
            mic_test::start(app.clone(), input, output);
            return Ok(serde_json::Value::Null);
        }
        Some("stopMicTest") => {
            mic_test::stop();
            return Ok(serde_json::Value::Null);
        }
        Some("applyUpdate") => {
            updater::apply_cached_update()?;
            return Ok(serde_json::Value::Null);
        }
        Some("playCue") => {
            let cue = match command["cue"].as_str() {
                Some("join" | "userJoin") => Some(sound::CallSound::Join),
                Some("leave" | "userLeave") => Some(sound::CallSound::Leave),
                Some("mute") => Some(sound::CallSound::Mute),
                Some("unmute") => Some(sound::CallSound::Unmute),
                Some("deafen") => Some(sound::CallSound::Deafen),
                Some("undeafen") => Some(sound::CallSound::Undeafen),
                _ => None,
            };
            if let Some(c) = cue {
                sound::play_cue(c);
            }
            return Ok(serde_json::Value::Null);
        }
        Some("window") => return window::action(&app, command["action"].as_str().unwrap_or_default()),
        _ => {}
    }
    let mut core = state.lock().await;
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
    // Configure WebView2 arguments for unconstrained, ultra-fluid 120+ FPS rendering:
    // - --disable-frame-rate-limit: removes the 60fps compositor limit so rendering runs at 120Hz/144Hz/240Hz
    // - --ignore-gpu-blocklist: forces full D3D11 / GPU hardware acceleration
    // - --enable-gpu-rasterization: GPU rasterization for all layers
    // - --enable-zero-copy: fast zero-copy video and surface compositing
    // - --disable-background-timer-throttling & --disable-backgrounding-occluded-windows & --disable-renderer-backgrounding:
    //   prevent frame drops or throttling when games (e.g. Valorant) or other windows are focused
    let current_args = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
    let fluid_args = "--disable-frame-rate-limit --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding";
    let combined = if current_args.is_empty() {
        fluid_args.to_string()
    } else {
        format!("{current_args} {fluid_args}")
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", combined);

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

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                if let Some(info) = updater::check_for_updates(env!("CARGO_PKG_VERSION")).await {
                    let updates_dir = app_handle
                        .path()
                        .app_local_data_dir()
                        .map(|d| d.join("updates"))
                        .unwrap_or_else(|_| std::path::PathBuf::from("updates"));
                    let _ = tauri::Emitter::emit(&app_handle, "update-status", serde_json::json!({
                        "available": true,
                        "version": info.version,
                        "ready": false,
                        "downloading": true
                    }));
                    if updater::download_and_verify(&info, &updates_dir).await.is_some() {
                        let _ = tauri::Emitter::emit(&app_handle, "update-status", serde_json::json!({
                            "available": true,
                            "version": info.version,
                            "ready": true,
                            "downloading": false
                        }));
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .run(tauri::generate_context!())
        .expect("could not initialize Triscord Rust Preview");
}
