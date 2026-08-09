$ErrorActionPreference = 'Stop'
$repo = 'https://github.com/K1NGMR/NexaraCLI/archive/refs/heads/main.zip'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('nexara-cli-' + [guid]::NewGuid().ToString())
$zip = "$temp.zip"
try {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 20+ is required. Install it from https://nodejs.org/ first.' }
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  Write-Host 'Downloading Nexara CLI...' -ForegroundColor Cyan
  Invoke-WebRequest -Uri $repo -OutFile $zip -UseBasicParsing
  Expand-Archive -Path $zip -DestinationPath $temp -Force
  $cli = Get-ChildItem -Path $temp -Directory | Select-Object -First 1
  if (-not $cli -or -not (Test-Path (Join-Path $cli.FullName 'package.json'))) { throw 'The NexaraCLI package was not found in the downloaded source.' }
  $cli = $cli.FullName
  # npm can leave a same-version global install in place when an older
  # archive had a different file layout. Remove only this package and its
  # generated shims so reinstalling repairs broken `nexara` commands too.
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command npm -ErrorAction SilentlyContinue }
  if (-not $npmCommand) { throw 'npm was not found on PATH.' }
  $globalRoot = (& $npmCommand.Source root --global).Trim()
  if (-not $globalRoot) { throw 'Could not determine npm global package directory.' }
  $globalPrefix = (& $npmCommand.Source prefix --global).Trim()
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
  & $npmCommand.Source install --global $cli --no-fund --no-audit --force
  if ($LASTEXITCODE -ne 0) { throw 'npm could not install Nexara CLI.' }
  $entrypoint = Join-Path $globalRoot 'nexara-cli\bin\nexara.js'
  if (-not (Test-Path -LiteralPath $entrypoint)) {
    throw "Nexara CLI installed without its entrypoint: $entrypoint"
  }
  Write-Host 'Installed. Run: nexara' -ForegroundColor Green
  Write-Host 'Automatic updates are enabled; newer CLI releases install silently in the background.' -ForegroundColor DarkGray
} finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
}
