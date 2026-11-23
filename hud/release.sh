#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${VERSION:-0.1.0}"
APP_NAME="AntigravityContextHUD"
BUILD_DIR="$ROOT/hud/build"
APP_BUNDLE="$BUILD_DIR/$APP_NAME.app"
ZIP_PATH="$BUILD_DIR/${APP_NAME}-v${VERSION}-macos-universal.zip"

# 1. Build self-contained Universal binary (arm64 + x86_64)
VERSION="$VERSION" UNIVERSAL=1 "$ROOT/hud/build.sh"

# 2. Resolve Developer ID Application signing identity
SIGN_IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning | grep 'Developer ID Application' | head -n 1 | sed -E 's/.*"([^"]+)".*/\1/' || true)}"
if [ -z "$SIGN_IDENTITY" ]; then
  echo "Error: No 'Developer ID Application' certificate found. Set SIGN_IDENTITY explicitly." >&2
  exit 1
fi

echo "Signing with: $SIGN_IDENTITY"
codesign \
  --force \
  --deep \
  --options runtime \
  --timestamp \
  --sign "$SIGN_IDENTITY" \
  "$APP_BUNDLE"

echo "Verifying code signature..."
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE"

# 3. Package zip for notarization / distribution
rm -f "$ZIP_PATH"
ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"
echo "Packaged: $ZIP_PATH"

# 4. Optional notarization (set NOTARY_PROFILE=<keychain-profile-name>)
if [ -n "${NOTARY_PROFILE:-}" ]; then
  echo "Submitting to Apple notarization service (profile: $NOTARY_PROFILE)..."
  xcrun notarytool submit "$ZIP_PATH" --keychain-profile "$NOTARY_PROFILE" --wait
  echo "Stapling notarization ticket..."
  xcrun stapler staple "$APP_BUNDLE"
  xcrun stapler validate "$APP_BUNDLE"
  rm -f "$ZIP_PATH"
  ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH"
  echo "Notarized & re-packaged: $ZIP_PATH"
else
  echo "Note: NOTARY_PROFILE not set — skipping notarization."
  echo "To notarize, run once: xcrun notarytool store-credentials <profile> --apple-id <id> --team-id <team> --password <app-specific-password>"
  echo "Then re-run: NOTARY_PROFILE=<profile> ./hud/release.sh"
fi

echo "Done! Release artifact: $ZIP_PATH"
ls -lh "$ZIP_PATH"
