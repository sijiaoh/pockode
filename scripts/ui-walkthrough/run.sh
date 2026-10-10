#!/bin/bash
# Real-browser walkthrough of the chat UI and the answering UI.
# See README.md beside this file for what each command does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

WALKTHROUGH_DIR="${WALKTHROUGH_DIR:-$PROJECT_DIR/.walkthrough}"
SERVER_BIN="$WALKTHROUGH_DIR/bin/pockode"
PIDFILE="$WALKTHROUGH_DIR/server.pid"
SHOTS_DIR="${SHOTS_DIR:-$WALKTHROUGH_DIR/shots}"
# Where `stills` writes the finished marketing images, laid out as
# site/static/marketing is (docs/marketing-assets.md §9).
ASSETS_DIR="${ASSETS_DIR:-$WALKTHROUGH_DIR/assets}"
# What `assets --confirm` could not confirm, one path under ASSETS_DIR a line.
UNCONFIRMED="$WALKTHROUGH_DIR/assets-unconfirmed.txt"
PORT="${PORT:-18970}"
# A suite's dev server (devserver.mjs beside its scenes), the page its Port
# Preview shows. Not 5173, where the developer's own Vite most likely is: the
# page is captured from here directly, so no shot shows which port it is on.
DEV_SERVER_PORT="${DEV_SERVER_PORT:-18973}"
DEV_PIDFILE="$WALKTHROUGH_DIR/devserver.pid"
PASSWORD="walkthrough"
# Pinned so that every run drives the same browser build, and draws the
# marketing captures in the same Geist (docs/marketing-assets.md §1.3).
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.63.0}"
GEIST_VERSION="1.7.2"
# The ffmpeg the demo video is encoded with (docs/marketing-assets.md §4.6):
# this release of the package fetches one fixed static build (7.0.2), and the
# same build on the same frames writes the same bytes.
FFMPEG_STATIC_VERSION="5.3.0"
# The one "now" a run may show (docs/marketing-assets.md §1.4): every commit is
# dated from it — the seeded history before it, one made through the Git panel
# at it — so a commit has the same hash every run, and a suite that pins the
# page's clock pins it here.
WALKTHROUGH_CLOCK="2026-05-12T10:24:00Z"

export WALKTHROUGH_URL="http://localhost:$PORT"
export WALKTHROUGH_PASSWORD="$PASSWORD"
export WALKTHROUGH_DEV_SERVER_PORT="$DEV_SERVER_PORT"
export WALKTHROUGH_CLOCK
export SHOTS_DIR ASSETS_DIR

wait_for() {
	local what="$1" url="$2" log="$3"
	for _ in $(seq 1 120); do
		if curl -sf -o /dev/null "$url"; then return 0; fi
		sleep 0.5
	done
	echo "$what did not come up at $url; see $log" >&2
	exit 1
}

build() {
	if [ ! -d "$PROJECT_DIR/web/node_modules" ]; then
		(cd "$PROJECT_DIR" && pnpm install --frozen-lockfile)
	fi

	# The production build, embedded and served by the server itself: what a
	# user runs, and a fresh browser context loads it in well under a second,
	# where vite's dev server takes half a minute to hand over its modules.
	# server/static is the build's usual (gitignored) destination.
	echo "Building web and server..."
	(cd "$PROJECT_DIR/web" && pnpm exec vite build --outDir ../server/static --emptyOutDir --logLevel warn)
	# Emptying the directory took the tracked placeholder with it.
	touch "$PROJECT_DIR/server/static/.keep"
	(cd "$PROJECT_DIR/server" && go build -o "$SERVER_BIN" .)
}

# Starts a fresh server on the project a suite names (seed.mjs), with nothing
# else in it: state from an earlier suite or run never shows in this one.
# A name that is not a suite would seed the default project without a word,
# and becomes a path under start's rm -rf.
check_suite() {
	if [[ ! "$1" =~ ^[a-z-]+$ ]] || { [ "$1" != default ] && [ ! -f "$SCRIPT_DIR/$1/scenes.mjs" ]; }; then
		echo "No suite named '$1': a suite is a directory beside run.sh with a scenes.mjs." >&2
		exit 2
	fi
}

start() {
	local suite="$1"
	check_suite "$suite"
	down quiet
	# Another walkthrough (another worktree's, say) on this port would answer
	# the health check below, and the run would drive a server it never built.
	if curl -sf -o /dev/null "$WALKTHROUGH_URL/health"; then
		echo "Something is already serving $WALKTHROUGH_URL; stop it, or pick another PORT." >&2
		exit 1
	fi
	local devserver="$SCRIPT_DIR/$suite/devserver.mjs"
	if [ -f "$devserver" ] && curl -s -o /dev/null "http://localhost:$DEV_SERVER_PORT/"; then
		echo "Something is already serving localhost:$DEV_SERVER_PORT; stop it, or pick another DEV_SERVER_PORT." >&2
		exit 1
	fi
	local state="$WALKTHROUGH_DIR/state/$suite"
	rm -rf "$state"
	mkdir -p "$state/data"
	export WALKTHROUGH_DATA_DIR="$state/data"

	# Neither the seeded history nor a commit made in the panel may depend on
	# who runs this: a global commit.gpgsign or hooksPath, or an identity in the
	# environment, would change every hash. Exported, so both the seed and the
	# server's git see only the repository's own config.
	export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
	unset GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL

	# The project the server opens: a scratch repository, so nothing the agent
	# or the walkthrough does can touch this checkout.
	WALKTHROUGH_PROJECT_DIR="$(node "$SCRIPT_DIR/seed.mjs" "$suite" "$state")"
	export WALKTHROUGH_PROJECT_DIR

	# The fake CLI goes first on PATH: it is the only `claude` this server sees.
	PATH="$SCRIPT_DIR/fake-cli:$PATH" \
		GIT_AUTHOR_DATE="$WALKTHROUGH_CLOCK" GIT_COMMITTER_DATE="$WALKTHROUGH_CLOCK" \
		"$SERVER_BIN" \
		--password "$PASSWORD" --port "$PORT" --work "$WALKTHROUGH_PROJECT_DIR" \
		--data "$state/data" --relay=false --log-level debug \
		>"$state/server.log" 2>&1 &
	echo $! >"$PIDFILE"

	wait_for "The server" "$WALKTHROUGH_URL/health" "$state/server.log"

	if [ -f "$devserver" ]; then
		# In the project, as the user would have started it.
		(cd "$WALKTHROUGH_PROJECT_DIR" && exec node "$devserver") \
			>"$state/devserver.log" 2>&1 &
		echo $! >"$DEV_PIDFILE"
		wait_for "The dev server" "http://localhost:$DEV_SERVER_PORT/" "$state/devserver.log"
	fi
}

up() {
	check_suite "${1:-default}"
	build
	start "${1:-default}"
	echo "Up: $WALKTHROUGH_URL (password: $PASSWORD)"
}

down() {
	# The second is where the pidfile was before each suite got a server of its
	# own, so a server started by an older checkout can still be stopped.
	# TODO: Drop it once no walkthrough from before per-suite servers is running.
	local pidfile pid
	for pidfile in "$PIDFILE" "$DEV_PIDFILE" "$WALKTHROUGH_DIR/state/server.pid"; do
		[ -f "$pidfile" ] || continue
		pid="$(cat "$pidfile")"
		kill "$pid" 2>/dev/null || true
		# Until it has let go of the port, which the next start checks is free.
		for _ in $(seq 1 40); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.25
		done
		kill -9 "$pid" 2>/dev/null || true
		rm -f "$pidfile"
	done
	[ "${1:-}" = quiet ] || echo "Down."
}

ensure_playwright() {
	local dir="$WALKTHROUGH_DIR/node"
	if ! grep -qs "\"version\": \"$PLAYWRIGHT_VERSION\"" "$dir/node_modules/playwright-core/package.json" ||
		! grep -qs "\"version\": \"$GEIST_VERSION\"" "$dir/node_modules/geist/package.json"; then
		mkdir -p "$dir"
		npm install --prefix "$dir" --no-save --no-package-lock --silent \
			"playwright-core@$PLAYWRIGHT_VERSION" "geist@$GEIST_VERSION"
	fi
	export WALKTHROUGH_NODE_MODULES="$dir/node_modules"

	# The headless shell this playwright-core release drives: installed if the
	# cache lacks it (a no-op otherwise), and found by the revision it names.
	"$dir/node_modules/.bin/playwright-core" install chromium-headless-shell
	local revision shell
	revision="$(node -e 'const b = require(process.argv[1]).browsers.find((b) => b.name === "chromium-headless-shell"); console.log(b.revision)' \
		"$dir/node_modules/playwright-core/browsers.json")"
	shell="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}/chromium_headless_shell-$revision/chrome-headless-shell-linux64/chrome-headless-shell"

	# It also needs a few desktop libraries a server install lacks. Rather than
	# asking for root, the Ubuntu 24.04 packages that carry them are unpacked
	# here and put on the browser's library path.
	local libroot="$WALKTHROUGH_DIR/libroot"
	export LD_LIBRARY_PATH="$libroot/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
	if ldd "$shell" | grep -q "not found"; then
		local debs="$WALKTHROUGH_DIR/debs"
		mkdir -p "$debs" "$libroot"
		(cd "$debs" && apt-get download -q \
			libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libxdamage1)
		for deb in "$debs"/*.deb; do dpkg -x "$deb" "$libroot"; done
		if ldd "$shell" | grep "not found"; then
			echo "The headless browser still has missing libraries (above)." >&2
			exit 1
		fi
	fi
}

shoot() {
	ensure_playwright
	local suites
	suites="$(node "$SCRIPT_DIR/shoot.mjs" --suites "$@")" || exit $?
	build
	# Each suite on a fresh server of its own, so every run starts with the same
	# sessions and a desktop sidebar that lists the same rows. The trap goes
	# first: a server that starts and then fails its health check still has to
	# be stopped.
	trap down EXIT
	local suite status=0
	for suite in $suites; do
		start "$suite"
		node "$SCRIPT_DIR/shoot.mjs" --suite="$suite" "$@" || status=1
	done
	return "$status"
}

# The framed screenshots, social image and architecture figure, from the
# captures an earlier `shoot marketing` left: no server, no build.
stills() {
	ensure_playwright
	node "$SCRIPT_DIR/marketing/stills/render.mjs"
}

ensure_ffmpeg() {
	local dir="$WALKTHROUGH_DIR/ffmpeg"
	# The binary as well as the version: its install script is what fetches it,
	# and one that was skipped (ignore-scripts) or cut short leaves none.
	if ! grep -qs "\"version\": \"$FFMPEG_STATIC_VERSION\"" "$dir/node_modules/ffmpeg-static/package.json" ||
		[ ! -x "$dir/node_modules/ffmpeg-static/ffmpeg" ]; then
		mkdir -p "$dir"
		npm install --prefix "$dir" --no-save --no-package-lock --silent \
			"ffmpeg-static@$FFMPEG_STATIC_VERSION"
	fi
	export WALKTHROUGH_FFMPEG="$dir/node_modules/ffmpeg-static/ffmpeg"
	if [ ! -x "$WALKTHROUGH_FFMPEG" ]; then
		echo "ffmpeg-static installed no ffmpeg at $WALKTHROUGH_FFMPEG (are npm install scripts disabled?)" >&2
		exit 1
	fi
}

# The demo video and its GIF, from the captures an earlier `shoot marketing`
# left: no server, no web build. The terminal in its first shot is pockode's
# own banner, printed by the server's code under a pseudo-terminal (`script`).
video() {
	ensure_playwright
	ensure_ffmpeg
	node "$SCRIPT_DIR/marketing/video/render.mjs"
}

# Every finished marketing asset, rendered from fresh captures into $1.
render_assets() (
	export ASSETS_DIR="$1"
	rm -rf "$ASSETS_DIR"
	shoot marketing
	stills
	video
)

# The committed copy (docs/marketing-assets.md §9), replaced only once a whole
# render has succeeded, so a failed run leaves it as it was. Whatever the
# render no longer writes is gone from it too.
#
# --confirm is for a run nobody looks at before it becomes a pull request (the
# Marketing assets workflow): a capture that differs only by glyph
# antialiasing noise would still become one. So when anything changed, the
# whole render runs again, and a file is updated only where both runs agree;
# one that came out differently each time keeps its committed bytes and is
# listed in $UNCONFIRMED, to be looked into.
assets() {
	local confirm=
	case "${1:-}" in
	"") ;;
	--confirm) confirm=1 ;;
	*)
		echo "usage: $0 assets [--confirm]" >&2
		exit 2
		;;
	esac
	local out="$PROJECT_DIR/site/static/marketing"
	local first="$WALKTHROUGH_DIR/assets-first" second="$WALKTHROUGH_DIR/assets-second"
	rm -f "$UNCONFIRMED"
	render_assets "$first"
	mkdir -p "$out"

	if [ -n "$confirm" ] && ! diff -rq "$out" "$first" >/dev/null; then
		echo "Assets changed; rendering again to confirm..."
		render_assets "$second"
		local file
		while IFS= read -r file; do
			cmp -s "$out/$file" "$first/$file" && continue
			# Both absent counts as agreeing: a file both runs dropped.
			if cmp -s "$first/$file" "$second/$file" ||
				{ [ ! -e "$first/$file" ] && [ ! -e "$second/$file" ]; }; then
				continue
			fi
			echo "Not confirmed (the two renders differ), keeping the committed copy: $file" >&2
			echo "${file#./}" >>"$UNCONFIRMED"
			rm -f "$first/$file"
			if [ -e "$out/$file" ]; then
				mkdir -p "$(dirname "$first/$file")"
				cp "$out/$file" "$first/$file"
			fi
		done < <({ (cd "$out" && find . -type f) && (cd "$first" && find . -type f); } | sort -u)
		[ ! -s "$UNCONFIRMED" ] || echo "Some assets did not render the same twice; listed in $UNCONFIRMED." >&2
	fi

	rm -rf "$out"
	mv "$first" "$out"
	rm -rf "$second"
	echo "Assets in $out"
}

case "${1:-}" in
up) up "${2:-}" ;;
stills) stills ;;
video) video ;;
assets) assets "${2:-}" ;;
down) down ;;
shoot)
	shift
	shoot "$@"
	;;
*)
	echo "usage: $0 {up [suite]|down|shoot [--themes=all] [filter...]|stills|video|assets [--confirm]}" >&2
	echo "  a filter names a suite (chat, question, marketing — run only when named), scene, viewport or theme" >&2
	exit 2
	;;
esac
