param(
  # Install with silent background updates disabled. Updates are then manual
  # only: run `nexara update` whenever you want to install a newer version.
  [switch]$DisableAutoUpdate
)

$ErrorActionPreference = 'Stop'
$api = 'https://api.github.com/repos/K1NGMR/NexaraCLI/releases/latest'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('nexara-cli-' + [guid]::NewGuid().ToString())
$package = Join-Path $temp 'nexara-cli.tgz'
try {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw 'Node.js 22+ is required. Install it from https://nodejs.org/ first.' }
  $nodeVersion = (& $nodeCommand.Source --version).Trim()
  if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw "Node.js 22+ is required; found $nodeVersion." }
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  Write-Host 'Downloading the latest verified Nexara CLI release...' -ForegroundColor Cyan
  $headers = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'nexara-cli-installer' }
  $release = Invoke-RestMethod -Uri $api -Headers $headers -Method Get
  if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v\d+\.\d+\.\d+$') { throw 'GitHub did not return a stable CLI release.' }
  $version = $release.tag_name.Substring(1)
  $assetName = "nexara-cli-$version.tgz"
  $packageAsset = @($release.assets) | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
  $manifestAsset = @($release.assets) | Where-Object { $_.name -eq 'checksums.json' } | Select-Object -First 1
  if (-not $packageAsset -or -not $manifestAsset) { throw 'The latest CLI release is missing its package or checksum manifest.' }
  Invoke-WebRequest -Uri $packageAsset.browser_download_url -Headers $headers -OutFile $package -UseBasicParsing
  $manifest = Invoke-RestMethod -Uri $manifestAsset.browser_download_url -Headers $headers -Method Get
  $checksumProperty = $manifest.files.psobject.Properties[$assetName]
  $expectedHash = [string]$checksumProperty.Value
  if ($manifest.version -ne $version -or $expectedHash -notmatch '^[0-9a-fA-F]{64}$') { throw 'The CLI checksum manifest is invalid.' }
  $actualHash = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash
  if ($actualHash -ne $expectedHash) { throw 'The downloaded CLI package failed SHA-256 verification.' }
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npmCommand) { throw 'npm was not found on PATH.' }
  $globalRoot = (& $npmCommand.Source root --global).Trim()
  if (-not $globalRoot) { throw 'Could not determine npm global package directory.' }
  $globalPrefix = (& $npmCommand.Source prefix --global).Trim()
  if (-not $globalPrefix) { throw 'Could not determine npm global prefix.' }
  # npm replaces the package and shims as one install operation. Do not delete
  # the working installation first: a failed download or install must not
  # leave the user with no `nexara` command at all.
  & $npmCommand.Source install --global $package --no-fund --no-audit --force
  if ($LASTEXITCODE -ne 0) { throw 'npm could not install Nexara CLI.' }
  $entrypoint = Join-Path $globalRoot 'nexara-cli\bin\nexara.js'
  if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "Nexara CLI installed without its entrypoint: $entrypoint"
  }
  Write-Host 'Installed. Run: nexara' -ForegroundColor Green
  if ($DisableAutoUpdate) {
    try {
      $configDir = Join-Path $HOME '.nexara'
      New-Item -ItemType Directory -Path $configDir -Force | Out-Null
      $configFile = Join-Path $configDir 'config.json'
      $existing = @{}
      if (Test-Path -LiteralPath $configFile) {
        $parsed = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
        if ($parsed) { $parsed.psobject.Properties | ForEach-Object { $existing[$_.Name] = $_.Value } }
      }
      $existing['autoUpdate'] = $false
      $existing | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $configFile -Encoding UTF8
    } catch {
      # Best effort — the CLI also honors NEXARA_NO_AUTO_UPDATE=1 per run.
    }
    Write-Host 'Silent background updates are DISABLED. To update later, run: nexara update' -ForegroundColor DarkGray
  } else {
    Write-Host 'Automatic updates are enabled; newer CLI releases install silently in the background. Disable them with: nexara update --off' -ForegroundColor DarkGray
  }
} finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
}
