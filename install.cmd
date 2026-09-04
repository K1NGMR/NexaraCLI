@echo off
setlocal EnableExtensions
rem Usage: install.cmd [/DisableAutoUpdate] — /DisableAutoUpdate installs
rem without silent background updates; update manually with `nexara update`.
set "DISABLE_AUTO=0"
if /I "%~1"=="/DisableAutoUpdate" set "DISABLE_AUTO=1"
set "TEMP_DIR=%TEMP%\nexara-cli-%RANDOM%%RANDOM%"
set "ZIP_FILE=%TEMP_DIR%.zip"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install it from https://nodejs.org/ first.
  exit /b 1
)
mkdir "%TEMP_DIR%" >nul 2>nul
curl -fL "https://github.com/K1NGMR/NexaraCLI/archive/refs/heads/main.zip?version=0.1.69" -o "%ZIP_FILE%"
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP_FILE%' -DestinationPath '%TEMP_DIR%' -Force"
if errorlevel 1 goto :fail
for /d %%D in ("%TEMP_DIR%\NexaraCLI-*") do set "ROOT=%%D"
if not exist "%ROOT%\package.json" goto :fail
for /f "delims=" %%R in ('npm root --global') do set "GLOBAL_ROOT=%%R"
for /f "delims=" %%P in ('npm prefix --global') do set "GLOBAL_PREFIX=%%P"
if not exist "%GLOBAL_ROOT%" goto :fail
rmdir /s /q "%GLOBAL_ROOT%\nexara-cli" >nul 2>nul
del /q "%GLOBAL_PREFIX%\nexara" "%GLOBAL_PREFIX%\nexara.cmd" "%GLOBAL_PREFIX%\nexara.ps1" >nul 2>nul
npm install --global "%ROOT%" --no-fund --no-audit --force
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
del /q "%ZIP_FILE%" >nul 2>nul
exit /b %EXIT_CODE%
