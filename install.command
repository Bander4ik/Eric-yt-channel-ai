#!/bin/bash
set -e
cd "$(dirname "$0")"

DIR="$(pwd)"
LOGFILE="$DIR/install-log.txt"
: > "$LOGFILE"

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
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

NODE_VERSION="$(node -v)"
echo "Detected $NODE_VERSION"
echo

NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[ERROR] Node.js $NODE_VERSION is too old. This app needs Node.js 20 or newer."
  echo "Please install the latest LTS version from https://nodejs.org/"
  echo "Then run this script again."
  echo
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

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
  echo "[ERROR] npm install failed. See install-log.txt for full details."
  echo
  echo "Common fixes:"
  echo "  - Delete the node_modules folder and re-run this script"
  echo "  - Make sure you have a stable internet connection"
  echo "  - On older macOS, you may need Xcode Command Line Tools:"
  echo "      xcode-select --install"
  echo
  echo "Please send this file to your developer:  $LOGFILE"
  read -n 1 -s -r -p "Press any key to exit..."
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
  read -n 1 -s -r -p "Press any key to exit..."
  exit 1
fi

echo
echo "===================================="
echo "  Installation complete!"
echo "  Double-click start.command to launch."
echo "===================================="
echo
read -n 1 -s -r -p "Press any key to close..."
