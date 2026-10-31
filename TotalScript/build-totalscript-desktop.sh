#!/usr/bin/env sh
# Builds TotalScript Desktop (Rust) from TotalScript/agent on macOS and installs the
# binary as TotalScript/bin/total-core. Requires Rust (https://rustup.rs) and the
# Xcode command line tools (xcode-select --install).
# Windows users: run Build-TotalScript-Desktop.cmd instead.
#
#   ./build-totalscript-desktop.sh                # window + bridge + menu-bar icon
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "TotalScript Desktop supports Windows and macOS only (this is $(uname -s))." >&2; exit 1 ;;
esac
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/agent"
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo was not found. Install Rust from https://rustup.rs (then restart your shell)." >&2
  exit 1
fi
echo "Building TotalScript Desktop (release)..."
cargo build --release "$@"
mkdir -p "$here/bin"
cp -f target/release/total-core "$here/bin/total-core"
chmod +x "$here/bin/total-core"
echo
echo "Done: $here/bin/total-core"
echo "Run it to open TotalScript Desktop (or with --headless / --hidden)."
