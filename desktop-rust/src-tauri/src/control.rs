use crate::error::{Error, Result};
use serde_json::Value;
use std::time::Duration;

pub enum Packet {
    Open { heartbeat: Duration },
    Ready,
    Pong(String),
    Event(String, Value),
    Closed,
    Ignore,
}
pub fn parse(text: &str) -> Result<Packet> {
    if text.len() > 2 * 1024 * 1024 {
        return Err(Error::invalid());
    }
    if let Some(value) = text.strip_prefix('0') {
        let value: Value = serde_json::from_str(value).map_err(|_| Error::invalid())?;
        if value["sid"].as_str().is_none_or(|s| s.is_empty()) {
            return Err(Error::invalid());
        }
        let interval = value["pingInterval"]
            .as_u64()
            .unwrap_or(25000)
            .clamp(500, 60000);
        let timeout = value["pingTimeout"]
            .as_u64()
            .unwrap_or(20000)
            .clamp(500, 60000);
        return Ok(Packet::Open {
            heartbeat: Duration::from_millis(interval + timeout),
        });
    }
    if let Some(suffix) = text.strip_prefix('2') {
        return Ok(Packet::Pong(format!("3{suffix}")));
    }
    if let Some(value) = text.strip_prefix("40") {
        let value: Value = serde_json::from_str(value).map_err(|_| Error::invalid())?;
        if value["sid"].as_str().is_none_or(|s| s.is_empty()) {
            return Err(Error::invalid());
        }
        return Ok(Packet::Ready);
    }
    if let Some(value) = text.strip_prefix("42") {
        let args: Value = serde_json::from_str(value).map_err(|_| Error::invalid())?;
        let args = args
            .as_array()
            .filter(|a| a.len() == 2)
            .ok_or_else(Error::invalid)?;
        let name = args[0].as_str().ok_or_else(Error::invalid)?;
        return Ok(Packet::Event(name.to_owned(), args[1].clone()));
    }
    if text == "1" || text == "41" || text.starts_with("44") {
        return Ok(Packet::Closed);
    }
    Ok(Packet::Ignore)
}
pub fn retry_delay(attempt: u32) -> Duration {
    Duration::from_millis((500u64 << attempt.min(5)).min(15000))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn heartbeat_preserves_payload_and_clamps_server_values() {
        assert!(matches!(parse("2probe").unwrap(), Packet::Pong(p) if p=="3probe"));
        assert!(
            matches!(parse(r#"0{"sid":"x","pingInterval":1,"pingTimeout":999999}"#).unwrap(), Packet::Open {heartbeat} if heartbeat.as_millis()==60500)
        );
    }
    #[test]
    fn malformed_packets_do_not_become_commands() {
        for text in [
            "0{}",
            "40null",
            "42{}",
            "42[]",
            r#"42["room-joined",{},{}]"#,
        ] {
            assert!(parse(text).is_err());
        }
        assert!(
            matches!(parse(r#"42["rooms-update",[]]"#).unwrap(), Packet::Event(name,_) if name=="rooms-update")
        );
    }
    #[test]
    fn backoff_is_bounded() {
        assert_eq!(retry_delay(0).as_millis(), 500);
        assert_eq!(retry_delay(u32::MAX).as_secs(), 15);
    }
}
