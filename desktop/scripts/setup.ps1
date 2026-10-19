$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskPython = Join-Path $taskTools 'venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $taskPython)) {
    python -m venv (Join-Path $taskTools 'venv')
    if ($LASTEXITCODE -ne 0) { throw 'Python 3 with venv is required' }
}
& $taskPython -m pip install aqtinstall==3.3.0 cmake==4.4.4 ninja==1.13.2
if ($LASTEXITCODE -ne 0) { throw 'Build tool installation failed' }
$taskQt = Join-Path $taskTools 'Qt'
if (-not (Test-Path -LiteralPath (Join-Path $taskQt '6.8.3\mingw_64\bin\Qt6Multimedia.dll'))) {
    & $taskPython -m aqt install-qt windows desktop 6.8.3 win64_mingw -O $taskQt -m qtwebsockets qtmultimedia --archives qtbase qtwebsockets qtmultimedia
    if ($LASTEXITCODE -ne 0) { throw 'Qt installation failed' }
}
if (-not (Test-Path -LiteralPath (Join-Path $taskQt 'Tools\mingw1310_64\bin\g++.exe'))) {
    & $taskPython -m aqt install-tool windows desktop tools_mingw1310 -O $taskQt
    if ($LASTEXITCODE -ne 0) { throw 'MinGW installation failed' }
}
& (Join-Path $PSScriptRoot 'setup-webview2.ps1')
Write-Output "Build tools installed locally in $taskTools. No system PATH changes."
