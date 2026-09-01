@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed.
  echo Please install Node.js 20+ from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] Dependencies not found. Running installation first...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. Please run install.bat instead - it writes
    echo         a full log and tells you what went wrong.
    pause
    exit /b 1
  )
)

REM Check before launching, not after. A half-finished install used to fail
REM here silently: this window closed instantly while the browser still opened
REM on its own, so the only thing the user saw was "localhost refused to
REM connect" - a symptom that says nothing about the real cause.
if not exist "node_modules\next\dist\bin\next" (
  echo.
  echo ====================================================
  echo  [ERROR] The app is not fully installed.
  echo ====================================================
  echo.
  echo The "next" command is missing from node_modules, which means the
  echo install was interrupted or only partly finished.
  echo.
  echo   1. Delete the node_modules folder in this project.
  echo   2. Double-click install.bat and let it run to the end.
  echo   3. Then run start.bat again.
  echo.
  pause
  exit /b 1
)

node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo.
  echo ====================================================
  echo  [ERROR] The database engine is not working.
  echo ====================================================
  echo.
  echo The app cannot start without it. Run install.bat - it will tell you
  echo exactly what is missing and write install-log.txt for your developer.
  echo.
  pause
  exit /b 1
)

REM Check the port BEFORE starting. Without this, a busy 3000 produces the
REM most confusing failure this app has: Next does not stop, it quietly moves
REM to 3001, while the browser we launch still opens 3000 - so the client
REM either sees "refused to connect" or, worse, a different program that owns
REM 3000 and thinks it is ours.
netstat -ano | findstr /R /C:":3000 .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo ====================================================
  echo  [ERROR] Port 3000 is already in use.
  echo ====================================================
  echo.
  echo Another program on this computer is using the address this app
  echo needs. Most often that is a second copy of this app already
  echo running in another window.
  echo.
  echo   1. Close any other window running this app.
  echo   2. If you cannot find one, restart your computer.
  echo   3. Then run start.bat again.
  echo.
  pause
  exit /b 1
)

echo.
echo ====================================
echo  Starting YouTube Channel AI VIP...
echo  The app will open in your browser.
echo  Close this window to stop the server.
echo ====================================
echo.

REM Wait for the server to actually answer before opening the browser, and
REM give up quietly if it never does. Opening on a fixed delay used to show
REM "localhost refused to connect" whenever the server died during startup,
REM which told the client nothing about the real error printed right here.
REM (Nested `cmd /c "... start \"\" \"...\""` blew up historically with `\\`
REM read as a UNC root, hence PowerShell.)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 750; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://localhost:3000' | Out-Null; Start-Process 'http://localhost:3000'; break } catch { } }"

REM An explicit port, so the address we opened is the address the server is
REM on - `next dev` with no port is free to move elsewhere.
call npm run dev -- -p 3000

REM If we get here the server stopped. When that is a crash rather than the
REM user closing the window, keep the error on screen instead of vanishing.
if errorlevel 1 (
  echo.
  echo ====================================================
  echo  The app stopped with an error.
  echo ====================================================
  echo.
  echo The lines above this box are the reason. Screenshot them and send
  echo them to your developer.
  echo.
  echo If it says "port 3000 is already in use", another program is using
  echo that address - restart your computer and try again.
  echo.
  pause
)
