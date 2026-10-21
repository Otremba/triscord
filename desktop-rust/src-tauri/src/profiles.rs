use crate::{
    api::{Api, AUTH},
    error::{Error, Result},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
pub const FIELDS: [&str; 7] = [
    "display_name",
    "pronouns",
    "bio",
    "note",
    "banner_color",
    "profile_theme_start",
    "profile_theme_end",
];
pub fn validate_fields(value: &Value) -> Result<()> {
    let fields = value.as_object().ok_or_else(Error::invalid)?;
    if fields.iter().any(|(key, value)| {
        !FIELDS.contains(&key.as_str())
            || (!value.is_null() && !value.as_str().is_some_and(|text| text.len() <= 4096))
    }) {
        return Err(Error::invalid());
    }
    Ok(())
}
pub async fn project(api: &Api, raw: &Value) -> Value {
    let avatar = image(api, raw["avatar_url"].as_str(), 524288).await;
    let banner = image(api, raw["banner_url"].as_str(), 1048576).await;
    let mut value = json!({"avatarDataUrl":avatar,"bannerDataUrl":banner,"hasAvatar":!avatar.is_empty(),"hasBanner":!banner.is_empty(),"hasPassword":raw["has_password"].as_bool().unwrap_or(false),"google":raw["google"].as_bool().unwrap_or(false),"created_at":raw["created_at"]});
    for field in FIELDS {
        value[field] = raw[field].clone();
    }
    value
}
async fn image(api: &Api, url: Option<&str>, limit: usize) -> String {
    let Some(url) = url else {
        return String::new();
    };
    if !allowed_asset(url) {
        return String::new();
    }
    let Ok(bytes) = api.asset(url, limit).await else {
        return String::new();
    };
    let Ok(mime) = mime(&bytes) else {
        return String::new();
    };
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}
fn allowed_asset(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|p| p != 443)
        || url.fragment().is_some()
    {
        return false;
    }
    let auth = reqwest::Url::parse(AUTH).expect("constant URL");
    (url.host_str() == auth.host_str() && url.path().starts_with("/media/"))
        || [
            "lh3.googleusercontent.com",
            "lh4.googleusercontent.com",
            "lh5.googleusercontent.com",
            "lh6.googleusercontent.com",
        ]
        .contains(&url.host_str().unwrap_or_default())
}
fn mime(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Ok("image/gif")
    } else if bytes.starts_with(&[255, 216, 255]) {
        Ok("image/jpeg")
    } else {
        Err(Error::invalid())
    }
}
pub struct Upload {
    pub id: String,
    pub kind: String,
    account: String,
    size: usize,
    bytes: Vec<u8>,
    started: Instant,
}
impl Upload {
    pub fn new(kind: String, size: usize, account: String) -> Result<Self> {
        let limit = match kind.as_str() {
            "avatar" => 524288,
            "banner" => 1048576,
            _ => return Err(Error::invalid()),
        };
        if size == 0 || size > limit {
            return Err(Error::invalid());
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            account,
            size,
            bytes: Vec::new(),
            started: Instant::now(),
        })
    }
    fn check(&self, id: &str, account: &str) -> Result<()> {
        if self.id != id
            || self.account != account
            || self.started.elapsed() > Duration::from_secs(120)
        {
            return Err(Error::invalid());
        }
        Ok(())
    }
    pub fn append(&mut self, id: &str, account: &str, offset: usize, data: &str) -> Result<()> {
        self.check(id, account)?;
        if data.len() > 32768 || offset != self.bytes.len() {
            return Err(Error::invalid());
        }
        let bytes = STANDARD.decode(data).map_err(|_| Error::invalid())?;
        if bytes.is_empty() || bytes.len() > 24576 || offset + bytes.len() > self.size {
            return Err(Error::invalid());
        }
        self.bytes.extend_from_slice(&bytes);
        Ok(())
    }
    pub fn finish(self, id: &str, account: &str) -> Result<(&'static str, Vec<u8>)> {
        self.check(id, account)?;
        if self.bytes.len() != self.size {
            return Err(Error::invalid());
        }
        Ok((mime(&self.bytes)?, self.bytes))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uploads_are_bounded_ordered_and_bound_to_account() {
        assert!(Upload::new("avatar".into(), 524289, "a".into()).is_err());
        let mut upload = Upload::new("avatar".into(), 8, "a".into()).unwrap();
        let id = upload.id.clone();
        assert!(upload.append(&id, "b", 0, "R0lGODlh").is_err());
        assert!(upload.append(&id, "a", 1, "R0lGODlh").is_err());
        upload.append(&id, "a", 0, "R0lGODlh").unwrap();
        assert!(upload.finish(&id, "a").is_err());
    }
    #[test]
    fn completed_payload_is_preserved_and_expired_upload_is_rejected() {
        let bytes = b"GIF89a";
        let mut upload = Upload::new("avatar".into(), bytes.len(), "a".into()).unwrap();
        let id = upload.id.clone();
        upload.append(&id, "a", 0, &STANDARD.encode(bytes)).unwrap();
        let (mime, received) = upload.finish(&id, "a").unwrap();
        assert_eq!(mime, "image/gif");
        assert_eq!(received, bytes);
        let mut expired = Upload::new("avatar".into(), 6, "a".into()).unwrap();
        expired.started = Instant::now() - Duration::from_secs(121);
        let id = expired.id.clone();
        assert!(expired
            .append(&id, "a", 0, &STANDARD.encode(bytes))
            .is_err());
    }
    #[test]
    fn profile_cannot_set_auth_fields_or_fetch_arbitrary_urls() {
        assert!(validate_fields(&json!({"session":"secret"})).is_err());
        assert!(validate_fields(&json!({"display_name":"Nick","bio":null})).is_ok());
        for url in [
            "https://localhost/media/a",
            "http://lh3.googleusercontent.com/photo",
            "https://triscord-auth.triscord-cloudflare-control.workers.dev.evil/media/a",
        ] {
            assert!(!allowed_asset(url));
        }
    }
}
