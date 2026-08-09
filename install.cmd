@echo off
setlocal EnableExtensions
set "TEMP_DIR=%TEMP%\nexara-cli-%RANDOM%%RANDOM%"
set "ZIP_FILE=%TEMP_DIR%.zip"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20+ is required. Install it from https://nodejs.org/ first.
  exit /b 1
)
mkdir "%TEMP_DIR%" >nul 2>nul
curl -fL "https://github.com/K1NGMR/NexaraCLI/archive/refs/heads/main.zip" -o "%ZIP_FILE%"
if errorlevel 1 goto :fail
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%ZIP_FILE%' -DestinationPath '%TEMP_DIR%' -Force"
if errorlevel 1 goto :fail
for /d %%D in ("%TEMP_DIR%\NexaraCLI-*") do set "ROOT=%%D"
if not exist "%ROOT%\package.json" goto :fail
npm install --global "%ROOT%" --no-fund --no-audit --force
if errorlevel 1 goto :fail
echo Installed. Run: nexara
echo Automatic updates are enabled.
goto :cleanup
:fail
echo Nexara CLI installation failed.
set "EXIT_CODE=1"
:cleanup
rmdir /s /q "%TEMP_DIR%" >nul 2>nul
del /q "%ZIP_FILE%" >nul 2>nul
exit /b %EXIT_CODE%
