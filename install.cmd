@echo off
setlocal EnableExtensions
rem Usage: install.cmd [/DisableAutoUpdate] — /DisableAutoUpdate installs
rem without silent background updates; update manually with `nexara update`.
set "DISABLE_AUTO=0"
if /I "%~1"=="/DisableAutoUpdate" set "DISABLE_AUTO=1"
set "TEMP_DIR=%TEMP%\nexara-cli-%RANDOM%%RANDOM%"
set "PACKAGE_FILE=%TEMP_DIR%\nexara-cli.tgz"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22+ is required. Install it from https://nodejs.org/ first.
  exit /b 1
)
for /f "delims=" %%V in ('node --version') do set "NODE_VERSION=%%V"
for /f "tokens=1 delims=.v" %%V in ("%NODE_VERSION%") do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR set "NODE_MAJOR=0"
if %NODE_MAJOR% LSS 22 (
  echo Node.js 22+ is required; found %NODE_VERSION%.
  exit /b 1
)
mkdir "%TEMP_DIR%" >nul 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h = @{ Accept = 'application/vnd.github+json'; 'User-Agent' = 'nexara-cli-installer' }; $r = Invoke-RestMethod -Uri 'https://api.github.com/repos/K1NGMR/NexaraCLI/releases/latest' -Headers $h; if ($r.draft -or $r.prerelease -or $r.tag_name -notmatch '^v\d+\.\d+\.\d+$') { exit 2 }; $v = $r.tag_name.Substring(1); $a = @($r.assets) | ? { $_.name -eq ('nexara-cli-' + $v + '.tgz') } | select -First 1; $m = @($r.assets) | ? { $_.name -eq 'checksums.json' } | select -First 1; if (-not $a -or -not $m) { exit 3 }; Invoke-WebRequest -Uri $a.browser_download_url -Headers $h -OutFile '%PACKAGE_FILE%'; $j = Invoke-RestMethod -Uri $m.browser_download_url -Headers $h; $p = $j.files.psobject.Properties[('nexara-cli-' + $v + '.tgz')]; if ($j.version -ne $v -or [string]$p.Value -notmatch '^[0-9a-fA-F]{64}$') { exit 4 }; if ((Get-FileHash -LiteralPath '%PACKAGE_FILE%' -Algorithm SHA256).Hash -ne [string]$p.Value) { exit 5 }"
if errorlevel 1 goto :fail
for /f "delims=" %%R in ('npm root --global') do set "GLOBAL_ROOT=%%R"
for /f "delims=" %%P in ('npm prefix --global') do set "GLOBAL_PREFIX=%%P"
if not exist "%GLOBAL_ROOT%" goto :fail
npm install --global "%PACKAGE_FILE%" --no-fund --no-audit --force
if errorlevel 1 goto :fail
if not exist "%GLOBAL_ROOT%\nexara-cli\bin\nexara.js" goto :fail
echo Installed. Run: nexara
if "%DISABLE_AUTO%"=="1" (
  if not exist "%USERPROFILE%\.nexara" mkdir "%USERPROFILE%\.nexara"
  if exist "%USERPROFILE%\.nexara\config.json" (
    powershell -NoProfile -Command "$c = Get-Content -LiteralPath '%USERPROFILE%\.nexara\config.json' -Raw | ConvertFrom-Json; $c | Add-Member -NotePropertyName autoUpdate -NotePropertyValue $false -Force; $c | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath '%USERPROFILE%\.nexara\config.json' -Encoding UTF8"
  ) else (
    echo {"autoUpdate": false} > "%USERPROFILE%\.nexara\config.json"
  )
  echo Silent background updates are DISABLED. To update later, run: nexara update
) else (
  echo Automatic updates are enabled. Disable them with: nexara update --off
)
goto :cleanup
:fail
echo Nexara CLI installation failed.
set "EXIT_CODE=1"
:cleanup
rmdir /s /q "%TEMP_DIR%" >nul 2>nul
del /q "%PACKAGE_FILE%" >nul 2>nul
if not defined EXIT_CODE set "EXIT_CODE=0"
exit /b %EXIT_CODE%
