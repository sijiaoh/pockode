#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Configuration
export AUTH_TOKEN="${AUTH_TOKEN:-dev-token}"
export WORK_DIR="${WORK_DIR:-$PROJECT_DIR}"
export PORT="${PORT:-8080}"
export DEV_MODE="${DEV_MODE:-true}"
export DEBUG="${DEBUG:-true}"
export API_PORT="$PORT"

# Cleanup on exit
cleanup() {
    echo ""
    echo "Stopping services..."
    kill "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
    wait "$SERVER_PID" "$WEB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Install air if not available
if ! command -v air &> /dev/null; then
    echo "Installing air for hot reload..."
    go install github.com/air-verse/air@latest
fi

# Start backend with hot reload
echo "Starting backend (port $PORT, workDir: $WORK_DIR)..."
(cd "$PROJECT_DIR/server" && air) &
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
echo "Development server ready:"
echo "  App:     http://localhost:5173"
echo "  Token:   $AUTH_TOKEN"
echo ""
echo "(Backend running on port $PORT, proxied via Vite)"
echo "Press Ctrl+C to stop."
wait
