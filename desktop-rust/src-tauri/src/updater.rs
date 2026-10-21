use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateInfo {
    pub version: String,
    pub installer_url: String,
    pub checksum_url: String,
}

/// Compares two semver strings in the format "X.Y.Z". Returns true if candidate is newer than current.
#[allow(dead_code)]
pub fn version_newer(candidate: &str, current: &str) -> bool {
    let parse_parts = |s: &str| -> Option<(u32, u32, u32)> {
        let clean = s.trim_start_matches("desktop-v").trim_start_matches('v');
        let mut parts = clean.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((major, minor, patch))
    };

    match (parse_parts(candidate), parse_parts(current)) {
        (Some(c), Some(cur)) => c > cur,
        _ => false,
    }
}

/// Parses GitHub releases JSON array to find the newest valid desktop release and its assets.
#[allow(dead_code)]
pub fn parse_latest_release(releases: &[Value], current_version: &str) -> Option<UpdateInfo> {
    for value in releases {
        if value["draft"].as_bool().unwrap_or(false)
            || value["prerelease"].as_bool().unwrap_or(false)
        {
            continue;
        }

        let tag = value["tag_name"].as_str().unwrap_or_default();
        if !tag.starts_with("desktop-v") {
            continue;
        }
        let version = tag.trim_start_matches("desktop-v");
        if !version_newer(version, current_version) {
            break; // Releases are ordered newest first; if this isn't newer, none after it will be.
        }

        let mut installer_url = None;
        let mut checksum_url = None;
        let expected_installer_name = format!("Triscord-Setup-{version}.exe");
        let expected_checksum_name = format!("Triscord-Setup-{version}.exe.sha256");

        if let Some(assets) = value["assets"].as_array() {
            for asset in assets {
                let name = asset["name"].as_str().unwrap_or_default();
                let url = asset["browser_download_url"].as_str().unwrap_or_default();
                if name == expected_installer_name && !url.is_empty() {
                    installer_url = Some(url.to_owned());
                } else if name == expected_checksum_name && !url.is_empty() {
                    checksum_url = Some(url.to_owned());
                }
            }
        }

        if let (Some(inst), Some(chk)) = (installer_url, checksum_url) {
            return Some(UpdateInfo {
                version: version.to_owned(),
                installer_url: inst,
                checksum_url: chk,
            });
        }
    }
    None
}

/// Verifies that data matches the expected SHA-256 hex digest (case-insensitive, trims whitespace).
#[allow(dead_code)]
pub fn verify_sha256(data: &[u8], expected_hex: &str) -> bool {
    let mut hasher = Sha256::new();
    hasher.update(data);
    let digest = hasher.finalize();
    let computed_hex = format!("{:x}", digest);
    let clean_expected = expected_hex
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    !clean_expected.is_empty() && computed_hex == clean_expected
}

/// Asynchronously queries GitHub Releases for updates newer than current_version.
#[allow(dead_code)]
pub async fn check_for_updates(current_version: &str) -> Option<UpdateInfo> {
    let client = reqwest::Client::builder()
        .user_agent("Triscord-Desktop")
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let res = client
        .get("https://api.github.com/repos/Otremba/triscord/releases?per_page=10")
        .send()
        .await
        .ok()?;
    let releases: serde_json::Value = res.json().await.ok()?;
    parse_latest_release(releases.as_array()?, current_version)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semver_comparison_works() {
        assert!(version_newer("0.9.46", "0.9.45"));
        assert!(version_newer("0.10.0", "0.9.45"));
        assert!(version_newer("1.0.0", "0.9.45"));
        assert!(!version_newer("0.9.45", "0.9.45"));
        assert!(!version_newer("0.9.44", "0.9.45"));
        assert!(!version_newer("bad-version", "0.9.45"));
    }

    #[test]
    fn parse_latest_release_extracts_assets() {
        let releases = json!([
            {
                "tag_name": "desktop-v0.9.46",
                "draft": false,
                "prerelease": false,
                "assets": [
                    {
                        "name": "Triscord-Setup-0.9.46.exe",
                        "browser_download_url": "https://example.com/setup.exe"
                    },
                    {
                        "name": "Triscord-Setup-0.9.46.exe.sha256",
                        "browser_download_url": "https://example.com/setup.exe.sha256"
                    }
                ]
            }
        ]);

        let info = parse_latest_release(releases.as_array().unwrap(), "0.9.45");
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.version, "0.9.46");
        assert_eq!(info.installer_url, "https://example.com/setup.exe");
        assert_eq!(info.checksum_url, "https://example.com/setup.exe.sha256");
    }

    #[test]
    fn draft_and_prerelease_ignored() {
        let releases = json!([
            {
                "tag_name": "desktop-v0.9.46",
                "draft": true,
                "assets": [
                    {
                        "name": "Triscord-Setup-0.9.46.exe",
                        "browser_download_url": "https://example.com/setup.exe"
                    },
                    {
                        "name": "Triscord-Setup-0.9.46.exe.sha256",
                        "browser_download_url": "https://example.com/setup.exe.sha256"
                    }
                ]
            }
        ]);

        assert!(parse_latest_release(releases.as_array().unwrap(), "0.9.45").is_none());
    }

    #[test]
    fn sha256_verifies_correctly() {
        let data = b"triscord payload test bytes";
        let mut hasher = Sha256::new();
        hasher.update(data);
        let hex = format!("{:x}", hasher.finalize());

        assert!(verify_sha256(data, &hex));
        assert!(verify_sha256(data, &format!("{}  setup.exe", hex)));
        assert!(!verify_sha256(b"corrupted data", &hex));
    }
}
