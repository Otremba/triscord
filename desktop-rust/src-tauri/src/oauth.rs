use crate::error::{Error, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};
use zeroize::Zeroizing;
include!(concat!(env!("OUT_DIR"), "/google_client.rs"));
const CLIENT_ID: &str = "250225176755-tdsas1pgo4b4ikbspqunik5v88i81rpi.apps.googleusercontent.com";
pub fn configured() -> bool {
    !CLIENT_SECRET.is_empty()
}
fn random() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub async fn sign_in() -> Result<Zeroizing<String>> {
    if !configured() {
        return Err(Error::unsupported());
    }
    timeout(Duration::from_secs(180), flow())
        .await
        .map_err(|_| Error {
            code: "oauth_timeout",
            message: "O login expirou. Tente novamente.",
        })?
}
async fn flow() -> Result<Zeroizing<String>> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| Error::network())?;
    let port = listener.local_addr().map_err(|_| Error::network())?.port();
    let redirect = format!("http://127.0.0.1:{port}/");
    let verifier = Zeroizing::new(random());
    let state = Zeroizing::new(random());
    let mut url =
        reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").expect("constant URL");
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("redirect_uri", &redirect)
        .append_pair("response_type", "code")
        .append_pair("scope", "openid email profile")
        .append_pair("code_challenge", &challenge(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state);
    open::that(url.as_str()).map_err(|_| Error::network())?;
    let code = loop {
        let (mut socket, peer) = listener.accept().await.map_err(|_| Error::network())?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let request = timeout(Duration::from_secs(3), async {
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            while request.len() < 8192 {
                let size = socket
                    .read(&mut buffer)
                    .await
                    .map_err(|_| Error::network())?;
                if size == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..size]);
                if request.windows(4).any(|v| v == b"\r\n\r\n") {
                    break;
                }
            }
            Ok::<_, Error>(request)
        })
        .await;
        let code = match request {
            Ok(Ok(request)) => callback(&request, &state, port),
            _ => Err(Error::invalid()),
        };
        let (status, message) = if code.is_ok() {
            (
                "200 OK",
                "Autorização recebida. Volte ao Triscord para concluir o login.",
            )
        } else {
            (
                "400 Bad Request",
                "Solicitação inválida. Continue o login na página original.",
            )
        };
        let response=format!("HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{message}",message.len());
        let _ = timeout(
            Duration::from_secs(2),
            socket.write_all(response.as_bytes()),
        )
        .await;
        if code
            .as_ref()
            .is_err_and(|error| error.code == "oauth_denied")
        {
            return Err(Error {
                code: "oauth_denied",
                message: "O login Google foi cancelado.",
            });
        }
        if let Ok(code) = code {
            break Zeroizing::new(code);
        }
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| Error::network())?;
    let response = client
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("code", code.as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await
        .map_err(|_| Error::network())?;
    if !response.status().is_success() {
        return Err(Error {
            code: "oauth_exchange",
            message: "Não foi possível validar o login Google.",
        });
    }
    let response: serde_json::Value = response.json().await.map_err(|_| Error::network())?;
    let token = response["id_token"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 16384)
        .ok_or_else(Error::network)?;
    Ok(Zeroizing::new(token.to_owned()))
}
fn callback(request: &[u8], state: &str, port: u16) -> Result<String> {
    if request.len() > 8192 {
        return Err(Error::invalid());
    }
    let request = std::str::from_utf8(request).map_err(|_| Error::invalid())?;
    if !request.contains("\r\n\r\n") {
        return Err(Error::invalid());
    }
    let mut lines = request.split("\r\n");
    let first = lines.next().ok_or_else(Error::invalid)?;
    let parts: Vec<_> = first.split(' ').collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || !["HTTP/1.1", "HTTP/1.0"].contains(&parts[2])
        || !parts[1].starts_with("/?")
    {
        return Err(Error::invalid());
    }
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .map(|(_, host)| host.trim())
        .collect();
    if hosts != [format!("127.0.0.1:{port}")] {
        return Err(Error::invalid());
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}", path = parts[1]))
        .map_err(|_| Error::invalid())?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    if states.len() == 1
        && states[0].1.as_bytes() == state.as_bytes()
        && pairs.iter().any(|(key, _)| key == "error")
    {
        return Err(Error {
            code: "oauth_denied",
            message: "O login Google foi cancelado.",
        });
    }
    if states.len() != 1
        || states[0].1.as_bytes() != state.as_bytes()
        || codes.len() != 1
        || codes[0].1.is_empty()
        || codes[0].1.len() > 4096
        || pairs.iter().any(|(key, _)| key == "error")
    {
        return Err(Error::invalid());
    }
    Ok(codes[0].1.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pkce_matches_rfc7636_vector() {
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }
    #[test]
    fn user_denial_is_terminal_only_with_a_valid_state() {
        let denied =
            b"GET /?error=access_denied&state=nonce HTTP/1.1\r\nHost: 127.0.0.1:123\r\n\r\n";
        assert_eq!(
            callback(denied, "nonce", 123).unwrap_err().code,
            "oauth_denied"
        );
        assert_eq!(callback(denied, "other", 123).unwrap_err().code, "invalid");
    }
    #[test]
    fn callback_checks_state_host_and_duplicate_parameters() {
        let request =
            |query: &str, host: &str| format!("GET /?{query} HTTP/1.1\r\nHost: {host}\r\n\r\n");
        assert_eq!(
            callback(
                request("code=ok&state=nonce", "127.0.0.1:123").as_bytes(),
                "nonce",
                123
            )
            .unwrap(),
            "ok"
        );
        for (query, host) in [
            ("code=ok&state=wrong", "127.0.0.1:123"),
            ("code=ok&state=nonce&state=nonce", "127.0.0.1:123"),
            ("code=a&code=b&state=nonce", "127.0.0.1:123"),
            ("code=ok&state=nonce", "evil.test:123"),
        ] {
            assert!(callback(request(query, host).as_bytes(), "nonce", 123).is_err());
        }
    }
}
