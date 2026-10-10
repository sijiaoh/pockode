#!/bin/bash
# Runs the Hugo pockode.com is built with, in site/, passing its arguments on.
# CI builds the site that goes live through it, so the version below is the
# one every real build uses; why that matters is in site/README.md#building.
# Raise the version, the checksum and that paragraph together.
#
# Downloads on Linux x86-64 only, the platform CI builds on; elsewhere, run
# your own Hugo at this version or later.
set -euo pipefail

HUGO_VERSION="0.158.0"
# hugo_${HUGO_VERSION}_linux-amd64.tar.gz in that release's checksums.txt.
HUGO_SHA256="d0d8f0735dccef76e900719a70102f269c418e010a02e3e0f9e206a208346e2f"

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BIN_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/pockode/hugo-$HUGO_VERSION"

if [ "$(uname -sm)" != "Linux x86_64" ]; then
	echo "scripts/site/hugo.sh downloads Hugo for Linux x86-64 only, not $(uname -sm); install Hugo v$HUGO_VERSION or later and run it in site/." >&2
	exit 1
fi

# In a subshell so its cleanup trap runs before the exec below, which would
# otherwise replace the shell that holds it.
if [ ! -x "$BIN_DIR/hugo" ]; then (
	# Beside the cache, so the binary lands in it by an atomic rename and a
	# download cut short never leaves a hugo there.
	mkdir -p "$(dirname "$BIN_DIR")"
	work="$(mktemp -d "$BIN_DIR.XXXXXX")"
	trap 'rm -rf "$work"' EXIT
	curl -fsSL --retry 3 -o "$work/hugo.tar.gz" \
		"https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_${HUGO_VERSION}_linux-amd64.tar.gz"
	echo "$HUGO_SHA256  $work/hugo.tar.gz" | sha256sum -c --quiet -
	tar -xzf "$work/hugo.tar.gz" -C "$work" hugo
	mkdir -p "$BIN_DIR"
	mv "$work/hugo" "$BIN_DIR/hugo"
) fi

cd "$PROJECT_DIR/site"
exec "$BIN_DIR/hugo" "$@"
