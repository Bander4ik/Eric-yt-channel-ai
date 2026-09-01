@echo off
REM Plain setlocal, NOT enabledelayedexpansion: nothing here needs !var!
REM (the triage block uses `if not defined`, which resolves at run time), and
REM delayed expansion would silently eat any "!" in the client's folder path
REM from every message that prints it.
setlocal
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
  echo Please send this file to your developer:  "%LOGFILE%"
  pause
  exit /b 1
)

set "NODE_VERSION="
for /f "tokens=*" %%v in ('node -v 2^>nul') do set "NODE_VERSION=%%v"

REM `where node` above only proves the file exists. A broken install - a
REM missing VC runtime, an antivirus block, a dangling nvm/fnm shim - prints
REM to stderr and produces no stdout, leaving NODE_VERSION empty. Comparing
REM an empty value with LSS is a cmd syntax error, which closes the window
REM instantly and tells the client nothing.
if not defined NODE_VERSION (
  echo [ERROR] Node.js is installed but will not run.
  echo [ERROR] node -v produced no output. >> "%LOGFILE%"
  echo.
  echo Open a command prompt and type:  node -v
  echo Whatever it prints is the real problem. The usual fix is to
  echo reinstall Node.js from https://nodejs.org/ ^(LTS version^).
  echo.
  echo Please send this file to your developer:  "%LOGFILE%"
  pause
  exit /b 1
)

echo Detected Node.js %NODE_VERSION%
echo Detected Node.js %NODE_VERSION% >> "%LOGFILE%"
echo.

set "NODE_MAJOR=%NODE_VERSION:v=%"
for /f "delims=. tokens=1" %%m in ("%NODE_MAJOR%") do set "NODE_MAJOR=%%m"

REM Quote both sides: an unexpected value can never turn this into a
REM syntax error, and a non-numeric one simply fails the comparison.
if not defined NODE_MAJOR set "NODE_MAJOR=0"

if %NODE_MAJOR% LSS 20 (
  echo [ERROR] Node.js %NODE_VERSION% is too old. This app needs Node.js 20 or newer.
  echo [ERROR] Node.js %NODE_VERSION% is too old. Needs 20+. >> "%LOGFILE%"
  echo Please install the latest LTS version from https://nodejs.org/
  echo Then run this script again.
  echo.
  echo Please send this file to your developer:  "%LOGFILE%"
  pause
  exit /b 1
)

REM The database engine ships ready-made builds for Node 20-25 only. On a
REM newer Node it has to be compiled from source instead, which is what
REM turned into a failed install for one client on Node 26 - the log said
REM "compiler" and everybody read it as a missing compiler problem.
if %NODE_MAJOR% GTR 25 (
  echo.
  echo ****************************************************************
  echo  WARNING: Node.js %NODE_VERSION% is newer than this app supports.
  echo ****************************************************************
  echo.
  echo The database engine only ships ready-made builds for Node 20-25.
  echo On Node %NODE_MAJOR% it has to be compiled on your machine, which
  echo usually fails unless you have C++ build tools installed.
  echo.
  echo Recommended: uninstall Node.js, then install the LTS version from
  echo https://nodejs.org/ and run this script again.
  echo.
  echo WARNING: Node %NODE_VERSION% is above the supported range. >> "%LOGFILE%"
  echo Press a key to continue anyway, or close this window to switch Node first.
  pause
)

echo "%CD%" | findstr /I "OneDrive" >nul
if not errorlevel 1 (
  echo.
  echo ****************************************************************
  echo  WARNING: this project sits inside your OneDrive folder.
  echo ****************************************************************
  echo.
  echo OneDrive keeps syncing these files while the installer is still
  echo writing them. That causes "EPERM" errors, half-installed folders,
  echo and strange breakages later on even when the install appears fine.
  echo.
  echo Strongly recommended: move this whole project folder somewhere
  echo outside OneDrive - for example C:\Projects - and run install.bat
  echo again from the new location.
  echo.
  echo Press a key to continue anyway, or close this window to move it first.
  echo "%CD%" >> "%LOGFILE%"
  echo WARNING: project is inside OneDrive. >> "%LOGFILE%"
  pause
)

REM Note for whoever maintains this: the app no longer installs anything for
REM transcripts at this point. It used to pull the `youtube-dl-exec` package,
REM whose install scripts demanded Python and then downloaded a binary through
REM api.github.com - two ways for an OPTIONAL feature to kill the whole
REM install, both of which happened to real clients. That engine is now
REM fetched on first use instead, from inside the running app.

echo Installing dependencies. This takes 2-5 minutes.
echo.
echo IMPORTANT: the screen will stay quiet the whole time - that is normal.
echo Everything is being written to install-log.txt instead.
echo Please do NOT close this window until it says it is finished.
echo.

call npm install >> "%LOGFILE%" 2>&1
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed.
  echo.
  echo Reading the log to work out why...
  echo.

  set "DIAGNOSED="

  findstr /I /C:"needs Python" "%LOGFILE%" >nul
  if not errorlevel 1 (
    set "DIAGNOSED=1"
    echo   CAUSE: something still wants Python during install. Nothing in the
    echo          current version should - you may be on an old copy.
    echo   FIX:   download the latest version of the app, or install Python 3
    echo          from the Microsoft Store ^(search "Python 3.12"^) as a stopgap.
    echo.
  )

  findstr /I /C:"EPERM" "%LOGFILE%" >nul
  if not errorlevel 1 (
    set "DIAGNOSED=1"
    echo   CAUSE: files were locked or moved mid-install - almost always a cloud
    echo          sync service ^(OneDrive, Dropbox, Google Drive^).
    echo   FIX:   move this folder somewhere local like C:\Projects, delete the
    echo          node_modules folder, and run install.bat again.
    echo.
  )

  findstr /I /C:"better_sqlite3" /C:"better-sqlite3" /C:"node-gyp" /C:"MSB" /C:"Visual Studio" "%LOGFILE%" >nul
  if not errorlevel 1 (
    set "DIAGNOSED=1"
    echo   CAUSE: the database engine had to be compiled and Windows has no
    echo          C++ compiler out of the box.
    echo   FIX:   install "Visual Studio Build Tools" and tick "Desktop
    echo          development with C++" during setup:
    echo          https://visualstudio.microsoft.com/visual-cpp-build-tools/
    echo          Then delete the node_modules folder and run install.bat again.
    echo          Installing Python does NOT fix this one.
    echo.
  )

  findstr /I /C:"ETIMEDOUT" /C:"ENOTFOUND" /C:"ECONNRESET" /C:"network" /C:"fetch failed" /C:"UND_ERR" /C:"ConnectTimeout" "%LOGFILE%" >nul
  if not errorlevel 1 (
    set "DIAGNOSED=1"
    echo   CAUSE: the download was interrupted.
    echo   FIX:   check your internet connection and run install.bat again.
    echo.
  )

  if not defined DIAGNOSED (
    echo   The log does not match any cause we have seen before.
    echo   Send install-log.txt to your developer - it has the full details.
    echo.
  )

  echo Please send this file to your developer:  "%LOGFILE%"
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
  echo Note: installing Python will NOT fix this particular error. Python is
  echo only involved in the subtitle downloader, which is a different step.
  echo.
  echo If npm printed a message about install scripts being
  echo "not covered by allowScripts" or "pending approval", try this
  echo instead, from a command prompt in this folder:
  echo   npm approve-scripts --all
  echo   npm rebuild
  echo.
  echo Please send this file to your developer:  "%LOGFILE%"
  pause
  exit /b 1
)

echo.
echo Verifying the app itself is installed...
echo. >> "%LOGFILE%"
echo Verifying the app itself is installed... >> "%LOGFILE%"

if not exist "node_modules\next\dist\bin\next" (
  echo.
  echo ====================================================
  echo  [ERROR] The app engine is missing from node_modules.
  echo ====================================================
  echo.
  echo npm reported success but the "next" command is not there, which
  echo means the install was interrupted or only partly completed.
  echo.
  echo   1. Delete the node_modules folder in this project.
  echo   2. Run install.bat again and let it finish completely.
  echo.
  echo [ERROR] next is missing from node_modules after install. >> "%LOGFILE%"
  echo Please send this file to your developer:  "%LOGFILE%"
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
