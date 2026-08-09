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
  npm install --global $cli --no-fund --no-audit --force
  if ($LASTEXITCODE -ne 0) { throw 'npm could not install Nexara CLI.' }
  Write-Host 'Installed. Run: nexara' -ForegroundColor Green
  Write-Host 'Automatic updates are enabled; newer CLI releases install silently in the background.' -ForegroundColor DarkGray
} finally {
  Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
}
