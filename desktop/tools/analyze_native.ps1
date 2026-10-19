param(
    [Parameter(Mandatory)][string]$Target,
    [string]$ReaRepo = 'C:/Users/camargo/Documents/GitHub/rea'
)
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskRuntime = Join-Path $taskRepo '.toolchain/rea-runtime'
$taskGhidra = Join-Path $taskRuntime 'ghidra/ghidra_12.1.4_PUBLIC'
$taskJdk = Join-Path $taskRuntime 'jdk/jdk-21.0.12.1+1'
$taskInput = (Resolve-Path -LiteralPath $Target).Path
$taskCli = Join-Path $ReaRepo 'scripts/rea.mjs'
if (-not (Test-Path -LiteralPath (Join-Path $taskGhidra 'Ghidra/application.properties')) -or
    -not (Test-Path -LiteralPath (Join-Path $taskJdk 'bin/java.exe')) -or
    -not (Test-Path -LiteralPath $taskCli)) { throw 'Verified REA/Ghidra/JDK development runtime is missing' }
$taskPreviousGhidra = $env:GHIDRA_INSTALL_DIR
$taskPreviousJava = $env:JAVA_HOME
$taskPreviousTimeout = $env:REA_GHIDRA_STARTUP_TIMEOUT_MS
try {
    $env:GHIDRA_INSTALL_DIR = $taskGhidra
    $env:JAVA_HOME = $taskJdk
    $env:REA_GHIDRA_STARTUP_TIMEOUT_MS = '1800000'
    & node $taskCli analyze $taskInput --provider ghidra --format json --full-output
    if ($LASTEXITCODE -ne 0) { throw 'Native analysis did not complete; inspect the retained REA result' }
} finally {
    $env:GHIDRA_INSTALL_DIR = $taskPreviousGhidra
    $env:JAVA_HOME = $taskPreviousJava
    $env:REA_GHIDRA_STARTUP_TIMEOUT_MS = $taskPreviousTimeout
}
