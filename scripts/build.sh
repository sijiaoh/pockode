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

# One workspace, one install: web and web-cluster both resolve @pockode/shared
# through the root lockfile.
echo "Installing frontend dependencies..."
pnpm install --frozen-lockfile

# Build main frontend directly to server/static
echo "Building main frontend..."
pnpm --filter ./web run build:release
touch server/static/.keep

# Build cluster frontend directly to server/cluster/static
echo "Building cluster frontend..."
pnpm --filter ./web-cluster run build:release
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
        "windows/amd64"
    )
fi

mkdir -p "$OUTPUT_DIR"

# go build runs with -C server, so it resolves -o from inside server/. Normalising
# to an absolute path here is what keeps that detail from leaking: prefixing "../"
# only works for a relative OUTPUT_DIR, and for an absolute one it silently writes
# the binaries somewhere else while still reporting success.
OUTPUT_DIR=$(cd "$OUTPUT_DIR" && pwd)

binaries=()
for platform in "${platforms[@]}"; do
    os="${platform%/*}"
    arch="${platform#*/}"
    output="$OUTPUT_DIR/pockode-${os}-${arch}"
    if [ "$os" = "windows" ]; then
        output="$output.exe"
    fi

    echo "Building $output..."
    CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build \
        -C server \
        -ldflags="-w -s -X main.version=$VERSION" \
        -o "$output" .
    binaries+=("${output##*/}")
done

# Releases are built on macOS, which ships shasum instead of sha256sum. Both
# print the same "<hash>  <filename>" line and both accept it back with -c, so
# the file reads the same whichever machine produced it.
if command -v sha256sum >/dev/null 2>&1; then
    sha256=(sha256sum)
else
    sha256=(shasum -a 256)
fi

# Hashed from inside OUTPUT_DIR so the second field is a bare filename: it has
# to match the asset name the install scripts download, and OUTPUT_DIR is an
# absolute path by now. Only this run's binaries are listed, so --local yields a
# one-line file rather than stale entries from an earlier full build.
echo "Writing $OUTPUT_DIR/checksums.txt..."
(cd "$OUTPUT_DIR" && "${sha256[@]}" "${binaries[@]}" > checksums.txt)

echo ""
echo "Build complete! Binaries in $OUTPUT_DIR/"
ls -lh "$OUTPUT_DIR"
