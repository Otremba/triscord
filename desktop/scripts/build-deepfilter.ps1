# DeepFilterNet 3 for "Supressão de ruído: Alta qualidade" (18/10). Builds libDF's C API (Rust, MIT/Apache) with the
# project's MinGW 13.1 and stages .toolchain/deepfilter: df.dll (stripped), the DFN3 model and the license texts of
# every crate linked into it. CMake copies that folder next to the executables (deepfilter/); the client loads it at
# run time and keeps RNNoise without it. Rust is installed locally in .toolchain/rust (no system PATH changes).
$ErrorActionPreference = 'Stop'
$taskRepo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$taskTools = Join-Path $taskRepo '.toolchain'
$taskCommit = 'd375b2d'   # Rikorose/DeepFilterNet main, 18/10/2026 (measured in desktop/ARQUITETURA_WEBVIEW2.md)
$taskRustVersion = '1.99.1'
$taskSource = Join-Path $taskTools 'deepfilternet-src\DeepFilterNet'
$taskTarget = Join-Path $taskTools 'deepfilternet-build'
$taskStage = Join-Path $taskTools 'deepfilter'
$env:RUSTUP_HOME = Join-Path $taskTools 'rust\rustup'
$env:CARGO_HOME = Join-Path $taskTools 'rust\cargo'
$env:CARGO_TARGET_DIR = $taskTarget
$taskOldPath = $env:PATH
try {
    $env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$(Join-Path $taskTools 'Qt\Tools\mingw1310_64\bin');$taskOldPath"
    if (-not (Test-Path -LiteralPath (Join-Path $env:CARGO_HOME 'bin\cargo.exe'))) {
        $taskInstaller = Join-Path $taskTools 'rust-installer\rustup-init.exe'
        New-Item -ItemType Directory -Path (Split-Path -Parent $taskInstaller) -Force | Out-Null
        $taskUrl = 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-gnu/rustup-init.exe'
        Invoke-WebRequest -Uri $taskUrl -OutFile $taskInstaller
        $taskExpected = ((Invoke-WebRequest -Uri "$taskUrl.sha256").Content -split '\s+')[0]
        if ((Get-FileHash -LiteralPath $taskInstaller -Algorithm SHA256).Hash -ne $taskExpected) { throw 'rustup-init checksum mismatch' }
        & $taskInstaller -y --profile minimal --default-host x86_64-pc-windows-gnu --default-toolchain $taskRustVersion --no-modify-path
        if ($LASTEXITCODE -ne 0) { throw 'Rust installation failed' }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'libDF\Cargo.toml'))) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $taskSource) -Force | Out-Null
        git clone https://github.com/Rikorose/DeepFilterNet.git $taskSource
        if ($LASTEXITCODE -ne 0) { throw 'DeepFilterNet download failed' }
    }
    git -C $taskSource -c advice.detachedHead=false checkout $taskCommit
    if ($LASTEXITCODE -ne 0) { throw "DeepFilterNet $taskCommit unavailable" }
    Push-Location $taskSource
    try {
        cargo build --release --locked -p deep_filter --no-default-features --features capi
        if ($LASTEXITCODE -ne 0) { throw 'libDF build failed' }
        $taskCrates = cargo tree --locked -p deep_filter --no-default-features --features capi -e normal --prefix none --format '{p}' |
            ForEach-Object { ($_ -replace ' \(.*$', '').Trim() } | Where-Object { $_ } | Sort-Object -Unique
        $taskMetadata = cargo metadata --locked --format-version 1 | ConvertFrom-Json
    } finally { Pop-Location }
    if (Test-Path -LiteralPath $taskStage) { Remove-Item -LiteralPath $taskStage -Recurse -Force }
    $taskLicenses = Join-Path $taskStage 'licenses'
    New-Item -ItemType Directory -Path $taskLicenses -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $taskTarget 'release\df.dll') -Destination $taskStage
    & strip --strip-all (Join-Path $taskStage 'df.dll')
    if ($LASTEXITCODE -ne 0) { throw 'strip failed' }
    Copy-Item -LiteralPath (Join-Path $taskSource 'models\DeepFilterNet3_onnx.tar.gz') -Destination $taskStage
    # License texts of DeepFilterNet itself and of each crate linked into df.dll (name vversion from cargo tree).
    $taskList = @()
    foreach ($taskCrate in $taskCrates) {
        $taskName, $taskVersion = $taskCrate -split ' v', 2
        $taskPackage = $taskMetadata.packages | Where-Object { $_.name -eq $taskName -and $_.version -eq $taskVersion } | Select-Object -First 1
        if (-not $taskPackage) { throw "No metadata for $taskCrate" }
        $taskList += "$taskName $taskVersion  $($taskPackage.license)"
        $taskDir = Split-Path -Parent $taskPackage.manifest_path
        $taskFiles = @(Get-ChildItem -LiteralPath $taskDir -File | Where-Object { $_.Name -match '^(LICEN[CS]E|COPYING|NOTICE)' })
        if ($taskName -eq 'deep_filter') { $taskFiles = @(Get-ChildItem -LiteralPath $taskSource -File | Where-Object { $_.Name -match '^LICENSE' }) }
        $taskOut = Join-Path $taskLicenses "$taskName-$taskVersion"
        New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
        foreach ($taskFile in $taskFiles) { Copy-Item -LiteralPath $taskFile.FullName -Destination $taskOut }
        if (-not $taskFiles) {
            # A few crates (crunchy) publish no license file: keep what they declare.
            Set-Content -LiteralPath (Join-Path $taskOut 'LICENSE-declared.txt') -Encoding utf8 -Value @(
                "$taskName $taskVersion is licensed under $($taskPackage.license) (declared in its Cargo.toml; the published crate has no license file).",
                "Authors: $($taskPackage.authors -join ', ')", "Repository: $($taskPackage.repository)")
        }
    }
    Set-Content -LiteralPath (Join-Path $taskLicenses 'crates.txt') -Value $taskList -Encoding utf8
    Write-Output "DeepFilterNet staged in $taskStage ($($taskCrates.Count) crates). Re-run scripts/build.ps1 to copy it next to the client."
} finally { $env:PATH = $taskOldPath }
