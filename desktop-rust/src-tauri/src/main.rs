#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod api;
mod control;
mod core;
mod error;
mod model;
mod socket;
mod vault;

use tauri::Manager;
use tokio::sync::Mutex;

#[tauri::command]
async fn dispatch(
    app: tauri::AppHandle,
    state: tauri::State<'_, Mutex<core::Core>>,
    command: serde_json::Value,
) -> error::Result<serde_json::Value> {
    if command.to_string().len() > 16384 {
        return Err(error::Error::invalid());
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
            let core = core::Core::new(directory).map_err(|e| std::io::Error::other(e.message))?;
            app.manage(Mutex::new(core));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![dispatch])
        .run(tauri::generate_context!())
        .expect("could not initialize Triscord Rust Preview");
}
