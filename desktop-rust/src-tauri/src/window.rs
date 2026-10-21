//! The frameless main window. The interface draws its own title bar and 4px edges (like Discord's) and asks the core
//! for the system's behaviour: minimize, maximize/restore, close, drag by the bar and drag-resize from an edge.
use crate::error::{Error, Result};
use serde_json::Value;
use tauri::Manager;
use windows::Win32::{
    Foundation::{HWND, LPARAM, POINT, WPARAM},
    UI::{
        Input::KeyboardAndMouse::ReleaseCapture,
        WindowsAndMessaging::{
            GetCursorPos, PostMessageW, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP, HTTOPLEFT, HTTOPRIGHT,
            WM_NCLBUTTONDOWN,
        },
    },
};

/// The non-client hit-test code of a window edge or corner ("n", "se", ...).
pub fn hit_test(edge: &str) -> Option<u32> {
    Some(match edge {
        "n" => HTTOP,
        "s" => HTBOTTOM,
        "e" => HTRIGHT,
        "w" => HTLEFT,
        "ne" => HTTOPRIGHT,
        "nw" => HTTOPLEFT,
        "se" => HTBOTTOMRIGHT,
        "sw" => HTBOTTOMLEFT,
        _ => return None,
    })
}
/// Starts the system's resize loop for an edge at the cursor, as Windows does for a click on the sizing border.
fn start_resize(hwnd: usize, edge: &str) -> Result<()> {
    let hit = hit_test(edge).ok_or_else(Error::invalid)?;
    unsafe {
        let mut point = POINT::default();
        GetCursorPos(&mut point).map_err(|_| Error::invalid())?;
        let _ = ReleaseCapture();
        let position = ((point.y as u32) << 16 | (point.x as u32 & 0xFFFF)) as isize;
        PostMessageW(Some(HWND(hwnd as *mut _)), WM_NCLBUTTONDOWN, WPARAM(hit as usize), LPARAM(position))
            .map_err(|_| Error::invalid())
    }
}
pub fn action(app: &tauri::AppHandle, action: &str) -> Result<Value> {
    let window = app.get_webview_window("main").ok_or_else(Error::invalid)?;
    let done = match action {
        "minimize" => window.minimize(),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        "move" => window.start_dragging(),
        other => {
            let edge = other.strip_prefix("resize-").ok_or_else(Error::invalid)?;
            let hwnd = window.hwnd().map_err(|_| Error::invalid())?.0 as usize;
            return start_resize(hwnd, edge).map(|_| Value::Null);
        }
    };
    done.map_err(|_| Error::invalid())?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_edge_the_page_draws_has_a_system_hit_code() {
        for edge in ["n", "s", "e", "w", "ne", "nw", "se", "sw"] {
            assert!(hit_test(edge).is_some(), "{edge}");
        }
        assert_eq!(hit_test("n"), Some(HTTOP));
        assert_eq!(hit_test("se"), Some(HTBOTTOMRIGHT));
        assert!(hit_test("up").is_none() && hit_test("").is_none());
    }
}
