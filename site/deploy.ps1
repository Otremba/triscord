param(
    [string]$Directory = '',
    [string]$WranglerPath = '',
    [string]$TokenFile = '',
    [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'
$taskRepository = Split-Path -Parent $PSScriptRoot
if (-not $Directory) { $Directory = Join-Path $taskRepository 'desktop/out/site-dist' }
if (-not $TokenFile) { $TokenFile = Join-Path $env:USERPROFILE '.codex/secrets/triscord-cloudflare-pages.dpapi' }
if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) { throw 'Cloudflare Pages token is not configured for this Windows user.' }
if (-not $VerifyOnly) {
    if (-not (Test-Path -LiteralPath (Join-Path $Directory '_redirects') -PathType Leaf)) { throw 'Stage the site with node site/stage.mjs before deploying.' }
    if (-not $WranglerPath) { $WranglerPath = Join-Path $taskRepository 'cloudflare/node_modules/.bin/wrangler.cmd' }
    if (-not (Test-Path -LiteralPath $WranglerPath -PathType Leaf)) { throw 'Wrangler is missing; install cloudflare dependencies or specify -WranglerPath.' }
}
$taskOldToken = $env:CLOUDFLARE_API_TOKEN
$taskOldAccount = $env:CLOUDFLARE_ACCOUNT_ID
$taskPointer = [IntPtr]::Zero
try {
    $taskSecureToken = (Get-Content -LiteralPath $TokenFile -Raw).Trim() | ConvertTo-SecureString
    $taskPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecureToken)
    $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPointer)
    $env:CLOUDFLARE_ACCOUNT_ID = '6560ec793840e7fe4bfdfc063795428c'
    if ($VerifyOnly) {
        $taskResponse = Invoke-RestMethod -Uri "https://api.cloudflare.com/client/v4/accounts/$env:CLOUDFLARE_ACCOUNT_ID/pages/projects/triscord" -Headers @{ Authorization = "Bearer $env:CLOUDFLARE_API_TOKEN" }
        if (-not $taskResponse.success -or $taskResponse.result.name -ne 'triscord') { throw 'The Pages credential cannot access the Triscord project.' }
        Write-Output 'Cloudflare Pages credential can access the Triscord project.'
    } else {
        & $WranglerPath pages deploy $Directory --project-name triscord --branch main --commit-dirty=true
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare Pages deployment failed.' }
    }
} finally {
    $env:CLOUDFLARE_API_TOKEN = $taskOldToken
    $env:CLOUDFLARE_ACCOUNT_ID = $taskOldAccount
    if ($taskPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPointer) }
    if ($taskSecureToken) { $taskSecureToken.Dispose() }
}
