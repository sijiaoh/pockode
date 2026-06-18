#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Parse arguments
CLUSTER_MODE=false
for arg in "$@"; do
    case "$arg" in
        --cluster)
            CLUSTER_MODE=true
            ;;
    esac
done

# Configuration (can be overridden via environment variables for convenience)
AUTH_TOKEN="${AUTH_TOKEN:-dev-token}"
# Resolve to absolute path (relative paths break when subprocesses cd)
WORK_DIR="$(cd "${WORK_DIR:-$PROJECT_DIR}" && pwd)"
LOG_LEVEL="${LOG_LEVEL:-debug}"
CLOUD_URL="${CLOUD_URL:-http://local.pockode.com}"

if [ "$CLUSTER_MODE" = true ]; then
    # Cluster mode configuration
    SERVER_PORT="${SERVER_PORT:-9871}"
    WEB_PORT="${WEB_PORT:-5174}"
    RELAY_FRONTEND_PORT="${RELAY_FRONTEND_PORT:-$WEB_PORT}"
    RELAY_ENABLED="${RELAY_ENABLED:-false}"

    echo "Starting cluster dev environment..."
    echo "  Backend:  http://localhost:$SERVER_PORT"
    echo "  Frontend: http://localhost:$WEB_PORT"
    echo "  Token:    $AUTH_TOKEN"
    echo ""

    # Export port for web dev server
    export WEB_PORT

    cd "$PROJECT_DIR"
    pnpm exec concurrently --kill-others -n server,web -c blue,green \
        "cd server && go run . cluster --auth-token \"$AUTH_TOKEN\" --port $SERVER_PORT --relay=$RELAY_ENABLED --relay-frontend-port $RELAY_FRONTEND_PORT --cloud-url \"$CLOUD_URL\" --dev" \
        "cd web-cluster && pnpm run dev"
else
    # Normal mode configuration
    SERVER_PORT="${SERVER_PORT:-8080}"
    WEB_PORT="${WEB_PORT:-5173}"
    RELAY_FRONTEND_PORT="${RELAY_FRONTEND_PORT:-$WEB_PORT}"
    RELAY_ENABLED="${RELAY_ENABLED:-false}"

    echo "Starting dev environment..."
    echo "  Backend:  http://localhost:$SERVER_PORT"
    echo "  Frontend: http://localhost:$WEB_PORT"
    echo "  Token:    $AUTH_TOKEN"
    echo ""

    # Export port for web dev server
    export WEB_PORT

    cd "$PROJECT_DIR"
    pnpm exec concurrently --kill-others -n server,web -c blue,green \
        "cd server && go run . --auth-token \"$AUTH_TOKEN\" --port $SERVER_PORT --work \"$WORK_DIR\" --relay=$RELAY_ENABLED --relay-frontend-port $RELAY_FRONTEND_PORT --cloud-url \"$CLOUD_URL\" --log-level $LOG_LEVEL --dev" \
        "cd web && pnpm run dev"
fi
