param(
    [Parameter(Position = 0)]
    [ValidateRange(1, 10)]
    [int]$InstanceId = 1
)

$ErrorActionPreference = 'Stop'
$repo = 'C:/Users/camargo/Documents/GitHub/triscord'
$exe = "$env:LOCALAPPDATA\Triscord\app\triscord-desktop.exe"

if (-not (Test-Path -LiteralPath $exe)) {
    $exe = Join-Path $repo 'desktop/out/tauri-target/x86_64-pc-windows-msvc/release/triscord-desktop.exe'
}

if (-not (Test-Path -LiteralPath $exe)) {
    throw "Executável do Triscord não encontrado. Compile com: powershell desktop-rust/build.ps1 -Release"
}

$profileDir = Join-Path $env:LOCALAPPDATA "Triscord\profiles\instance-$InstanceId"
$webviewDir = Join-Path $env:LOCALAPPDATA "Triscord\webview-data\instance-$InstanceId"

if (-not (Test-Path -LiteralPath $profileDir)) {
    New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $webviewDir)) {
    New-Item -ItemType Directory -Path $webviewDir -Force | Out-Null
}

$env:TRISCORD_SETTINGS_PATH = $profileDir
$env:WEBVIEW2_USER_DATA_FOLDER = $webviewDir

Write-Output "Iniciando Instância $InstanceId do Triscord..."
Write-Output "Perfil: $profileDir"
Write-Output "WebView: $webviewDir"

Start-Process -FilePath $exe
Write-Output "Instância $InstanceId iniciada com sucesso em processo isolado!"
