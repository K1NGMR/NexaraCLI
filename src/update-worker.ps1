param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$TargetVersion,

  [Parameter(Mandatory = $true)]
  [string]$StateFile,

  # When set, progress is shown (used by `nexara update`, which runs in the
  # foreground). Background auto-updates stay silent.
  [switch]$VerboseOutput
)

$ErrorActionPreference = 'Stop'
$repository = 'K1NGMR/NexaraCLI'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nexara-cli-update-" + [guid]::NewGuid().ToString('N'))
$packageFile = Join-Path $tempRoot ("nexara-cli-$TargetVersion.tgz")

function Write-State([hashtable]$Patch) {
  try {
    $parent = Split-Path -Parent $StateFile
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    $existing = @{}
    if (Test-Path -LiteralPath $StateFile) {
      $parsed = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
      if ($parsed) {
        $parsed.psobject.Properties | ForEach-Object { $existing[$_.Name] = $_.Value }
      }
    }
    foreach ($entry in $Patch.GetEnumerator()) { $existing[$entry.Key] = $entry.Value }
    $existing | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  } catch {
    # A state-file failure must not make an otherwise successful install fail.
  }
}

function Fail([string]$Message) {
  Write-State @{
    status = 'error'
    targetVersion = $TargetVersion
    error = $Message.Substring(0, [Math]::Min(300, $Message.Length))
    failedAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($VerboseOutput) {
    Write-Host ("Update failed: $Message") -ForegroundColor Red
  }
  exit 1
}

try {
  if ($VerboseOutput) { Write-Host "Downloading verified nexara-cli $TargetVersion..." -ForegroundColor Cyan }
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'nexara-cli-updater' }
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases/tags/v$TargetVersion" -Headers $headers -Method Get
  if ($release.draft -or $release.prerelease -or $release.tag_name -ne "v$TargetVersion") { Fail 'The requested CLI release is not a published stable tag.' }
  $assetName = "nexara-cli-$TargetVersion.tgz"
  $packageAsset = @($release.assets) | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
  $manifestAsset = @($release.assets) | Where-Object { $_.name -eq 'checksums.json' } | Select-Object -First 1
  if (-not $packageAsset -or -not $manifestAsset) { Fail 'The CLI release is missing its package or checksum manifest.' }
  Invoke-WebRequest -Uri $packageAsset.browser_download_url -Headers $headers -OutFile $packageFile -UseBasicParsing
  $manifest = Invoke-RestMethod -Uri $manifestAsset.browser_download_url -Headers $headers -Method Get
  $checksumProperty = $manifest.files.psobject.Properties[$assetName]
  $expectedHash = [string]$checksumProperty.Value
  if ($manifest.version -ne $TargetVersion -or $expectedHash -notmatch '^[0-9a-fA-F]{64}$') { Fail 'The CLI checksum manifest is invalid.' }
  $actualHash = (Get-FileHash -LiteralPath $packageFile -Algorithm SHA256).Hash
  if ($actualHash -ne $expectedHash) { Fail 'The downloaded CLI package failed SHA-256 verification.' }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npm) { Fail 'npm was not found on PATH.' }

  # Query the npm global paths the same way every other path does (npm.cmd is
  # a batch file, so cmd.exe runs it).
  $globalRoot = (& cmd.exe /c "`"$($npm.Source)`" root --global" | Out-String).Trim()
  $globalPrefix = (& cmd.exe /c "`"$($npm.Source)`" prefix --global" | Out-String).Trim()
  if (-not $globalRoot -or -not $globalPrefix) { Fail 'Could not determine npm global install paths.' }

  # Drive npm through cmd.exe. Calling npm.cmd directly from PowerShell while
  # silencing stderr is a trap: PowerShell turns npm's stderr noise (e.g. the
  # "using --force" warning) into an error object, which trips
  # $ErrorActionPreference = 'Stop' and aborts the update EVEN WHEN npm
  # succeeded. cmd /c runs npm cleanly and lets us check the real exit code.
  # Verbose (manual) runs show output; silent (background) runs redirect npm's
  # noise to nul INSIDE cmd.exe (cmd syntax — PowerShell's *> would also
  # trigger the stderr-to-error trap this avoids).
  if ($VerboseOutput) {
    Write-Host "Installing nexara-cli $TargetVersion globally..." -ForegroundColor Cyan
    & cmd.exe /c "`"$($npm.Source)`" install --global `"$packageFile`" --no-fund --no-audit --force"
    $npmExit = $LASTEXITCODE
  } else {
    & cmd.exe /c "`"$($npm.Source)`" install --global `"$packageFile`" --no-fund --no-audit --force >nul 2>&1"
    $npmExit = $LASTEXITCODE
  }
  if ($npmExit -ne 0) { Fail "npm install failed with exit code $npmExit." }

  $entrypoint = Join-Path $globalRoot 'nexara-cli\bin\nexara.js'
  if (-not (Test-Path -LiteralPath $entrypoint)) { Fail "Installed CLI entrypoint is missing: $entrypoint" }

  Write-State @{
    status = 'updated'
    currentVersion = $TargetVersion
    remoteVersion = $TargetVersion
    installedAt = [DateTime]::UtcNow.ToString('o')
    error = $null
  }
  if ($VerboseOutput) {
    Write-Host "Installed nexara-cli $TargetVersion. Start a new nexara session to use it." -ForegroundColor Green
  }
} catch {
  Fail ([string]$_.Exception.Message)
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
