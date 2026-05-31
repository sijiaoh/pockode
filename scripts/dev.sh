#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Mode selection: single (default) or manager
MODE="${MODE:-single}"
if [ -n "$1" ]; then
    MODE="$1"
fi

export AUTH_TOKEN="${AUTH_TOKEN:-dev-token}"
# Resolve to absolute path (relative paths break when subprocesses cd)
export WORK_DIR="$(cd "${WORK_DIR:-$PROJECT_DIR}" && pwd)"
export SERVER_PORT="${SERVER_PORT:-8080}"
export WEB_PORT="${WEB_PORT:-5173}"
export DEV_MODE="${DEV_MODE:-true}"
export DEBUG="${DEBUG:-true}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"

export RELAY_ENABLED="${RELAY_ENABLED:-false}"
export CLOUD_URL="${CLOUD_URL:-http://local.pockode.com}"
export RELAY_FRONTEND_PORT="${RELAY_FRONTEND_PORT:-$WEB_PORT}"

print_config() {
    echo "Starting dev environment ($1)..."
    echo "  Backend:  http://localhost:$SERVER_PORT"
    echo "  Frontend: http://localhost:$WEB_PORT"
    echo "  Token:    $AUTH_TOKEN"
    echo ""
}

case "$MODE" in
    single)
        print_config "single workspace mode"
        cd "$PROJECT_DIR" && exec pnpm run dev
        ;;
    manager)
        print_config "manager mode"

        (cd "$PROJECT_DIR/server" && go build -o "$PROJECT_DIR/pockode" .)

        # Cleanup function for signal handling
        POCKODE_PID=""
        cleanup() {
            if [ -n "$POCKODE_PID" ]; then
                kill "$POCKODE_PID" 2>/dev/null || true
                wait "$POCKODE_PID" 2>/dev/null || true
            fi
        }
        trap cleanup EXIT INT TERM

        "$PROJECT_DIR/pockode" manager start --port "$SERVER_PORT" --auth-token "$AUTH_TOKEN" &
        POCKODE_PID=$!

        # Wait briefly to check if server started successfully
        sleep 1
        if ! kill -0 "$POCKODE_PID" 2>/dev/null; then
            echo "Error: Failed to start pockode server" >&2
            exit 1
        fi

        cd "$PROJECT_DIR" && pnpm run dev:web
        ;;
    *)
        echo "Usage: $0 [single|manager]"
        echo ""
        echo "Modes:"
        echo "  single   Single workspace mode (default)"
        echo "  manager  Multi-workspace manager mode"
        echo ""
        echo "Or set MODE environment variable:"
        echo "  MODE=manager $0"
        exit 1
        ;;
esac
