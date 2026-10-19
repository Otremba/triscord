# Build the current C++/WebView2 client; packaging belongs to portable-web.ps1.
param([switch]$DevTools, [string]$GroupInviteFile = '', [string]$BuildDir = '')
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskQt = Join-Path $taskTools 'Qt/6.8.3/mingw_64'
$taskCmake = Join-Path $taskTools 'venv/Scripts/cmake.exe'
$taskBuild = Join-Path $taskRepo 'desktop/out/build'
if ($BuildDir) { $taskBuild = Join-Path (Join-Path $taskRepo 'desktop') $BuildDir }
if (-not (Test-Path -LiteralPath $taskCmake)) { throw 'Run desktop/scripts/setup.ps1 first' }
if (-not (Test-Path -LiteralPath (Join-Path $taskRepo 'desktop/web/dist/index.html'))) {
    throw 'Build the interface first: npm run build:web'
}
$taskOldPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $taskTools 'Qt/Tools/mingw1310_64/bin');$(Join-Path $taskTools 'venv/Scripts');$taskQt/bin;$taskOldPath"
    $taskDevFlag = if ($DevTools) { 'ON' } else { 'OFF' }
    $taskSources = @()
    foreach ($taskDependency in @(@('RTC', 'libdatachannel'), @('OPUS', 'opus'), @('MBEDTLS', 'mbedtls'), @('SPEEXDSP', 'speexdsp'))) {
        $taskSource = Join-Path $taskTools $taskDependency[1]
        if (Test-Path -LiteralPath (Join-Path $taskSource 'CMakeLists.txt')) {
            $taskSources += "-DFETCHCONTENT_SOURCE_DIR_$($taskDependency[0])=$taskSource"
        }
    }
    $taskGroupFile = if ($GroupInviteFile) { (Resolve-Path -LiteralPath $GroupInviteFile).Path } else { '' }
    & $taskCmake -S (Join-Path $taskRepo 'desktop') -B $taskBuild -G Ninja -DCMAKE_BUILD_TYPE=Release "-DCMAKE_PREFIX_PATH=$taskQt" "-DTRISCORD_BUILD_DEV_TOOLS=$taskDevFlag" -DTRISCORD_BUILD_WEB_CLIENT=ON -DBUILD_TESTING=ON "-DTRISCORD_GROUP_INVITE_FILE=$taskGroupFile" @taskSources
    if ($LASTEXITCODE -ne 0) { throw 'CMake configuration failed' }
    & $taskCmake --build $taskBuild --parallel 4
    if ($LASTEXITCODE -ne 0) { throw 'Native build failed' }
} finally { $env:PATH = $taskOldPath }
