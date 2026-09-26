#!/usr/bin/env bash
# Build App Guide.app for this Mac and put it in ~/Applications.
# Ad-hoc signed: Apple Silicon will not run unsigned code, and a Developer ID
# waits until someone other than its owner needs it (decisions.md #108).
set -euo pipefail
cd "$(dirname "$0")/.."
# pnpm can skip Electron's own install step, which downloads its binary.
[ -f node_modules/electron/path.txt ] || node node_modules/electron/install.js
pnpm -s build
rm -rf release
pnpm exec electron-builder --mac dir --config.mac.identity=null >/dev/null
APP="$(find release -maxdepth 2 -name 'App Guide.app' -type d | head -1)"
codesign --force --deep --sign - "$APP"
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/App Guide.app"
cp -R "$APP" "$HOME/Applications/"
# The build copy goes once installed: left here, Spotlight and Launchpad list a
# second "App Guide" beside the real one.
rm -rf release
echo "installed: $HOME/Applications/App Guide.app"
