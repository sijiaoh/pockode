#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
export AUTH_TOKEN="${AUTH_TOKEN:-dev-token}"
# Resolve to absolute path (relative paths break when subprocesses cd)
export WORK_DIR="$(cd "${WORK_DIR:-$PROJECT_DIR}" && pwd)"
export SERVER_PORT="${SERVER_PORT:-8080}"
export WEB_PORT="${WEB_PORT:-5173}"
export DEV_MODE="${DEV_MODE:-true}"
export DEBUG="${DEBUG:-true}"
export LOG_LEVEL="${LOG_LEVEL:-debug}"

# Relay configuration (for local development)
export RELAY_ENABLED="${RELAY_ENABLED:-false}"
export CLOUD_URL="${CLOUD_URL:-http://local.pockode.com}"
export RELAY_FRONTEND_PORT="${RELAY_FRONTEND_PORT:-$WEB_PORT}"

echo "Starting dev environment..."
echo "  Backend:  http://localhost:$SERVER_PORT"
echo "  Frontend: http://localhost:$WEB_PORT"
echo "  Token:    $AUTH_TOKEN"
echo ""

cd "$PROJECT_DIR" && pnpm run dev
