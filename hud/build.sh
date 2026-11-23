#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="AntigravityContextHUD"
VERSION="${VERSION:-0.1.0}"
UNIVERSAL="${UNIVERSAL:-0}"
BUILD_DIR="$ROOT/hud/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

rm -rf "$APP_BUNDLE"
mkdir -p "$MACOS_DIR" "$RES_DIR/hud" "$RES_DIR/sidecars/context_panel"

SRC="$ROOT/hud/macos/Sources/main.swift"
FRAMEWORKS=(-framework AppKit -framework SwiftUI -framework Combine)

if [ "$UNIVERSAL" = "1" ]; then
  echo "Compiling $APP_NAME (Universal: arm64 + x86_64, macOS 13.0+)..."
  swiftc -O -target arm64-apple-macosx13.0 "${FRAMEWORKS[@]}" "$SRC" -o "$BUILD_DIR/${APP_NAME}-arm64"
  swiftc -O -target x86_64-apple-macosx13.0 "${FRAMEWORKS[@]}" "$SRC" -o "$BUILD_DIR/${APP_NAME}-x86_64"
  lipo -create "$BUILD_DIR/${APP_NAME}-arm64" "$BUILD_DIR/${APP_NAME}-x86_64" -output "$MACOS_DIR/$APP_NAME"
  rm -f "$BUILD_DIR/${APP_NAME}-arm64" "$BUILD_DIR/${APP_NAME}-x86_64"
else
  echo "Compiling $APP_NAME ($(uname -m), macOS 13.0+)..."
  swiftc -O -target "$(uname -m)-apple-macosx13.0" "${FRAMEWORKS[@]}" "$SRC" -o "$MACOS_DIR/$APP_NAME"
fi

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AntigravityContextHUD</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>dev.agy-context.hud</string>
  <key>CFBundleName</key>
  <string>Antigravity Context HUD</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# Bundle app icon if present
if [ -f "$ROOT/hud/macos/Resources/AppIcon.icns" ]; then
  cp "$ROOT/hud/macos/Resources/AppIcon.icns" "$RES_DIR/AppIcon.icns"
fi

# Bundle bridge.mjs and unmodified upstream analyzer.mjs so the .app is 100% self-contained.
cp "$ROOT/hud/bridge.mjs" "$RES_DIR/hud/bridge.mjs"
cp "$ROOT/sidecars/context_panel/analyzer.mjs" "$RES_DIR/sidecars/context_panel/analyzer.mjs"
chmod +x "$RES_DIR/hud/bridge.mjs"

echo "Built self-contained app: $APP_BUNDLE"
