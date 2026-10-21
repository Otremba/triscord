#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
mod capture;
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
    // Geometry must not contend with a slow login or REST request holding the core lock.
    let presenter = app.state::<presenter::Presenter>();
    if command["name"] == "videoSurface" {
        let id = command["streamId"]
            .as_str()
            .filter(|id| id.len() <= 64)
            .ok_or_else(error::Error::invalid)?;
        let rect =
            serde_json::from_value(command["rect"].clone()).map_err(|_| error::Error::invalid())?;
        presenter.layout(
            id,
            rect,
            command["scale"]
                .as_f64()
                .ok_or_else(error::Error::invalid)?,
        )?;
        return Ok(serde_json::Value::Null);
    }
    if command["name"] == "videoOccluders" {
        presenter.occluders(
            serde_json::from_value(command["rects"].clone())
                .map_err(|_| error::Error::invalid())?,
        )?;
        return Ok(serde_json::Value::Null);
    }
    if command["name"] == "videoRole" {
        return Ok(serde_json::Value::Null);
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
