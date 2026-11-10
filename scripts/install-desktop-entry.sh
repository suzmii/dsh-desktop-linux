#!/usr/bin/env bash
# Install the built AppImage into the user's application menu.
#
#   scripts/install-desktop-entry.sh            # install / refresh
#   scripts/install-desktop-entry.sh --remove   # uninstall
#
# Everything stays inside the user's XDG directories; nothing needs root.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPS_DIR="$DATA_HOME/applications"
ICON_DIR="$DATA_HOME/icons/hicolor/512x512/apps"
ENTRY="$APPS_DIR/dsh-desktop.desktop"
TARGET_ICON="$ICON_DIR/dsh-desktop.png"
TARGET_APP="$BIN_HOME/dsh-desktop.AppImage"

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$ENTRY" "$TARGET_ICON" "$TARGET_APP"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
  echo "removed dsh-desktop menu entry, icon, and $TARGET_APP"
  exit 0
fi

APPIMAGE="$(find "$ROOT/dist" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)"
if [[ -z "$APPIMAGE" ]]; then
  echo "error: no AppImage found under $ROOT/dist — run 'npm run dist' first" >&2
  exit 1
fi

mkdir -p "$APPS_DIR" "$ICON_DIR" "$BIN_HOME"
install -m 755 "$APPIMAGE" "$TARGET_APP"
install -m 644 "$ROOT/build/icon.png" "$TARGET_ICON"

cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DSH Desktop
Comment=Connect to a running dsh web server
Exec="$TARGET_APP" %U
Icon=dsh-desktop
Terminal=false
StartupWMClass=dsh-desktop
Categories=Development;Utility;
Keywords=dsh;deepseek;harness;
EOF

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$DATA_HOME/icons/hicolor" >/dev/null 2>&1 || true

echo "installed:"
echo "  app:    $TARGET_APP"
echo "  entry:  $ENTRY"
echo "  icon:   $TARGET_ICON"
echo "启动器中应出现 “DSH Desktop”。"
