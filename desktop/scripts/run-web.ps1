param()
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskExe = Join-Path $taskRepo 'desktop/out/build/triscord-web.exe'
$taskAssets = Join-Path $taskRepo 'desktop/web/dist'
if (-not (Test-Path -LiteralPath $taskExe) -or -not (Test-Path -LiteralPath (Join-Path $taskAssets 'index.html'))) {
    throw 'Build the web assets (desktop/web: npm run build) and the triscord-web CMake target first.'
}
$taskOldPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $taskRepo '.toolchain/Qt/6.8.3/mingw_64/bin');$(Join-Path $taskRepo '.toolchain/Qt/Tools/mingw1310_64/bin');$taskOldPath"
    & $taskExe --assets $taskAssets
    if ($LASTEXITCODE -ne 0) { throw "Web preview exited with code $LASTEXITCODE" }
} finally { $env:PATH = $taskOldPath }
