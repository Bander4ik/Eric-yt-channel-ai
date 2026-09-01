#!/bin/bash
set -e
cd "$(dirname "$0")"

DIR="$(pwd)"
LOGFILE="$DIR/install-log.txt"

# Write the log first, but never die on it: a folder we cannot write to is a
# real client situation (running from a mounted disk image, a copy with
# restrictive permissions) and it deserves an explanation, not a raw bash
# error in a window that closes.
# The redirection is inside a subshell: a failing redirect is reported by
# the shell itself before the command runs, so `2>/dev/null` on the bare
# form does not suppress it and the client sees raw bash noise first.
if ! ( : > "$LOGFILE" ) 2>/dev/null; then
  echo
  echo "===================================================="
  echo " [ERROR] This folder is read-only."
  echo "===================================================="
  echo
  echo "The installer cannot write to:"
  echo "  $DIR"
  echo
  echo "If you are running this straight from a downloaded disk image or"
  echo "zip preview, copy the whole folder to your home folder first, then"
  echo "run install.command from there."
  echo
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

echo
echo "===================================="
echo "  YouTube Channel AI VIP - Installation"
echo "===================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed."
  echo "Please install Node.js 20+ from https://nodejs.org/"
  echo "Then run this script again."
  echo
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

NODE_VERSION="$(node -v)"
echo "Detected $NODE_VERSION"
echo "Detected Node.js $NODE_VERSION" >> "$LOGFILE"
echo

NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[ERROR] Node.js $NODE_VERSION is too old. This app needs Node.js 20 or newer."
  echo "Please install the latest LTS version from https://nodejs.org/"
  echo "Then run this script again."
  echo
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

# The database engine ships ready-made builds for Node 20-25 only. Above that
# it has to be compiled locally, which is what turned into a failed install
# for one client on Node 26 - the log said "compiler" and everyone read it as
# a missing compiler rather than as the wrong Node.
if [ "$NODE_MAJOR" -gt 25 ]; then
  echo
  echo "****************************************************************"
  echo " WARNING: Node.js $NODE_VERSION is newer than this app supports."
  echo "****************************************************************"
  echo
  echo "The database engine only ships ready-made builds for Node 20-25."
  echo "On Node $NODE_MAJOR it has to be compiled on your machine, which"
  echo "often fails. Recommended: install the LTS version from"
  echo "https://nodejs.org/ and run this script again."
  echo
  echo "WARNING: Node $NODE_VERSION is above the supported range." >> "$LOGFILE"
  read -n 1 -s -r -p "Press any key to continue anyway, or close this window..." || true
  echo
fi

case "$DIR" in
  *OneDrive*|*"Google Drive"*|*Dropbox*|*"com~apple~CloudDocs"*)
    echo
    echo "****************************************************************"
    echo " WARNING: this project sits inside a synced cloud folder."
    echo "****************************************************************"
    echo
    echo "The sync client keeps touching these files while the installer is"
    echo "still writing them, which causes permission errors and half-installed"
    echo "folders. Move the project somewhere local - for example your home"
    echo "folder - and run install.command again from there."
    echo
    echo "WARNING: project is inside a synced cloud folder: $DIR" >> "$LOGFILE"
    read -n 1 -s -r -p "Press any key to continue anyway, or close this window..." || true
    echo
    ;;
esac

# Note for whoever maintains this: the app no longer installs anything for
# transcripts at this point. It used to pull the `youtube-dl-exec` package,
# whose install scripts demanded Python and then downloaded a binary through
# api.github.com - two ways for an OPTIONAL feature to kill the whole install,
# both of which happened to real clients. That engine is now fetched on first
# use instead, from inside the running app.

echo "Installing dependencies. This takes 2-5 minutes."
echo
echo "IMPORTANT: the screen will stay quiet the whole time - that is normal."
echo "Everything is being written to install-log.txt instead."
echo "Please do NOT close this window until it says it is finished."
echo

# Straight redirection, not `tee` through process substitution: those run
# asynchronously and can lose the last lines of the log exactly when the
# install fails, which is the one moment the log has to be complete.
set +e
npm install >> "$LOGFILE" 2>&1
NPM_STATUS=$?
set -e

if [ "$NPM_STATUS" -ne 0 ]; then
  echo
  echo "[ERROR] npm install failed."
  echo
  echo "Reading the log to work out why..."
  echo
  DIAGNOSED=""

  if grep -qi "needs Python" "$LOGFILE"; then
    DIAGNOSED=1
    echo "  CAUSE: something still wants Python during install. Nothing in the"
    echo "         current version should - you may be on an old copy."
    echo "  FIX:   download the latest version of the app, or run"
    echo "         xcode-select --install  as a stopgap."
    echo
  fi

  if grep -qi "EPERM\|EACCES" "$LOGFILE"; then
    DIAGNOSED=1
    echo "  CAUSE: files were locked or moved mid-install - usually a cloud sync"
    echo "         service, or a permissions problem in this folder."
    echo "  FIX:   move this folder somewhere local (your home folder), delete"
    echo "         node_modules, and run install.command again."
    echo
  fi

  if grep -qi "better.sqlite3\|node-gyp\|clang\|xcrun" "$LOGFILE"; then
    DIAGNOSED=1
    echo "  CAUSE: the database engine had to be compiled and the Apple build"
    echo "         tools are missing."
    echo "  FIX:   run  xcode-select --install  in Terminal, then delete"
    echo "         node_modules and run install.command again."
    echo
  fi

  if grep -qi "ETIMEDOUT\|ENOTFOUND\|ECONNRESET\|fetch failed\|UND_ERR\|ConnectTimeout" "$LOGFILE"; then
    DIAGNOSED=1
    echo "  CAUSE: the download was interrupted."
    echo "  FIX:   check your internet connection and run install.command again."
    echo
  fi

  if [ -z "$DIAGNOSED" ]; then
    echo "  The log does not match any cause we have seen before."
    echo "  Send install-log.txt to your developer - it has the full details."
    echo
  fi

  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

echo
echo "Verifying the database engine built correctly..." | tee -a "$LOGFILE"

set +e
node -e "require('better-sqlite3'); console.log('ok')" >> "$LOGFILE" 2>&1
VERIFY_STATUS=$?
set -e

if [ "$VERIFY_STATUS" -ne 0 ]; then
  echo
  echo "===================================================="
  echo " [ERROR] The database engine did not build correctly."
  echo "===================================================="
  echo
  echo "This app uses a small native database component that must be"
  echo "compiled on your computer. The most common fix is:"
  echo
  echo "  1. Run:  xcode-select --install"
  echo "  2. Delete the node_modules folder in this project."
  echo "  3. Run install.command again."
  echo
  echo "If npm printed a message about install scripts being"
  echo "\"not covered by allowScripts\" or \"pending approval\", try this"
  echo "instead, from a Terminal in this folder:"
  echo "  npm approve-scripts --all"
  echo "  npm rebuild"
  echo
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

echo
echo "Verifying the app itself is installed..." | tee -a "$LOGFILE"

if [ ! -f "node_modules/next/dist/bin/next" ]; then
  echo
  echo "===================================================="
  echo " [ERROR] The app engine is missing from node_modules."
  echo "===================================================="
  echo
  echo "npm reported success but the \"next\" command is not there, which"
  echo "means the install was interrupted or only partly completed."
  echo
  echo "  1. Delete the node_modules folder in this project."
  echo "  2. Run install.command again and let it finish completely."
  echo
  echo "[ERROR] next is missing from node_modules after install." >> "$LOGFILE"
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..." || true
  exit 1
fi

echo
echo "===================================="
echo "  Installation complete!"
echo "  Double-click start.command to launch."
echo "===================================="
echo
read -n 1 -s -r -p "Press any key to close..." || true
exit 0
