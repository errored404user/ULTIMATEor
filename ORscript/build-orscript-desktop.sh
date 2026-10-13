#!/usr/bin/env sh
# Builds ORscript Desktop (Rust) from ORscript/agent on macOS / Linux and
# installs the binary as ORscript/bin/or-core. Requires Rust (https://rustup.rs).
#
#   ./build-orscript-desktop.sh                # window + bridge
#   ./build-orscript-desktop.sh --features linux-tray   # Linux: also the tray icon (needs GTK3 + libayatana-appindicator)
#
# Linux build dependencies (Debian/Ubuntu):
#   sudo apt install build-essential pkg-config libssl-dev libxkbcommon-dev libgl1-mesa-dev \
#        libwayland-dev libxcb-render0-dev libxcb-shape0-dev libxcb-xfixes0-dev libfontconfig1-dev
#   # optional tray:  sudo apt install libgtk-3-dev libayatana-appindicator3-dev
# macOS: Xcode command line tools (xcode-select --install).
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/agent"
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. Install Rust from https://rustup.rs (then restart your shell)." >&2
  exit 1
fi
echo "Building ORscript Desktop (release)..."
cargo build --release "$@"
mkdir -p "$here/bin"
cp -f target/release/or-core "$here/bin/or-core"
chmod +x "$here/bin/or-core"
echo
echo "Done: $here/bin/or-core"
echo "Run it to open ORscript Desktop (or with --headless / --hidden)."
