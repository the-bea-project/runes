#!/bin/sh
# Installs Runes from the unpacked .tar.gz this script came in.
#
#   ./install.sh               for you only: ~/.local/opt/runes, with `runes` in ~/.local/bin
#   sudo ./install.sh          for everyone: /opt/runes, with `runes` in /usr/local/bin
#   ./install.sh --uninstall   (with sudo if it was installed with sudo)
#
# It copies the app, links the `runes` command, and adds a menu entry. Nothing else is touched.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ "$(id -u)" -eq 0 ]; then
  app=/opt/runes; bin=/usr/local/bin; share=/usr/local/share
else
  app="$HOME/.local/opt/runes"; bin="$HOME/.local/bin"; share="${XDG_DATA_HOME:-$HOME/.local/share}"
fi
entry="$share/applications/runes.desktop"
icon="$share/icons/hicolor/512x512/apps/runes.png"

if [ "${1:-}" = "--uninstall" ]; then
  # Only ever a folder this script made: it must hold the Runes program.
  if [ -x "$app/runes" ]; then rm -rf -- "$app"; fi
  if [ "$(readlink -- "$bin/runes" 2>/dev/null || true)" = "$app/runes" ]; then rm -f -- "$bin/runes"; fi
  rm -f -- "$entry" "$icon"
  echo "Runes has been removed. Your settings are still in ~/.config/Runes."
  exit 0
fi

if [ ! -x "$here/runes" ]; then
  echo "Run this from the unpacked Runes folder: the 'runes' program should be next to it." >&2
  exit 1
fi
if [ "$here" = "$app" ]; then
  echo "This folder is already the installed copy." >&2
  exit 1
fi

if [ -e "$app" ] && [ ! -x "$app/runes" ]; then
  echo "$app exists and is not a Runes install; leaving it alone." >&2
  exit 1
fi
mkdir -p -- "$(dirname -- "$app")" "$bin" "$share/applications" "$(dirname -- "$icon")"
rm -rf -- "$app.new"
cp -R -- "$here" "$app.new"
rm -rf -- "$app"
mv -- "$app.new" "$app"
ln -sf -- "$app/runes" "$bin/runes"
if [ -f "$app/resources/icon.png" ]; then cp -- "$app/resources/icon.png" "$icon"; fi

cat > "$entry" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Runes
Comment=A code editor written in Gleam and JS
Exec="$app/runes" %F
Icon=runes
Terminal=false
Categories=Development;TextEditor;IDE;
StartupWMClass=Runes
MimeType=text/plain;inode/directory;
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$share/applications" >/dev/null 2>&1 || true

echo "Runes is installed in $app."
case ":$PATH:" in
  *":$bin:"*) echo "Start it with: runes" ;;
  *) echo "Start it from your applications menu, or add $bin to your PATH to use the 'runes' command." ;;
esac
