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

REM Which port? Default 3010 - deliberately not 3000, because every client
REM also runs our faceless-video generator and that one lives on 3000. A
REM client who needs yet another port puts a single number
REM in a file called port.txt next to this script - no commands, no editing
REM of scripts. The same number is used for the busy-port check, the browser
REM and the server, so they can never disagree.
set "PORT=3010"
if exist "port.txt" (
  set /p PORT=<"port.txt"
)
REM Strip stray spaces; anything that is not a plain number falls back to 3010.
set "PORT=%PORT: =%"
echo %PORT%| findstr /R /X "[0-9][0-9]*" >nul || (
  echo [WARN] port.txt does not contain a plain number - using 3010.
  set "PORT=3010"
)

REM Check the port BEFORE starting. Without this, a busy port produces the
REM most confusing failure this app has: Next does not stop, it quietly moves
REM to the next free one, while the browser we launch still opens ours - so the client
REM either sees "refused to connect" or, worse, a different program that owns
REM that port and thinks it is ours.
netstat -ano | findstr /R /C:":%PORT% .*LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo.
  echo ====================================================
  echo  [ERROR] Port %PORT% is already in use.
  echo ====================================================
  echo.
  echo Another program on this computer is using the address this app
  echo needs. Most often that is a second copy of this app already
  echo running in another window.
  echo.
  echo   1. Close any other window running this app.
  echo   2. If it is a DIFFERENT app you need running at the same time,
  echo      create a file called port.txt next to start.bat containing
  echo      just a number, for example 3001, and run start.bat again.
  echo   3. If you cannot find what is using it, restart your computer.
  echo.
  pause
  exit /b 1
)

echo.
echo ====================================
echo  Starting YouTube Channel AI VIP on port %PORT%...
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
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 750; try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://localhost:%PORT%' | Out-Null; Start-Process 'http://localhost:%PORT%'; break } catch { } }"

REM An explicit port, so the address we opened is the address the server is
REM on - `next dev` with no port is free to move elsewhere.
call npm run dev -- -p %PORT%

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
  echo If it says the port is already in use, another program is using
  echo that address - see port.txt in the instructions, or restart.
  echo.
  pause
)
