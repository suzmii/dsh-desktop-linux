#!/usr/bin/env bash
# Install the built AppImage into the user's application menu.
#
#   scripts/install-desktop-entry.sh            # install / refresh
#   scripts/install-desktop-entry.sh --remove   # uninstall
#
# Everything stays inside the user's XDG directories; nothing needs root.
#
# The icon is installed as a transparent PNG in every common hicolor size (plus
# pixmaps) and the desktop entry points at the 512 px file by absolute path:
# theme lookups inside a running KDE session can lag behind a fresh install, and
# an absolute path always resolves. The script also refreshes the icon and
# desktop caches of the desktop environments it can find.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
APPS_DIR="$DATA_HOME/applications"
ICON_THEME_DIR="$DATA_HOME/icons/hicolor"
PIXMAP_DIR="$DATA_HOME/pixmaps"
ENTRY="$APPS_DIR/dsh-desktop.desktop"
TARGET_APP="$BIN_HOME/dsh-desktop.AppImage"
ICON_SIZES=(48 64 128 256 512)

refresh_caches() {
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" 2>/dev/null || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$ICON_THEME_DIR" >/dev/null 2>&1 || true
  # KDE caches application and icon lookups in ksycoca; rebuild it so a running
  # session notices the new entry and icon immediately.
  for cache in kbuildsycoca6 kbuildsycoca5; do
    command -v "$cache" >/dev/null 2>&1 && "$cache" --noincremental >/dev/null 2>&1 || true
  done
}

if [[ "${1:-}" == "--remove" ]]; then
  rm -f "$ENTRY" "$TARGET_APP" "$PIXMAP_DIR/dsh-desktop.png"
  for size in "${ICON_SIZES[@]}"; do
    rm -f "$ICON_THEME_DIR/${size}x${size}/apps/dsh-desktop.png"
  done
  refresh_caches
  echo "removed dsh-desktop menu entry, icons, and $TARGET_APP"
  exit 0
fi

# Pick the newest build: version-sort the AppImages and take the last one.
APPIMAGE="$(find "$ROOT/dist" -maxdepth 1 -name 'dsh-desktop-*.AppImage' -print 2>/dev/null | sort -V | tail -1 || true)"
APPIMAGE="${APPIMAGE:-$(find "$ROOT/dist" -maxdepth 1 -name '*.AppImage' -print -quit 2>/dev/null || true)}"
if [[ -z "$APPIMAGE" ]]; then
  echo "error: no AppImage found under $ROOT/dist — run 'npm run dist' first" >&2
  exit 1
fi

mkdir -p "$APPS_DIR" "$BIN_HOME" "$PIXMAP_DIR"
install -m 755 "$APPIMAGE" "$TARGET_APP"

for size in "${ICON_SIZES[@]}"; do
  install -d "$ICON_THEME_DIR/${size}x${size}/apps"
  if [[ "$size" == "512" ]]; then
    install -m 644 "$ROOT/build/icon.png" "$ICON_THEME_DIR/${size}x${size}/apps/dsh-desktop.png"
  else
    # Downscale from the 512 px master so every size carries clean alpha.
    if command -v magick >/dev/null 2>&1; then
      magick "$ROOT/build/icon.png" -resize "${size}x${size}" "$ICON_THEME_DIR/${size}x${size}/apps/dsh-desktop.png"
    else
      install -m 644 "$ROOT/build/icon.png" "$ICON_THEME_DIR/${size}x${size}/apps/dsh-desktop.png"
    fi
  fi
done
install -m 644 "$ROOT/build/icon.png" "$PIXMAP_DIR/dsh-desktop.png"
TARGET_ICON="$ICON_THEME_DIR/512x512/apps/dsh-desktop.png"

cat > "$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=DSH Desktop
Comment=Connect to a running dsh web server
Exec="$TARGET_APP" %U
Icon=$TARGET_ICON
Terminal=false
StartupWMClass=dsh-desktop
Categories=Development;Utility;
Keywords=dsh;deepseek;harness;
EOF

refresh_caches

echo "installed:"
echo "  app:    $TARGET_APP"
echo "  entry:  $ENTRY"
echo "  icons:  $ICON_THEME_DIR/{48,64,128,256,512}x*/apps/dsh-desktop.png + $PIXMAP_DIR/dsh-desktop.png"
echo "启动器中应出现 “DSH Desktop”；若菜单仍旧，注销重登一次即可。"
