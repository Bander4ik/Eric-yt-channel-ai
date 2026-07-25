@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "LOGFILE=%~dp0install-log.txt"

echo. > "%LOGFILE%"

echo. >> "%LOGFILE%"
echo ==================================== >> "%LOGFILE%"
echo  YouTube Channel AI VIP - Installation >> "%LOGFILE%"
echo ==================================== >> "%LOGFILE%"
echo. >> "%LOGFILE%"

echo.
echo ====================================
echo  YouTube Channel AI VIP - Installation
echo ====================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo [ERROR] Node.js is not installed. >> "%LOGFILE%"
  echo Please install Node.js 20+ from https://nodejs.org/
  echo Then run this script again.
  echo.
  echo Please send this file to your developer:  %LOGFILE%
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo Detected Node.js %NODE_VERSION%
echo Detected Node.js %NODE_VERSION% >> "%LOGFILE%"
echo.

set "NODE_MAJOR=%NODE_VERSION:v=%"
for /f "delims=. tokens=1" %%m in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%m"

if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js %NODE_VERSION% is too old. This app needs Node.js 20 or newer.
  echo [ERROR] Node.js %NODE_VERSION% is too old. Needs 20+. >> "%LOGFILE%"
  echo Please install the latest LTS version from https://nodejs.org/
  echo Then run this script again.
  echo.
  echo Please send this file to your developer:  %LOGFILE%
  pause
  exit /b 1
)

echo Installing dependencies. This takes 2-5 minutes.
echo.
echo IMPORTANT: the screen will stay quiet the whole time - that is normal.
echo Everything is being written to install-log.txt instead.
echo Please do NOT close this window until it says it is finished.
echo.

call npm install >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. See install-log.txt for full details.
  echo.
  echo The most likely cause is a missing C++ compiler. This app uses a
  echo small database component that Windows has to build, and Windows
  echo does not ship with the tool that builds it.
  echo.
  echo Fixes, in the order worth trying:
  echo   1. Send install-log.txt to your developer - it says exactly
  echo      what went wrong, and takes the guesswork out of this.
  echo   2. Install "Visual Studio Build Tools" and tick the
  echo      "Desktop development with C++" box during setup:
  echo      https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo      Then delete the node_modules folder and run install.bat again.
  echo   3. Check that your internet connection is stable.
  echo   4. Only if the log mentions Python: install Python 3 from the
  echo      Microsoft Store. Python alone rarely fixes this.
  echo.
  echo Please send this file to your developer:  %LOGFILE%
  pause
  exit /b 1
)

echo.
echo Verifying the database engine built correctly...
echo. >> "%LOGFILE%"
echo Verifying the database engine built correctly... >> "%LOGFILE%"

node -e "require('better-sqlite3'); console.log('ok')" >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo.
  echo ====================================================
  echo  [ERROR] The database engine did not build correctly.
  echo ====================================================
  echo.
  echo This app uses a small native database component that must be
  echo compiled on your computer. The most common fix is:
  echo.
  echo   1. Install "Visual Studio Build Tools" with the
  echo      "Desktop development with C++" workload from:
  echo      https://visualstudio.microsoft.com/visual-cpp-build-tools/
  echo   2. Delete the node_modules folder in this project.
  echo   3. Run install.bat again.
  echo.
  echo Note: installing Python alone will NOT fix this. Python is only a
  echo secondary possibility, not the main cause.
  echo.
  echo If npm printed a message about install scripts being
  echo "not covered by allowScripts" or "pending approval", try this
  echo instead, from a command prompt in this folder:
  echo   npm approve-scripts --all
  echo   npm rebuild
  echo.
  echo Please send this file to your developer:  %LOGFILE%
  pause
  exit /b 1
)

echo.
echo ====================================
echo  Installation complete!
echo  Run start.bat to launch the app.
echo ====================================
echo.
pause
