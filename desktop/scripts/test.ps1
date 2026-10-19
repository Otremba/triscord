$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskOldPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $taskTools 'Qt\Tools\mingw1310_64\bin');$(Join-Path $taskTools 'venv\Scripts');$(Join-Path $taskTools 'Qt\6.8.3\mingw_64\bin');$taskOldPath"
    & (Join-Path $taskTools 'venv\Scripts\ctest.exe') --test-dir (Join-Path $taskRepo 'desktop\out\build') --output-on-failure
    if ($LASTEXITCODE -ne 0) {
        $taskReports = Join-Path $taskRepo 'desktop\out\build\qt-test-results'
        if (Test-Path -LiteralPath $taskReports) {
            foreach ($taskReport in Get-ChildItem -LiteralPath $taskReports -Filter '*.txt' -File) {
                if (Select-String -LiteralPath $taskReport.FullName -Pattern '^FAIL!|^QFATAL' -Quiet) {
                    Write-Output $taskReport.Name
                    Get-Content -LiteralPath $taskReport.FullName
                }
            }
        }
        throw 'Native tests failed; QtTest reports are in desktop/out/build/qt-test-results'
    }
    $taskDevExe = Join-Path $taskRepo 'desktop\out\build\triscord-dev-tools.exe'
    if (-not (Test-Path -LiteralPath $taskDevExe)) { throw 'Build development tools with desktop/scripts/build.ps1 -DevTools first' }
    & (Join-Path $taskTools 'venv\Scripts\python.exe') (Join-Path $taskRepo 'desktop\tests\integration_smoke.py') --exe $taskDevExe --voice-exe (Join-Path $taskRepo 'desktop\out\build\triscord-voice-smoke.exe') --screen-exe (Join-Path $taskRepo 'desktop\out\build\triscord-screen-room-smoke.exe') --dual-video-exe (Join-Path $taskRepo 'desktop\out\build\triscord-dual-video-smoke.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Native signaling/media integration failed; see output above' }
    node (Join-Path $taskRepo 'desktop\tests\feature_policy.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Desktop-only feature policy failed' }
} finally { $env:PATH = $taskOldPath }
