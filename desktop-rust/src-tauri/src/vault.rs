use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
pub struct Credential {
    pub session: String,
    pub expires_at: u64,
}
impl Drop for Credential {
    fn drop(&mut self) {
        self.session.zeroize();
    }
}

pub struct Vault {
    path: PathBuf,
}
impl Vault {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            path: directory.join("session.dpapi"),
        }
    }
    pub fn load(&self) -> Result<Option<Credential>> {
        let file = match std::fs::File::open(&self.path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Error::storage()),
        };
        let mut bytes = Vec::new();
        file.take(16385)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::storage())?;
        if bytes.len() > 16384 {
            return Err(Error::storage());
        }
        let clear = Zeroizing::new(unprotect(&bytes)?);
        serde_json::from_slice(&clear)
            .map(Some)
            .map_err(|_| Error::storage())
    }
    pub fn save(&self, credential: &Credential) -> Result<()> {
        let clear = Zeroizing::new(serde_json::to_vec(credential).map_err(|_| Error::storage())?);
        let encrypted = protect(&clear)?;
        atomic_write(&self.path, &encrypted)
    }
    pub fn clear(&self) -> Result<()> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(Error::storage()),
        }
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(Error::storage)?;
    std::fs::create_dir_all(parent).map_err(|_| Error::storage())?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::storage())?;
    temp.write_all(bytes).map_err(|_| Error::storage())?;
    temp.as_file().sync_all().map_err(|_| Error::storage())?;
    temp.persist(path).map_err(|_| Error::storage())?;
    Ok(())
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::ffi::c_void;
    #[repr(C)]
    struct Blob {
        len: u32,
        data: *mut u8,
    }
    #[link(name = "crypt32")]
    unsafe extern "system" {
        fn CryptProtectData(
            input: *const Blob,
            description: *const u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
        fn CryptUnprotectData(
            input: *const Blob,
            description: *mut *mut u16,
            entropy: *const Blob,
            reserved: *mut c_void,
            prompt: *mut c_void,
            flags: u32,
            output: *mut Blob,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
    }

    pub fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
        let len = u32::try_from(bytes.len()).map_err(|_| Error::storage())?;
        let input = Blob {
            len,
            data: bytes.as_ptr() as *mut u8,
        };
        let mut output = Blob {
            len: 0,
            data: std::ptr::null_mut(),
        };
        // UI_FORBIDDEN ensures background persistence never displays a Windows prompt.
        let result = unsafe {
            if encrypt {
                CryptProtectData(
                    &input,
                    std::ptr::null(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            } else {
                CryptUnprotectData(
                    &input,
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    1,
                    &mut output,
                )
            }
        };
        if result == 0 || output.data.is_null() {
            return Err(Error::storage());
        }
        // DPAPI owns this allocation. Copy, erase plaintext, then free with its allocator.
        let value =
            unsafe { std::slice::from_raw_parts(output.data, output.len as usize).to_vec() };
        unsafe {
            if !encrypt {
                std::slice::from_raw_parts_mut(output.data, output.len as usize).zeroize();
            }
            LocalFree(output.data.cast());
        }
        Ok(value)
    }
}
#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
    windows::crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>> {
    windows::crypt(bytes, false)
}
#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>> {
    Err(Error::storage())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    Err(Error::storage())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn atomic_replace_preserves_only_latest_value() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("test");
        atomic_write(&file, b"first").unwrap();
        atomic_write(&file, b"second").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"second");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }
    #[test]
    #[cfg(windows)]
    fn isolated_vault_encrypts_and_rejects_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().to_path_buf());
        assert!(vault.load().unwrap().is_none());
        let credential = Credential {
            session: "synthetic-unit-test-token".into(),
            expires_at: 123,
        };
        vault.save(&credential).unwrap();
        assert!(
            !String::from_utf8_lossy(&std::fs::read(&vault.path).unwrap())
                .contains(&credential.session)
        );
        assert_eq!(vault.load().unwrap().unwrap().session, credential.session);
        atomic_write(&vault.path, b"corrupt").unwrap();
        assert!(vault.load().is_err());
        vault.clear().unwrap();
        assert!(vault.load().unwrap().is_none());
    }
    #[test]
    fn atomic_write_creates_nested_directories_if_missing() {
        let dir = tempfile::tempdir().unwrap();
        let nested_file = dir.path().join("a").join("b").join("c").join("data.bin");
        atomic_write(&nested_file, b"deep-payload").unwrap();
        assert_eq!(std::fs::read(&nested_file).unwrap(), b"deep-payload");
    }
    #[test]
    #[cfg(windows)]
    fn vault_load_on_empty_file_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path().to_path_buf());
        atomic_write(&vault.path, b"").unwrap();
        assert!(vault.load().is_err());
    }
    #[test]
    fn credential_struct_roundtrips_through_json() {
        let cred = Credential {
            session: "test-session-tok-999".into(),
            expires_at: 1893456000,
        };
        let encoded = serde_json::to_string(&cred).unwrap();
        let decoded: Credential = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded.session, cred.session);
        assert_eq!(decoded.expires_at, cred.expires_at);
    }
}
