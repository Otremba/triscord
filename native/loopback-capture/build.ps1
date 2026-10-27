# Builds native/bin/loopback-capture.exe with the C# compiler that ships with
# Windows (.NET Framework 4.x), so no SDK install is needed.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$source = Join-Path $PSScriptRoot 'LoopbackCapture.cs'
$outDir = Join-Path $root 'native\bin'
$output = Join-Path $outDir 'loopback-capture.exe'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    throw "C# compiler not found at $csc (.NET Framework 4.x is required)"
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

& $csc /nologo /optimize+ /platform:x64 /target:exe "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

Write-Host "Built $output"
