#!/bin/bash
set -e

cd "$(dirname "$0")/.."

VERSION=${VERSION:-dev}
VERSION=${VERSION#v}
OUTPUT_DIR=${OUTPUT_DIR:-dist}

# --local builds only the current machine's platform to speed up local dev
LOCAL_ONLY=false
for arg in "$@"; do
    case "$arg" in
        --local)
            LOCAL_ONLY=true
            ;;
        *)
            echo "Unknown option: $arg" >&2
            echo "Usage: $0 [--local]" >&2
            exit 1
            ;;
    esac
done

echo "Building Pockode $VERSION"

# Build main frontend directly to server/static
echo "Building main frontend..."
cd web
pnpm install --frozen-lockfile
pnpm run build:release
cd ..
touch server/static/.keep

# Build cluster frontend directly to server/cluster/static
echo "Building cluster frontend..."
cd web-cluster
pnpm install --frozen-lockfile
pnpm run build:release
cd ..
touch server/cluster/static/.keep

# Cross-compile for multiple platforms, or only the local one with --local
if [ "$LOCAL_ONLY" = true ]; then
    platforms=("$(go env GOOS)/$(go env GOARCH)")
else
    platforms=(
        "darwin/amd64"
        "darwin/arm64"
        "linux/amd64"
        "linux/arm64"
    )
fi

mkdir -p "$OUTPUT_DIR"

for platform in "${platforms[@]}"; do
    os="${platform%/*}"
    arch="${platform#*/}"
    output="$OUTPUT_DIR/pockode-${os}-${arch}"

    echo "Building $output..."
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build \
        -C server \
        -ldflags="-w -s -X main.version=$VERSION" \
        -o "../$output" .
done

echo ""
echo "Build complete! Binaries in $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR"
