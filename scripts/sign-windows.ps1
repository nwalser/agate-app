<#
.SYNOPSIS
  Authenticode-sign Agate's Windows installers on your desktop with the local
  Certum / SimplySign code-signing certificate.

.DESCRIPTION
  Agate is a $0 project, so there is no CI code signing on Windows: the Certum
  code-signing key is non-exportable (it lives in the SimplySign cloud token), so
  it can never be a GitHub Actions secret. Signing therefore happens *locally*,
  on the maintainer's machine, with this script.

  It finds signtool.exe (Windows SDK), signs each given file with the cert
  identified by -Thumbprint, RFC-3161 timestamps it (so signatures stay valid
  after the cert expires), then verifies the signature chains to a trusted root.

  Prerequisite: SimplySign Desktop must be running AND the virtual card/token
  connected (logged in). If it isn't, signing fails with a key/token error.

.PARAMETER Path
  One or more installers (or globs) to sign. Defaults to the NSIS + MSI bundles
  Tauri emits under src-tauri/target/release/bundle.

.PARAMETER Thumbprint
  SHA-1 thumbprint of the signing certificate in Cert:\CurrentUser\My.
  Defaults to the maintainer's Certum cert.

.PARAMETER TimestampUrl
  RFC-3161 timestamp server. Defaults to Certum's.

.EXAMPLE
  pwsh scripts/sign-windows.ps1
  # signs every installer under the default bundle dir

.EXAMPLE
  pwsh scripts/sign-windows.ps1 -Path .\Agate_0.2.0_x64-setup.exe

.NOTES
  ⚠ Auto-updater interaction: Tauri's updater verifies a *minisign* signature
  computed over the installer bytes. If you sign an installer with THIS script
  after `tauri build` already produced the updater .sig, that .sig no longer
  matches and auto-update will reject it. To ship signed + updatable builds,
  Authenticode-sign DURING the build instead, so the minisign sig is taken over
  the already-signed bytes:

    npm run tauri build -- --config '{\"bundle\":{\"windows\":{\"certificateThumbprint\":\"<THUMBPRINT>\",\"timestampUrl\":\"http://time.certum.pl\",\"digestAlgorithm\":\"sha256\"}}}'

  Use this post-build script for one-off / non-updater artifacts, or re-generate
  the updater .sig afterwards with `tauri signer sign`.
#>
[CmdletBinding()]
param(
  [string[]] $Path,
  [string]   $Thumbprint = '8E74027425C2C858ADD295403738D784148F77EB',
  [string]   $TimestampUrl = 'http://time.certum.pl'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Find-SignTool {
  $roots = @(
    "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
    "$env:ProgramFiles\Windows Kits\10\bin"
  )
  $tool = foreach ($r in $roots) {
    if (Test-Path $r) {
      Get-ChildItem $r -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' }
    }
  }
  $picked = $tool | Sort-Object { $_.VersionInfo.ProductVersion } -Descending | Select-Object -First 1
  if (-not $picked) { throw "signtool.exe not found. Install the Windows 10/11 SDK." }
  $picked.FullName
}

# Resolve the artifacts to sign.
if (-not $Path -or $Path.Count -eq 0) {
  $bundle = Join-Path $repoRoot 'src-tauri\target\release\bundle'
  $Path = @(
    (Join-Path $bundle 'nsis\*-setup.exe'),
    (Join-Path $bundle 'msi\*.msi')
  )
}
$files = $Path |
  ForEach-Object { Get-Item -Path $_ -ErrorAction SilentlyContinue } |
  Where-Object { $_ } |
  Select-Object -ExpandProperty FullName -Unique

if (-not $files) {
  throw "No installers found to sign. Build first (npm run tauri build), or pass -Path. Looked for: $($Path -join ', ')"
}

# Cert + token sanity checks (fail early with a clear message).
$cert = Get-Item "Cert:\CurrentUser\My\$Thumbprint" -ErrorAction SilentlyContinue
if (-not $cert) {
  throw "No certificate with thumbprint $Thumbprint in Cert:\CurrentUser\My. List with: Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert"
}
Write-Host "Signing as: $($cert.Subject)" -ForegroundColor Cyan
Write-Host "Issuer    : $($cert.Issuer)"
if (-not (Get-Process -Name 'SimplySignDesktop' -ErrorAction SilentlyContinue)) {
  Write-Warning "SimplySign Desktop is not running. Start it and connect your virtual card, or signing will fail."
}

$signtool = Find-SignTool
Write-Host "signtool  : $signtool`n"

$failed = @()
foreach ($f in $files) {
  Write-Host "--> $f" -ForegroundColor Yellow
  & $signtool sign /sha1 $Thumbprint /fd sha256 /tr $TimestampUrl /td sha256 $f
  if ($LASTEXITCODE -ne 0) { $failed += $f; Write-Host "  sign FAILED ($LASTEXITCODE)" -ForegroundColor Red; continue }
  & $signtool verify /pa /q $f
  if ($LASTEXITCODE -ne 0) { $failed += $f; Write-Host "  verify FAILED ($LASTEXITCODE)" -ForegroundColor Red; continue }
  Write-Host "  signed + verified OK" -ForegroundColor Green
}

Write-Host ""
if ($failed.Count -gt 0) {
  Write-Host "FAILED ($($failed.Count)): $($failed -join ', ')" -ForegroundColor Red
  exit 1
}
Write-Host "All $($files.Count) artifact(s) signed and verified." -ForegroundColor Green
