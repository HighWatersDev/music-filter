#!/usr/bin/env bash
# Builds the App Store Xcode project from build/store/safari-extension (run npm run package first).
# Set TEAM_ID to your Apple Developer team ID to sign without picking the team in Xcode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT/build/store/safari-extension"
OUT="$ROOT/build/store/safari"
APP="$OUT/Music Filter"
BUNDLE_ID="io.github.highwatersdev.musicfilter"
VERSION="$(python3 -c "import json; print(json.load(open('$SOURCE/manifest.json'))['version'])")"
BUILD_NUMBER="${BUILD_NUMBER:-1}"
COPYRIGHT="© 2026 Rinat Kirimov"

test -f "$SOURCE/manifest.json" || { echo "run npm run package first"; exit 1; }
test -f "$ROOT/design/out/app-icon-ios-1024.png" || { echo "run node scripts/render-icons.mjs first"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT"
xcrun safari-web-extension-converter "$SOURCE" \
  --project-location "$OUT" \
  --app-name "Music Filter" \
  --bundle-identifier "$BUNDLE_ID" \
  --swift \
  --copy-resources \
  --no-open \
  --no-prompt \
  --force >/dev/null

PBXPROJ="$APP/Music Filter.xcodeproj/project.pbxproj"
sed -i '' \
  -e "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $VERSION;/" \
  -e "s/CURRENT_PROJECT_VERSION = [^;]*;/CURRENT_PROJECT_VERSION = $BUILD_NUMBER;/" \
  -e "s/INFOPLIST_KEY_NSHumanReadableCopyright = [^;]*;/INFOPLIST_KEY_NSHumanReadableCopyright = \"$COPYRIGHT\";/" \
  "$PBXPROJ"
if [ -n "${TEAM_ID:-}" ]; then
  sed -i '' -e "s/\(PRODUCT_BUNDLE_IDENTIFIER = [^;]*;\)/\1\n\t\t\t\tDEVELOPMENT_TEAM = $TEAM_ID;/" "$PBXPROJ"
fi

for plist in "$APP/iOS (App)/Info.plist" "$APP/macOS (App)/Info.plist"; do
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$plist"
  /usr/libexec/PlistBuddy -c "Add :LSApplicationCategoryType string public.app-category.utilities" "$plist"
done

ICONS="$APP/Shared (App)/Assets.xcassets/AppIcon.appiconset"
rm -f "$ICONS"/*.png
cp "$ROOT/design/out/app-icon-ios-1024.png" "$ICONS/ios-1024.png"
for size in 16 32 64 128 256 512 1024; do
  cp "$ROOT/design/out/app-icon-mac-$size.png" "$ICONS/mac-$size.png"
done
cat > "$ICONS/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "ios-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" },
    { "filename" : "mac-16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "mac-32.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "mac-32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "mac-64.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "mac-128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "mac-256.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "mac-256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "mac-512.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "mac-512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "mac-1024.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

cp "$ROOT/design/out/app-icon-mac-256.png" "$APP/Shared (App)/Resources/Icon.png"
cp "$ROOT/design/safari-app/Main.html" "$APP/Shared (App)/Resources/Base.lproj/Main.html"

echo "$APP/Music Filter.xcodeproj (version $VERSION, build $BUILD_NUMBER)"
