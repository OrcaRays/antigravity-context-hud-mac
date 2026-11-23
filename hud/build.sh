#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="AntigravityContextHUD"
BUILD_DIR="$ROOT/hud/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

mkdir -p "$MACOS_DIR" "$RES_DIR"

echo "Compiling $APP_NAME..."
swiftc \
  -O \
  -framework AppKit \
  -framework SwiftUI \
  -framework Combine \
  "$ROOT/hud/macos/Sources/main.swift" \
  -o "$MACOS_DIR/$APP_NAME"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AntigravityContextHUD</string>
  <key>CFBundleIdentifier</key>
  <string>dev.agy-context.hud</string>
  <key>CFBundleName</key>
  <string>Antigravity Context HUD</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# Store the repo's bridge.mjs absolute path so launching the .app directly finds the upstream analyzer.mjs
printf '%s\n' "$ROOT/hud/bridge.mjs" > "$RES_DIR/bridge-path.txt"

echo "Built: $APP_BUNDLE"
