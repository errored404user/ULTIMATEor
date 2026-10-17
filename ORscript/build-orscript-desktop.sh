#!/usr/bin/env sh
# Builds ORscript Desktop (Rust) from ORscript/agent on macOS and installs the
# binary as ORscript/bin/or-core. Requires Rust (https://rustup.rs) and the
# Xcode command line tools (xcode-select --install).
# Windows users: run Build-ORscript-Desktop.cmd instead.
#
#   ./build-orscript-desktop.sh                # window + bridge + menu-bar icon
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "ORscript Desktop supports Windows and macOS only (this is $(uname -s))." >&2; exit 1 ;;
esac
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
