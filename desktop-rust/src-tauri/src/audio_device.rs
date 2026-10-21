use windows::{
    core::Result,
    Win32::{Media::Audio::*, System::Com::*},
};

// Resolve the same communications endpoint WebRTC uses when no explicit device is selected.
pub fn resolve(requested: &str, input: bool) -> Result<String> {
    resolve_with(requested, || unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        let owns_apartment = initialized.is_ok();
        if initialized.is_err() && initialized != windows::Win32::Foundation::RPC_E_CHANGED_MODE {
            initialized.ok()?;
        }
        let result = (|| {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let endpoint = enumerator
                .GetDefaultAudioEndpoint(if input { eCapture } else { eRender }, eCommunications)?;
            let id = endpoint.GetId()?;
            let value = id.to_string().map_err(|_| {
                windows::core::Error::from_hresult(windows::Win32::Foundation::E_INVALIDARG)
            });
            CoTaskMemFree(Some(id.0.cast()));
            value
        })();
        if owns_apartment {
            CoUninitialize();
        }
        result
    })
}

fn resolve_with(requested: &str, default: impl FnOnce() -> Result<String>) -> Result<String> {
    if requested.is_empty() {
        default()
    } else {
        Ok(requested.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_selection_resolves_again_instead_of_retaining_the_previous_device() {
        assert_eq!(
            resolve_with("headset", || panic!("explicit device")).unwrap(),
            "headset"
        );
        assert_eq!(
            resolve_with("", || Ok("windows-default".into())).unwrap(),
            "windows-default"
        );
        assert_eq!(
            resolve_with("", || Ok("new-default".into())).unwrap(),
            "new-default"
        );
        assert!(resolve_with("", || Err(windows::core::Error::from_hresult(
            windows::Win32::Foundation::E_FAIL
        )))
        .is_err());
    }
}
