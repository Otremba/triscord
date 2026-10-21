param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$toolchain = Join-Path $repo '.toolchain'
if (-not (Test-Path -LiteralPath (Join-Path $toolchain 'rust/cargo/bin/cargo.exe'))) {
    $toolchain = Join-Path $env:USERPROFILE '.codex/worktrees/native-desktop/triscord/.toolchain'
}
$cargo = Join-Path $toolchain 'rust/cargo/bin/cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'Rust toolchain not found' }
$previous = @{}
foreach ($key in @('CARGO_HOME','RUSTUP_HOME','CARGO_TARGET_DIR','PATH')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
Push-Location $repo
try {
    $env:CARGO_HOME = Join-Path $toolchain 'rust/cargo'
    $env:RUSTUP_HOME = Join-Path $toolchain 'rust/rustup'
    $env:CARGO_TARGET_DIR = Join-Path $repo 'desktop/out/tauri-target'
    $env:PATH = "$(Join-Path $toolchain 'rust/cargo/bin');$(Join-Path $toolchain 'Qt/Tools/mingw1310_64/bin');$env:PATH"
    & node desktop/web/node_modules/typescript/bin/tsc --noEmit --project desktop/web/tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed' }
    & node desktop/web/tools/test-tauri-bridge.mjs
    if ($LASTEXITCODE -ne 0) { throw 'IPC tests failed' }
    & node desktop/web/tools/build.mjs --tauri
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    & $cargo test --locked --manifest-path desktop-rust/src-tauri/Cargo.toml -j 2
    if ($LASTEXITCODE -ne 0) { throw 'Rust unit tests failed' }
    if (-not $CheckOnly) {
        & $cargo build --locked --manifest-path desktop-rust/src-tauri/Cargo.toml -j 2
        if ($LASTEXITCODE -ne 0) { throw 'Rust executable build failed' }
    }
    Write-Output 'runtimeVerified=false; no app, installer or E2E was executed'
}
finally {
    Pop-Location
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
