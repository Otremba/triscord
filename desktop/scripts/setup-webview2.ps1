# Microsoft WebView2 SDK only; this does not install or launch a browser runtime.
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskSdk = Join-Path $taskTools 'webview2'
$taskVersion = '1.0.4258.31'
if (Test-Path -LiteralPath (Join-Path $taskSdk 'build/native/include/WebView2.h')) {
    Write-Output 'WebView2 SDK already prepared.'
    return
}
$taskDownloads = Join-Path $taskTools 'downloads'
New-Item -ItemType Directory -Path $taskDownloads -Force | Out-Null
$taskArchive = Join-Path $taskDownloads "webview2-$taskVersion.zip"
$taskUrl = "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/$taskVersion/microsoft.web.webview2.$taskVersion.nupkg"
Invoke-WebRequest -Uri $taskUrl -OutFile $taskArchive -UseBasicParsing
# SHA-512 from NuGet's immutable catalog entry, checked against the existing SDK archive:
# https://api.nuget.org/v3/catalog0/data/2026.09.28.08.32.55/microsoft.web.webview2.1.0.4258.31.json
$taskExpected = 'HlGVwvyP/IWiXAU8K57Vmg59khY3DWMOxMnH4AHusFRy0/vDAjKItXUIVNXiXXaq4CLfSZyNUic1wOIlnPLsPQ=='
$taskHash = [Security.Cryptography.SHA512]::Create()
try { $taskActual = [Convert]::ToBase64String($taskHash.ComputeHash([IO.File]::ReadAllBytes($taskArchive))) }
finally { $taskHash.Dispose() }
if ($taskActual -ne $taskExpected) { throw 'WebView2 SDK checksum mismatch' }
Expand-Archive -LiteralPath $taskArchive -DestinationPath $taskSdk -Force
if (-not (Test-Path -LiteralPath (Join-Path $taskSdk 'build/native/include/WebView2.h')) -or
    -not (Test-Path -LiteralPath (Join-Path $taskSdk 'build/native/x64/WebView2Loader.dll'))) { throw 'Incomplete WebView2 SDK' }
Set-Content -LiteralPath (Join-Path $taskSdk 'VERSION') -Value $taskVersion -Encoding ascii
Write-Output "WebView2 SDK $taskVersion prepared."
