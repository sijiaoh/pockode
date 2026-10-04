#!/bin/bash
# Real-browser walkthrough of the chat UI and the answering UI.
# See README.md beside this file for what each command does.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

WALKTHROUGH_DIR="${WALKTHROUGH_DIR:-$PROJECT_DIR/.walkthrough}"
STATE_DIR="$WALKTHROUGH_DIR/state"
SHOTS_DIR="${SHOTS_DIR:-$WALKTHROUGH_DIR/shots}"
PORT="${PORT:-18970}"
PASSWORD="walkthrough"
# Pinned so that every run drives the same browser build.
PLAYWRIGHT_VERSION="${PLAYWRIGHT_VERSION:-1.63.0}"

export WALKTHROUGH_URL="http://localhost:$PORT"
export WALKTHROUGH_PASSWORD="$PASSWORD"
export SHOTS_DIR
export WALKTHROUGH_DATA_DIR="$STATE_DIR/data"

wait_for() {
	local url="$1" name="$2"
	for _ in $(seq 1 120); do
		if curl -sf -o /dev/null "$url"; then return 0; fi
		sleep 0.5
	done
	echo "$name did not come up at $url; see $STATE_DIR/$name.log" >&2
	exit 1
}

up() {
	down quiet
	# Another walkthrough (another worktree's, say) on this port would answer
	# the health check below, and the run would drive a server it never built.
	if curl -sf -o /dev/null "$WALKTHROUGH_URL/health"; then
		echo "Something is already serving $WALKTHROUGH_URL; stop it, or pick another PORT." >&2
		exit 1
	fi
	rm -rf "$STATE_DIR"
	mkdir -p "$STATE_DIR/bin" "$STATE_DIR/data"

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
	(cd "$PROJECT_DIR/server" && go build -o "$STATE_DIR/bin/pockode" .)

	# The project the server opens: a scratch repository, so nothing the agent
	# or the walkthrough does can touch this checkout.
	local work="$STATE_DIR/project"
	mkdir -p "$work"
	git -C "$work" init -q -b main
	echo "# Walkthrough project" >"$work/README.md"
	git -C "$work" add README.md
	git -C "$work" -c user.name=walkthrough -c user.email=walkthrough@example.com commit -qm init

	# The fake CLI goes first on PATH: it is the only `claude` this server sees.
	PATH="$SCRIPT_DIR/fake-cli:$PATH" "$STATE_DIR/bin/pockode" \
		--password "$PASSWORD" --port "$PORT" --work "$work" \
		--data "$STATE_DIR/data" --relay=false --log-level debug \
		>"$STATE_DIR/server.log" 2>&1 &
	echo $! >"$STATE_DIR/server.pid"

	wait_for "$WALKTHROUGH_URL/health" server
	echo "Up: $WALKTHROUGH_URL (password: $PASSWORD)"
}

down() {
	local pidfile="$STATE_DIR/server.pid"
	if [ -f "$pidfile" ]; then
		local pid
		pid="$(cat "$pidfile")"
		kill "$pid" 2>/dev/null || true
		# Until it has let go of the port, which the next `up` checks is free.
		for _ in $(seq 1 40); do
			kill -0 "$pid" 2>/dev/null || break
			sleep 0.25
		done
		rm -f "$pidfile"
	fi
	[ "${1:-}" = quiet ] || echo "Down."
}

ensure_playwright() {
	local dir="$WALKTHROUGH_DIR/node"
	if [ ! -f "$dir/node_modules/playwright-core/package.json" ] ||
		! grep -q "\"version\": \"$PLAYWRIGHT_VERSION\"" "$dir/node_modules/playwright-core/package.json"; then
		mkdir -p "$dir"
		npm install --prefix "$dir" --no-save --no-package-lock --silent "playwright-core@$PLAYWRIGHT_VERSION"
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
	# Always from a fresh server, so every run starts with the same sessions and
	# a desktop sidebar that lists the same rows. The trap goes first: a server
	# that starts and then fails its health check still has to be stopped.
	trap down EXIT
	up
	node "$SCRIPT_DIR/shoot.mjs" "$@"
}

case "${1:-}" in
up) up ;;
down) down ;;
shoot)
	shift
	shoot "$@"
	;;
*)
	echo "usage: $0 {up|down|shoot [--themes=all] [filter...]}" >&2
	echo "  a filter names a suite (chat, question), scene, viewport or theme" >&2
	exit 2
	;;
esac
