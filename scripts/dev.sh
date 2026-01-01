#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
export AUTH_TOKEN="${AUTH_TOKEN:-dev-token}"
export WORK_DIR="${WORK_DIR:-$PROJECT_DIR}"
export PORT="${PORT:-8080}"
export DEV_MODE="${DEV_MODE:-true}"
export DEBUG="${DEBUG:-true}"

# Relay configuration (for local development)
export RELAY_ENABLED="${RELAY_ENABLED:-false}"
export RELAY_CLOUD_URL="${RELAY_CLOUD_URL:-http://local.pockode.com}"

# Cleanup on exit
cleanup() {
    echo ""
    echo "Stopping services..."
    kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
    wait "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start backend
echo "Starting backend (port $PORT, workDir: $WORK_DIR)..."
(cd "$PROJECT_DIR/server" && go run .) &
SERVER_PID=$!

# Wait for backend to be ready
echo "Waiting for backend..."
for _ in {1..30}; do
    if curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
        echo "Backend ready."
        break
    fi
    sleep 0.5
done

# Start frontend
echo "Starting frontend..."
(cd "$PROJECT_DIR/web" && npm run dev) &
WEB_PID=$!

echo ""
echo "Services started:"
echo "  Backend:  http://localhost:$PORT"
echo "  Frontend: http://localhost:5173"
echo "  Token:    $AUTH_TOKEN"
echo ""
echo "Press Ctrl+C to stop."
wait
