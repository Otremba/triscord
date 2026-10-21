param([switch]$CheckOnly, [switch]$Release)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$toolchain = if ($env:TRISCORD_TOOLCHAIN_DIR) { $env:TRISCORD_TOOLCHAIN_DIR } else { Join-Path $repo '.toolchain' }
if (-not (Test-Path -LiteralPath (Join-Path $toolchain 'rust/cargo/bin/cargo.exe'))) {
    $toolchain = Join-Path $env:USERPROFILE '.codex/worktrees/native-desktop/triscord/.toolchain'
}
$cargo = Join-Path $toolchain 'rust/cargo/bin/cargo.exe'
if (-not (Test-Path -LiteralPath $cargo)) { throw 'Rust toolchain not found' }
$previous = @{}
foreach ($key in @('CARGO_HOME','RUSTUP_HOME','CARGO_TARGET_DIR','PATH','INCLUDE','LIB','VCToolsInstallDir','WindowsSDKDir','WindowsSDKVersion','VSCMD_ARG_TGT_ARCH','CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS','LK_CUSTOM_WEBRTC','TRISCORD_GOOGLE_CLIENT_SECRET_FILE')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key,'Process') }
Push-Location $repo
try {
    $env:CARGO_HOME = Join-Path $toolchain 'rust/cargo'
    if (-not $env:TRISCORD_GOOGLE_CLIENT_SECRET_FILE) {
        $localGoogle = Join-Path $repo 'desktop/out/google-client-secret.txt'
        $toolchainItem = Get-Item -LiteralPath $toolchain
        $physicalTools = if ($toolchainItem.Target) { @($toolchainItem.Target)[0] } else { $toolchain }
        $sharedGoogle = Join-Path $physicalTools '../desktop/out/google-client-secret.txt'
        if (Test-Path -LiteralPath $localGoogle) { $env:TRISCORD_GOOGLE_CLIENT_SECRET_FILE = $localGoogle }
        elseif (Test-Path -LiteralPath $sharedGoogle) { $env:TRISCORD_GOOGLE_CLIENT_SECRET_FILE = [IO.Path]::GetFullPath($sharedGoogle) }
    }
    $env:RUSTUP_HOME = Join-Path $toolchain 'rust/rustup'
    # TRISCORD_RUST_TARGET_DIR / TRISCORD_WEBRTC_DIR let a second checkout (a long worktree path) reuse the first one's
    # build cache and short SDK folder instead of recompiling the LiveKit SDK from scratch.
    $env:CARGO_TARGET_DIR = if ($env:TRISCORD_RUST_TARGET_DIR) { $env:TRISCORD_RUST_TARGET_DIR } else { Join-Path $repo 'desktop/out/tauri-target' }
    # Short SDK location avoids MSVC include paths exceeding MAX_PATH. The directory must not be
    # pre-created on a clean checkout: webrtc-sys downloads its pinned artifact when it is absent.
    $env:LK_CUSTOM_WEBRTC = if ($env:TRISCORD_WEBRTC_DIR) { $env:TRISCORD_WEBRTC_DIR } else { Join-Path $repo 'desktop/out/webrtc-89d790b' }
    $msvc = Join-Path $toolchain 'msvc'
    $vc = Get-ChildItem (Join-Path $msvc 'VC/Tools/MSVC') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    $sdk = Get-ChildItem (Join-Path $msvc 'Windows Kits/10/Include') -Directory | Sort-Object Name -Descending | Select-Object -First 1
    if (-not $vc -or -not $sdk) { throw 'MSVC and Windows SDK are required by the official LiveKit SDK' }
    $env:VCToolsInstallDir = "$($vc.FullName)\"
    $env:WindowsSDKDir = "$(Join-Path $msvc 'Windows Kits/10')\"
    $env:WindowsSDKVersion = "$($sdk.Name)\"
    $env:VSCMD_ARG_TGT_ARCH = 'x64'
    $env:PATH = "$(Join-Path $toolchain 'rust/cargo/bin');$($vc.FullName)/bin/Hostx64/x64;$env:WindowsSDKDir/bin/$($sdk.Name)/x64;$(Join-Path $toolchain 'Qt/Tools/mingw1310_64/bin');$env:PATH"
    $env:INCLUDE = "$($vc.FullName)/include;$($sdk.FullName)/ucrt;$($sdk.FullName)/shared;$($sdk.FullName)/um;$($sdk.FullName)/winrt;$($sdk.FullName)/cppwinrt"
    $env:LIB = "$($vc.FullName)/lib/x64;$env:WindowsSDKDir/Lib/$($sdk.Name)/ucrt/x64;$env:WindowsSDKDir/Lib/$($sdk.Name)/um/x64"
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = '-C target-feature=+crt-static'
    & node desktop/web/node_modules/typescript/bin/tsc --noEmit --project desktop/web/tsconfig.json
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed' }
    & node desktop/web/tools/test-tauri-bridge.mjs
    if ($LASTEXITCODE -ne 0) { throw 'IPC tests failed' }
    & node desktop/web/tools/build.mjs --tauri
    if ($LASTEXITCODE -ne 0) { throw 'UI build failed' }
    & $cargo test --locked --target x86_64-pc-windows-msvc --manifest-path desktop-rust/src-tauri/Cargo.toml -j 2
    if ($LASTEXITCODE -ne 0) { throw 'Rust unit tests failed' }
    if (-not $CheckOnly) {
        $buildArgs = @('build', '--locked', '--target', 'x86_64-pc-windows-msvc', '--manifest-path', 'desktop-rust/src-tauri/Cargo.toml', '-j', '2')
        if ($Release) { $buildArgs += '--release' }
        & $cargo @buildArgs
        if ($LASTEXITCODE -ne 0) { throw 'Rust executable build failed' }
    }
    Write-Output 'runtimeVerified=false; no app, installer or E2E was executed'
}
finally {
    Pop-Location
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
