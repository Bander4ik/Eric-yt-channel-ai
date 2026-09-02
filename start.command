#!/bin/bash
# Deliberately no `set -e`: this window is the only place a client ever sees
# an error, and an instant silent exit is what made one crash unreadable -
# the browser still opened on its own and all they could report was
# "localhost refused to connect". Every failure below stops and explains.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "Please install Node.js 20+ from https://nodejs.org/"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "[INFO] Dependencies not found. Installing first..."
  if ! npm install; then
    echo
    echo "[ERROR] npm install failed. Please run install.command instead - it"
    echo "        writes a full log and tells you what went wrong."
    read -n 1 -s -r -p "Press any key to exit..." || true
    exit 1
  fi
fi

if [ ! -f "node_modules/next/dist/bin/next" ]; then
  echo
  echo "===================================================="
  echo " [ERROR] The app is not fully installed."
  echo "===================================================="
  echo
  echo "The \"next\" command is missing from node_modules, which means the"
  echo "install was interrupted or only partly finished."
  echo
  echo "  1. Delete the node_modules folder in this project."
  echo "  2. Double-click install.command and let it run to the end."
  echo "  3. Then run start.command again."
  echo
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

if ! node -e "require('better-sqlite3')" >/dev/null 2>&1; then
  echo
  echo "===================================================="
  echo " [ERROR] The database engine is not working."
  echo "===================================================="
  echo
  echo "The app cannot start without it. Run install.command - it will tell"
  echo "you what is missing and write install-log.txt for your developer."
  echo
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

# Which port? Default 3000. A client running another local app on 3000 (our
# own faceless-video generator is the usual one) puts a single number in a
# file called port.txt next to this script - no commands, no editing of
# scripts. The same number drives the busy-port check, the browser and the
# server, so they can never disagree.
PORT=3000
if [ -f "port.txt" ]; then
  CANDIDATE="$(tr -d '[:space:]' < port.txt)"
  case "$CANDIDATE" in
    ''|*[!0-9]*) echo "[WARN] port.txt does not contain a plain number - using 3000." ;;
    *) PORT="$CANDIDATE" ;;
  esac
fi

# Check the port BEFORE starting. Without this, a busy port produces the
# most confusing failure this app has: Next does not stop, it quietly moves
# to 3001, while the browser we launch still opens 3000 - so the client
# either sees "refused to connect" or, worse, a different program that owns
# 3000 and believes it is ours.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo
  echo "===================================================="
  echo " [ERROR] Port $PORT is already in use."
  echo "===================================================="
  echo
  echo "Another program on this Mac is using the address this app needs."
  echo "Most often that is a second copy of this app already running in"
  echo "another Terminal window."
  echo
  echo "  1. Close any other window running this app."
  echo "  2. If it is a DIFFERENT app you need running at the same time,"
  echo "     create a file called port.txt next to start.command containing"
  echo "     just a number, for example 3001, and run start.command again."
  echo "  3. If you cannot find what is using it, restart your Mac."
  echo
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

echo
echo "===================================="
echo "  Starting YouTube Channel AI VIP on port $PORT..."
echo "  The app will open in your browser."
echo "  Close this window to stop the server."
echo "===================================="
echo

# An explicit port, so the address we open is the address the server is on -
# `next dev` with no port is free to move elsewhere.
npm run dev -- -p "$PORT" &
DEV_PID=$!

# Open the browser only once the server actually answers, and only while it
# is still alive. A fixed 5s delay used to fire even when the server had
# already died, so the client's only evidence was "localhost refused to
# connect" — a symptom that says nothing about the error printed right here.
(
  for _ in $(seq 1 40); do
    sleep 0.75
    kill -0 "$DEV_PID" 2>/dev/null || exit 0
    if curl -sf -o /dev/null --max-time 2 "http://localhost:$PORT" 2>/dev/null; then
      if command -v open >/dev/null 2>&1; then
        open "http://localhost:$PORT"
      elif command -v xdg-open >/dev/null 2>&1; then
        xdg-open "http://localhost:$PORT"
      fi
      exit 0
    fi
  done
) &
BROWSER_PID=$!

wait "$DEV_PID"
DEV_STATUS=$?
kill "$BROWSER_PID" 2>/dev/null

if [ "$DEV_STATUS" -ne 0 ]; then
  echo
  echo "===================================================="
  echo " The app stopped with an error."
  echo "===================================================="
  echo
  echo "The lines above this box are the reason. Screenshot them and send"
  echo "them to your developer."
  echo
  echo "If it says the port is already in use, another program is using"
  echo "that address - see port.txt in the instructions, or restart."
  echo
  read -n 1 -s -r -p "Press any key to exit..." || true
fi
