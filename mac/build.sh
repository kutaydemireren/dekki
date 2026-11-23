#!/bin/sh
# Builds mac/build/Dekki.app (ad-hoc signed). The repo checkout this script lives in is baked in.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="$HERE/build/Dekki.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/Dekki" "$HERE/main.swift"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf '%s\n' "$REPO" > "$APP/Contents/Resources/repo-path.txt"
cp "$HERE/icon/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
touch "$APP" # nudge Finder/Dock to refresh the cached icon
echo "built: $APP (repo: $REPO)"
