#!/bin/bash
# Writes the site's fonts: Geist 400/600/700 and Geist Mono 400 from the
# `geist` package the marketing suite pins, cut down to the characters an
# English page uses. The full files carry Cyrillic, Greek and Vietnamese the
# site never sets, and on a throttled phone link their weight was most of the
# homepage's time to its largest paint. A character outside the subset (say,
# in a release note) is drawn in the fallback face, not as a missing glyph.
#
# Needs npm and uv. Run it after changing the version or the character set.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
FONTS_DIR="$PROJECT_DIR/site/themes/pockode/static/fonts"
GEIST_VERSION="$(sed -n 's/^GEIST_VERSION="\(.*\)"$/\1/p' "$PROJECT_DIR/scripts/ui-walkthrough/run.sh")"
# Empty, npm would quietly pack the latest Geist instead.
: "${GEIST_VERSION:?no GEIST_VERSION=\"…\" line in scripts/ui-walkthrough/run.sh}"
FONTTOOLS_VERSION="4.66.1"

# ASCII and Latin-1, the dashes, quotes, bullets and ellipsis of General
# Punctuation, and the arrows the pages draw (→ ↗).
UNICODES="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-203A,U+2122,U+2190-2199,U+2212"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && npm pack --silent "geist@$GEIST_VERSION" >/dev/null && tar xzf geist-*.tgz)
fonts="$work/package/dist/fonts"

for font in geist-sans/Geist-Regular geist-sans/Geist-SemiBold geist-sans/Geist-Bold geist-mono/GeistMono-Regular; do
	uvx --quiet --from "fonttools[woff]==$FONTTOOLS_VERSION" pyftsubset "$fonts/$font.woff2" \
		--unicodes="$UNICODES" --layout-features='*' --flavor=woff2 \
		--output-file="$FONTS_DIR/$(basename "$font").woff2"
done
cp "$work/package/LICENSE.txt" "$FONTS_DIR/OFL.txt"

ls -l "$FONTS_DIR"
