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
$archiveUrl = "https://github.com/$repository/archive/refs/heads/main.zip?version=$TargetVersion"
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
  if ($VerboseOutput) { Write-Host "Downloading nexara-cli $TargetVersion..." -ForegroundColor Cyan }
  New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
  Invoke-WebRequest -Uri $archiveUrl -OutFile $zipFile -UseBasicParsing
  Expand-Archive -LiteralPath $zipFile -DestinationPath $tempRoot -Force

  $archiveRoot = Get-ChildItem -LiteralPath $tempRoot -Directory | Select-Object -First 1
  if (-not $archiveRoot) { Fail 'The GitHub archive was empty.' }
  $cliRoot = $archiveRoot.FullName
  $packageFile = Join-Path $cliRoot 'package.json'
  if (-not (Test-Path -LiteralPath $packageFile)) { Fail 'The NexaraCLI package was not found in the GitHub archive.' }
  $package = Get-Content -LiteralPath $packageFile -Raw | ConvertFrom-Json
  if ($package.version -ne $TargetVersion) {
    Fail "Downloaded source version $($package.version) does not match requested version $TargetVersion."
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npm) { Fail 'npm was not found on PATH.' }

  # Query the npm global paths the same way every other path does (npm.cmd is
  # a batch file, so cmd.exe runs it).
  $globalRoot = (& cmd.exe /c "`"$($npm.Source)`" root --global" | Out-String).Trim()
  $globalPrefix = (& cmd.exe /c "`"$($npm.Source)`" prefix --global" | Out-String).Trim()
  if (-not $globalRoot -or -not $globalPrefix) { Fail 'Could not determine npm global install paths.' }

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
    & cmd.exe /c "`"$($npm.Source)`" install --global `"$cliRoot`" --no-fund --no-audit --force"
    $npmExit = $LASTEXITCODE
  } else {
    & cmd.exe /c "`"$($npm.Source)`" install --global `"$cliRoot`" --no-fund --no-audit --force >nul 2>&1"
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
  Remove-Item -LiteralPath $zipFile -Force -ErrorAction SilentlyContinue
}
