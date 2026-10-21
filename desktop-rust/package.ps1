param([switch]$SkipBuild, [switch]$SkipRuntimeVerification)
$ErrorActionPreference = 'Stop'
if (-not $SkipRuntimeVerification) {
    throw 'This packager does not run the application. Pass -SkipRuntimeVerification to record runtimeVerified=false.'
}
$repo = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $repo 'desktop-rust/src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid application version.' }
$rootVersion = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
$cargo = Get-Content -LiteralPath (Join-Path $repo 'desktop-rust/src-tauri/Cargo.toml') -Raw
if ($rootVersion -ne $version -or $cargo -notmatch ('(?m)^version = "' + [regex]::Escape($version) + '"\r?$')) {
    throw 'Root, Tauri and Cargo versions must match.'
}
if (-not $SkipBuild) {
    & (Join-Path $PSScriptRoot 'build.ps1') -Release
}
$target = if ($env:TRISCORD_RUST_TARGET_DIR) { $env:TRISCORD_RUST_TARGET_DIR } else { Join-Path $repo 'desktop/out/tauri-target' }
$executable = Join-Path $target 'x86_64-pc-windows-msvc/release/triscord-desktop.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Build the release executable before packaging.' }
$executableVersion = (Get-Item -LiteralPath $executable).VersionInfo.ProductVersion
if ($executableVersion -ne $version) { throw "Executable version $executableVersion does not match $version." }
$tools = if ($env:TRISCORD_TOOLCHAIN_DIR) { $env:TRISCORD_TOOLCHAIN_DIR } else { Join-Path $repo '.toolchain' }
$nsis = Join-Path $tools 'nsis-3.11/makensis.exe'
if (-not (Test-Path -LiteralPath $nsis -PathType Leaf)) {
    $nsis = Join-Path $env:USERPROFILE '.codex/worktrees/native-desktop/triscord/.toolchain/nsis-3.11/makensis.exe'
}
if (-not (Test-Path -LiteralPath $nsis -PathType Leaf)) { throw 'NSIS toolchain not found.' }
$out = Join-Path $repo 'desktop/out'
$stage = Join-Path $out "rust-package-$version"
if (Test-Path -LiteralPath $stage) { throw "Package staging already exists: $stage" }
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item -LiteralPath $executable -Destination (Join-Path $stage 'triscord-desktop.exe')
# Older installed shortcuts use this executable name.
Copy-Item -LiteralPath $executable -Destination (Join-Path $stage 'triscord-web.exe')
$installer = Join-Path $out "Triscord-Setup-$version.exe"
if (Test-Path -LiteralPath $installer) { throw "Installer already exists: $installer" }
$nsisArgs = @('/INPUTCHARSET', 'UTF8', "/DAPP_VERSION=$version", "/DAPP_ICON=$(Join-Path $repo 'desktop/assets/triscord-app.ico')",
    "/DOUTPUT_EXE=$installer", "/DPACKAGE_DIR=$stage", '/DAPP_EXE=triscord-desktop.exe', (Join-Path $repo 'desktop/packaging/installer.nsi'))
& $nsis @nsisArgs
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
$executableHash = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
$encoding = New-Object Text.UTF8Encoding $false
[IO.File]::WriteAllText("$installer.sha256", "$hash  $([IO.Path]::GetFileName($installer))`n", $encoding)
$metadata = [ordered]@{
    version = $version
    staging = $stage
    executable = Join-Path $stage 'triscord-desktop.exe'
    entryPoint = 'triscord-desktop.exe'
    interface = 'tauri'
    runtimeVerified = $false
    executableSha256 = $executableHash
    installer = $installer
    installerBytes = (Get-Item -LiteralPath $installer).Length
    installerSha256 = $hash
}
[IO.File]::WriteAllText((Join-Path $out 'portable-web-package.json'), ($metadata | ConvertTo-Json), $encoding)
$metadata | ConvertTo-Json
