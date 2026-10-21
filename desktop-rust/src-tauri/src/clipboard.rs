//! Text to the Windows clipboard ("Copiar código do convite", "Copiar texto da mensagem").
use crate::error::{Error, Result};
use windows::Win32::{
    Foundation::{GlobalFree, HANDLE},
    System::{
        DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData},
        Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE},
        Ole::CF_UNICODETEXT,
    },
};

/// NUL-terminated UTF-16, the clipboard's CF_UNICODETEXT layout.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}
pub fn set_text(text: &str) -> Result<()> {
    // Messages are limited to 2000 characters and invites are 32: anything bigger is not ours to put on the clipboard.
    if text.len() > 16384 || text.contains('\0') {
        return Err(Error::invalid());
    }
    let wide = wide(text);
    unsafe {
        OpenClipboard(None).map_err(|_| Error::clipboard())?;
        let result = write(&wide);
        let _ = CloseClipboard();
        result
    }
}
unsafe fn write(wide: &[u16]) -> Result<()> {
    EmptyClipboard().map_err(|_| Error::clipboard())?;
    let memory = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2).map_err(|_| Error::clipboard())?;
    let pointer = GlobalLock(memory) as *mut u16;
    if pointer.is_null() {
        let _ = GlobalFree(Some(memory));
        return Err(Error::clipboard());
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), pointer, wide.len());
    let _ = GlobalUnlock(memory);
    // Once SetClipboardData succeeds the clipboard owns the memory; on failure it is still ours to free.
    if SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0))).is_err() {
        let _ = GlobalFree(Some(memory));
        return Err(Error::clipboard());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_is_utf16_with_a_terminator() {
        assert_eq!(wide("a😀"), vec![0x61, 0xD83D, 0xDE00, 0]);
        assert_eq!(wide(""), vec![0]);
    }
    #[test]
    fn what_cannot_be_a_clipboard_string_is_refused_before_touching_the_clipboard() {
        assert!(set_text("a\0b").is_err());
        assert!(set_text(&"x".repeat(16385)).is_err());
    }
}
