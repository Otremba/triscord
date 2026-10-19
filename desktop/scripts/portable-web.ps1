param([string]$GroupInviteFile = '', [string]$GoogleSecretFile = '', [switch]$SkipRuntimeVerification)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskDesktop = Join-Path $taskRepo 'desktop'
$taskQt = Join-Path $taskTools 'Qt\6.8.3\mingw_64'
$taskBuild = Join-Path $taskDesktop 'out\release'
# Unique staging: never clear another build's files or an installation in use.
$taskDist = Join-Path $taskDesktop ("out\web-package-stage\" + [Guid]::NewGuid().ToString('N'))
$taskCmake = Join-Path $taskTools 'venv\Scripts\cmake.exe'
$taskPython = Join-Path $taskTools 'venv\Scripts\python.exe'
$taskNsis = Join-Path $taskTools 'nsis-3.11\makensis.exe'
$taskOldPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $taskTools 'Qt\Tools\mingw1310_64\bin');$taskQt\bin;$taskOldPath"
    Push-Location (Join-Path $taskDesktop 'web')
    try {
        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Web typecheck failed' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Web assets build failed' }
    } finally { Pop-Location }
    if (-not $GroupInviteFile) { $GroupInviteFile = Join-Path $taskDesktop 'out\cloudflare-group-invite.txt' }
    $taskGroupFile = (Resolve-Path -LiteralPath $GroupInviteFile).Path
    # Google sign-in on other computers needs the desktop client secret built in (CMakeLists.txt); without it a friend's
    # copy shows "Login com Google indisponível: configuração ausente" (18/10). Local, ignored file.
    if (-not $GoogleSecretFile) { $GoogleSecretFile = Join-Path $taskDesktop 'out\google-client-secret.txt' }
    if (-not (Test-Path -LiteralPath $GoogleSecretFile)) { throw "Missing $GoogleSecretFile (Google desktop OAuth client secret)" }
    $taskGoogleFile = (Resolve-Path -LiteralPath $GoogleSecretFile).Path
    $taskSources = @()
    foreach ($taskDependency in @(@('RTC', 'libdatachannel'), @('OPUS', 'opus'), @('MBEDTLS', 'mbedtls'), @('SPEEXDSP', 'speexdsp'))) {
        $taskSource = Join-Path $taskTools $taskDependency[1]
        if (Test-Path -LiteralPath (Join-Path $taskSource 'CMakeLists.txt')) { $taskSources += "-DFETCHCONTENT_SOURCE_DIR_$($taskDependency[0])=$taskSource" }
    }
    & $taskCmake -S $taskDesktop -B $taskBuild -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_PREFIX_PATH=$taskQt" -DTRISCORD_BUILD_DEV_TOOLS=OFF -DTRISCORD_BUILD_WEB_CLIENT=ON -DBUILD_TESTING=OFF "-DTRISCORD_GROUP_INVITE_FILE=$taskGroupFile" "-DTRISCORD_GOOGLE_CLIENT_SECRET_FILE=$taskGoogleFile" @taskSources
    if ($LASTEXITCODE -ne 0) { throw 'Web release configuration failed' }
    & $taskCmake --build $taskBuild --target triscord-web-assets --parallel 4
    if ($LASTEXITCODE -ne 0) { throw 'Web release compilation failed' }
    New-Item -ItemType Directory -Path $taskDist | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskBuild 'triscord-web.exe'),(Join-Path $taskBuild 'WebView2Loader.dll') -Destination $taskDist
    Copy-Item -LiteralPath (Join-Path $taskBuild 'web') -Destination $taskDist -Recurse
    # DeepFilterNet 3, the default "Supressão de ruído: Alta qualidade" (staged by scripts/build-deepfilter.ps1).
    if (-not (Test-Path -LiteralPath (Join-Path $taskBuild 'deepfilter\df.dll'))) { throw 'Run scripts/build-deepfilter.ps1 first (DeepFilterNet)' }
    Copy-Item -LiteralPath (Join-Path $taskBuild 'deepfilter') -Destination $taskDist -Recurse
    # No system D3D/DXC compiler: windeployqt would copy this build machine's System32 D3DCompiler_47.dll, which on
    # current Windows 11 imports msvcp_win.dll!__std_parallel_algorithms_hw_threads, absent from older Windows 10/11
    # ("Entry Point Not Found" on a friend's PC, 18/10). Every supported Windows (8.1+) has its own d3dcompiler_47.dll.
    & "$taskQt\bin\windeployqt.exe" --release --no-translations --no-system-d3d-compiler --no-system-dxc-compiler (Join-Path $taskDist 'triscord-web.exe')
    if ($LASTEXITCODE -ne 0) { throw 'Web Qt deployment failed' }
    Copy-Item -LiteralPath (Join-Path $taskDesktop 'THIRD_PARTY_NOTICES.md') -Destination $taskDist
    Copy-Item -LiteralPath (Join-Path $taskBuild 'media-licenses') -Destination $taskDist -Recurse
    foreach ($taskNotice in @(@((Join-Path $taskQt 'licenses'),'licenses'),@((Join-Path $taskQt 'sbom'),'sbom'),@((Join-Path $taskTools 'Qt\Tools\mingw1310_64\licenses'),'mingw-licenses'))) {
        if (Test-Path -LiteralPath $taskNotice[0]) { Copy-Item -LiteralPath $taskNotice[0] -Destination (Join-Path $taskDist $taskNotice[1]) -Recurse }
    }
    $taskWebLicenses = Join-Path $taskDist 'web-licenses'
    New-Item -ItemType Directory -Path $taskWebLicenses | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskDesktop 'web\node_modules\preact\LICENSE') -Destination (Join-Path $taskWebLicenses 'preact-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $taskTools 'webview2\LICENSE.txt') -Destination (Join-Path $taskWebLicenses 'WebView2-LICENSE.txt')
    Copy-Item -LiteralPath (Join-Path $taskTools 'webview2\NOTICE.txt') -Destination (Join-Path $taskWebLicenses 'WebView2-NOTICE.txt')
    # Explicit local-only option when the user prohibits end-to-end/runtime checks. Static package checks still run.
    foreach ($taskRequired in @('triscord-web.exe','WebView2Loader.dll','web\index.html','deepfilter\df.dll','deepfilter\DeepFilterNet3_onnx.tar.gz','media-licenses\DeepFilterNet\crates.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $taskDist $taskRequired) -PathType Leaf)) { throw "Missing package file: $taskRequired" }
    }
    if ((Get-FileHash -LiteralPath (Join-Path $taskDist 'deepfilter\DeepFilterNet3_onnx.tar.gz') -Algorithm SHA256).Hash -ne 'C94D91F70911001C946E0FABB4AA9ADC37045F45A03B56008CB0C8244CB63616') { throw 'DeepFilterNet model checksum mismatch' }
    if (-not $SkipRuntimeVerification) {
        & $taskPython (Join-Path $taskDesktop 'tests\verify_web_release.py') --exe (Join-Path $taskDist 'triscord-web.exe') --google-secret-file $taskGoogleFile --report (Join-Path $taskDesktop 'out\web-release-verification')
        if ($LASTEXITCODE -ne 0) { throw 'Web release verification failed' }
    } else { Write-Warning 'Runtime verification skipped by explicit request; this local package has static checks only.' }
    $taskHasher = [Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
    try {
        $taskHasher.AppendData([IO.File]::ReadAllBytes((Join-Path $taskDesktop 'packaging\portable.nsi')))
        $taskHasher.AppendData([Text.Encoding]::UTF8.GetBytes('APP_EXE=triscord-web.exe'))
        foreach ($taskFile in (Get-ChildItem -LiteralPath $taskDist -Recurse -File | Sort-Object FullName)) {
            $taskRelative = $taskFile.FullName.Substring($taskDist.Length).TrimStart('\','/').Replace('\','/')
            $taskHasher.AppendData([Text.Encoding]::UTF8.GetBytes($taskRelative + [Environment]::NewLine))
            $taskHasher.AppendData([IO.File]::ReadAllBytes($taskFile.FullName))
        }
        $taskPackageId = [BitConverter]::ToString($taskHasher.GetHashAndReset()).Replace('-','').ToLowerInvariant().Substring(0,20)
    } finally { $taskHasher.Dispose() }
    $taskOutput = Join-Path $taskDesktop 'out\triscord-web.exe'
    $taskVersion = ([regex]::Match((Get-Content -LiteralPath (Join-Path $taskDesktop 'CMakeLists.txt') -Raw), 'project\(TriscordNative VERSION ([0-9.]+)')).Groups[1].Value
    & $taskNsis /V2 /INPUTCHARSET UTF8 "/DAPP_VERSION=$taskVersion" "/DAPP_ICON=$(Join-Path $taskDesktop 'assets\triscord-app.ico')" "/DPACKAGE_DIR=$taskDist" "/DOUTPUT_EXE=$taskOutput" "/DPACKAGE_ID=$taskPackageId" /DAPP_EXE=triscord-web.exe (Join-Path $taskDesktop 'packaging\portable.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Web portable packaging failed' }
    $taskRuntime = Join-Path $env:LOCALAPPDATA "TriscordNative\runtime\$taskPackageId\triscord-web.exe"
    if (-not $SkipRuntimeVerification) {
        & $taskPython (Join-Path $taskDesktop 'tests\verify_web_release.py') --exe (Join-Path $taskDist 'triscord-web.exe') --launcher $taskOutput --runtime $taskRuntime --report (Join-Path $taskDesktop 'out\web-portable-verification')
        if ($LASTEXITCODE -ne 0) { throw 'Extracted portable verification failed' }
    }
    # Per-user installer from the same verified staging (packaging/installer.nsi), with its SHA-256 for the updater's
    # release ("desktop-v<version>": Triscord-Setup-<version>.exe and Triscord-Setup-<version>.exe.sha256).
    $taskSetup = Join-Path $taskDesktop "out\Triscord-Setup-$taskVersion.exe"
    & $taskNsis /V2 /INPUTCHARSET UTF8 "/DAPP_VERSION=$taskVersion" "/DAPP_ICON=$(Join-Path $taskDesktop 'assets\triscord-app.ico')" "/DPACKAGE_DIR=$taskDist" "/DOUTPUT_EXE=$taskSetup" /DAPP_EXE=triscord-web.exe (Join-Path $taskDesktop 'packaging\installer.nsi')
    if ($LASTEXITCODE -ne 0) { throw 'Web installer packaging failed' }
    $taskSetupSha = (Get-FileHash -LiteralPath $taskSetup -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$taskSetup.sha256", "$taskSetupSha  Triscord-Setup-$taskVersion.exe`n")
    @{ interface = 'webview2'; packageId = $taskPackageId; executable = $taskOutput; staging = $taskDist; entryPoint = 'triscord-web.exe'; sha256 = (Get-FileHash -LiteralPath $taskOutput -Algorithm SHA256).Hash; version = $taskVersion; installer = $taskSetup; installerSha256 = $taskSetupSha; runtimeVerified = (-not $SkipRuntimeVerification) } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskDesktop 'out\portable-web-package.json') -Encoding utf8
    Write-Output "WebView2 portable packaged (runtime verification: $(-not $SkipRuntimeVerification)): $taskOutput"
} finally { $env:PATH = $taskOldPath }
