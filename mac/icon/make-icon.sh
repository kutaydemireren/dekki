#!/bin/sh
# Regenerates mac/icon/AppIcon.icns and preview.png from render.swift. One command: mac/icon/make-icon.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
swift "$HERE/render.swift" "$TMP"
iconutil -c icns "$TMP/AppIcon.iconset" -o "$HERE/AppIcon.icns"
cp "$TMP/preview.png" "$HERE/preview.png"
cp "$TMP/contact.png" "${CONTACT_OUT:-$HERE/contact.png}"
echo "wrote $HERE/AppIcon.icns, preview.png, contact.png"
