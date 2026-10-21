use crate::error::{api_error, Error, Result};
use futures_util::StreamExt;
use reqwest::{Client, Method};
use serde_json::Value;
use std::time::Duration;

pub const AUTH: &str = "https://triscord-auth.triscord-cloudflare-control.workers.dev";
pub const HUB: &str = "https://triscord-control.triscord-cloudflare-control.workers.dev";
pub struct Api {
    client: Client,
}
impl Api {
    pub async fn upload(
        &self,
        path: &str,
        token: &str,
        mime: &str,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let response = self
            .client
            .put(format!("{AUTH}{path}"))
            .bearer_auth(token)
            .header("content-type", mime)
            .body(bytes)
            .send()
            .await
            .map_err(|_| Error::network())?;
        let status = response.status();
        let value: Value = response.json().await.map_err(|_| Error::network())?;
        if !status.is_success() {
            return Err(api_error(status.as_u16(), value["error"].as_str()));
        }
        Ok(value)
    }
    pub async fn asset(&self, url: &str, limit: usize) -> Result<Vec<u8>> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| Error::network())?;
        if !response.status().is_success() {
            return Err(Error::network());
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::network())?;
            if bytes.len() + chunk.len() > limit {
                return Err(Error::invalid());
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .timeout(Duration::from_secs(12))
            .connect_timeout(Duration::from_secs(8))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("Triscord-Rust-Preview/0.1")
            .build()
            .map_err(|_| Error::network())?;
        Ok(Self { client })
    }
    pub async fn request(
        &self,
        method: Method,
        base: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self.client.request(method, format!("{base}{path}"));
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await.map_err(|_| Error::network())?;
        let status = response.status();
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|_| Error::network())?;
            if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err(Error::network());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| api_error(status.as_u16(), None))?;
        if !status.is_success() {
            return Err(api_error(status.as_u16(), value["error"].as_str()));
        }
        Ok(value)
    }
}

pub fn id(value: &str) -> Result<&str> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(Error::invalid());
    }
    Ok(value)
}
pub fn invite(value: &str) -> Result<String> {
    if value.len() > 2048 {
        return Err(Error::invalid());
    }
    let candidates: Vec<_> = value
        .split(|c: char| !c.is_ascii_hexdigit())
        .filter(|part| part.len() == 32)
        .collect();
    if candidates.len() != 1 {
        return Err(Error::invalid());
    }
    Ok(candidates[0].to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_reject_injection_and_oversized_ids() {
        for value in ["", "../me", "a?session=secret", "a/b", "ç"] {
            assert!(id(value).is_err());
        }
        assert!(id(&"a".repeat(65)).is_err());
        assert!(id("a-b_C123").is_ok());
    }
    #[test]
    fn invite_requires_one_bounded_code() {
        let code = "0123456789abcdef0123456789abcdef";
        assert_eq!(
            invite(&format!("https://triscord.pages.dev/invite/{code}")).unwrap(),
            code
        );
        assert!(invite(&format!("a{code}")).is_err());
        assert!(invite(&format!("{code}/{code}")).is_err());
    }
}
