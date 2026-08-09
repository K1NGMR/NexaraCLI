param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$TargetVersion,

  [Parameter(Mandatory = $true)]
  [string]$StateFile
)

$ErrorActionPreference = 'Stop'
$repository = 'K1NGMR/NexaraCLI'
$archiveUrl = "https://github.com/$repository/archive/refs/heads/main.zip"
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("nexara-cli-update-" + [guid]::NewGuid().ToString('N'))
$zipFile = "$tempRoot.zip"

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

try {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npm) { throw 'npm was not found on PATH.' }

  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Invoke-WebRequest -Uri "$archiveUrl?update=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile $zipFile -UseBasicParsing
  Expand-Archive -LiteralPath $zipFile -DestinationPath $tempRoot -Force

  $archiveRoot = Get-ChildItem -LiteralPath $tempRoot -Directory | Select-Object -First 1
  if (-not $archiveRoot) { throw 'The GitHub archive was empty.' }
  $cliRoot = $archiveRoot.FullName
  $packageFile = Join-Path $cliRoot 'package.json'
  if (-not (Test-Path -LiteralPath $packageFile)) { throw 'The NexaraCLI package was not found in the GitHub archive.' }

  $globalRoot = (& $npm.Source root --global).Trim()
  $globalPrefix = (& $npm.Source prefix --global).Trim()
  if (-not $globalRoot -or -not $globalPrefix) { throw 'Could not determine npm global install paths.' }
  $oldPackage = Join-Path $globalRoot 'nexara-cli'
  if (Test-Path -LiteralPath $oldPackage) {
    Remove-Item -LiteralPath $oldPackage -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($shim in @('nexara', 'nexara.cmd', 'nexara.ps1')) {
    $shimPath = Join-Path $globalPrefix $shim
    if (Test-Path -LiteralPath $shimPath) {
      Remove-Item -LiteralPath $shimPath -Force -ErrorAction SilentlyContinue
    }
  }
  & $npm.Source install --global $cliRoot --no-fund --no-audit --force *> $null
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE." }
  $entrypoint = Join-Path $globalRoot 'nexara-cli\bin\nexara.js'
  if (-not (Test-Path -LiteralPath $entrypoint)) { throw "Installed CLI entrypoint is missing: $entrypoint" }
  Write-State @{
    status = 'updated'
    currentVersion = $TargetVersion
    remoteVersion = $TargetVersion
    installedAt = [DateTime]::UtcNow.ToString('o')
    error = $null
  }
} catch {
  Write-State @{
    status = 'error'
    targetVersion = $TargetVersion
    error = ([string]$_.Exception.Message).Substring(0, [Math]::Min(300, ([string]$_.Exception.Message).Length))
    failedAt = [DateTime]::UtcNow.ToString('o')
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
}
