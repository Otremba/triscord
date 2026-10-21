fn main() {
    println!("cargo:rerun-if-env-changed=TRISCORD_GOOGLE_CLIENT_SECRET_FILE");
    let secret = std::env::var_os("TRISCORD_GOOGLE_CLIENT_SECRET_FILE")
        .map(std::path::PathBuf::from)
        .map(|path| {
            println!("cargo:rerun-if-changed={}", path.display());
            std::fs::read_to_string(path).expect("Google OAuth configuration could not be read")
        })
        .unwrap_or_default();
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"));
    std::fs::write(
        output.join("google_client.rs"),
        format!("pub const CLIENT_SECRET: &str = {:?};", secret.trim()),
    )
    .expect("could not generate OAuth configuration");
    tauri_build::build()
}
