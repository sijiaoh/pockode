#!/bin/sh
set -e

REPO="sijiaoh/pockode"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="pockode"

# The documented entry point is `curl ... | sh`, which gives the script no
# arguments unless the user goes out of their way (`sh -s -- ...`). So the same
# choice is available as an environment variable, which is the shorter thing to
# type in front of a pipe. An explicit flag wins over the environment.
VERSION="${POCKODE_VERSION:-latest}"

usage() {
  cat <<'USAGE'
Installs Pockode on macOS and Linux.

Usage:
  curl -fsSL https://pockode.com/install.sh | sh
  curl -fsSL https://pockode.com/install.sh | POCKODE_VERSION=0.12.1 sh
  curl -fsSL https://pockode.com/install.sh | sh -s -- --version 0.12.1

Options:
  --version <version>  Release to install, e.g. v0.12.1, 0.12.1 or latest.
                       Defaults to $POCKODE_VERSION, or the latest release.
  -h, --help           Show this message.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      if [ $# -lt 2 ]; then
        printf '%s\n' "Missing value for $1. Try: --version 0.12.1" >&2
        exit 1
      fi
      # Without this, a forgotten value takes the next option as one and the
      # run ends as a 404 for a release named after that option.
      case "$2" in
        -*)
          printf '%s\n' "Missing value for $1: next came the option $2. Try: --version 0.12.1" >&2
          exit 1 ;;
      esac
      VERSION="$2"
      shift 2 ;;
    --version=*)
      VERSION="${1#--version=}"
      shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *)
      printf '%s\n' "Unknown option: $1" >&2
      echo >&2
      usage >&2
      exit 1 ;;
  esac
done

# The version ends up in a URL, so it is checked here rather than being handed
# to curl as-is: a stray slash or space would silently point the download
# somewhere else entirely.
case "$VERSION" in
  "")
    echo "Version must not be empty. Try: --version 0.12.1, or --version latest" >&2
    exit 1 ;;
  *[!A-Za-z0-9.+_-]*)
    printf '%s\n' "Invalid version: $VERSION" >&2
    echo "Expected a release tag such as v0.12.1, 0.12.1, or latest." >&2
    exit 1 ;;
esac

# Detect OS
OS=$(uname -s)
case "$OS" in
  Linux)  OS="linux" ;;
  Darwin) OS="darwin" ;;
  # Git Bash, MSYS and Cygwin are the shells a Windows user is most likely to try
  # this in. They can run the script but not the binary it installs, so point at
  # the PowerShell installer instead of failing with a raw uname string.
  MINGW*|MSYS*|CYGWIN*)
    echo "This installs the macOS/Linux build. On Windows, run this in PowerShell:"
    echo "  irm https://pockode.com/install.ps1 | iex"
    exit 1 ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

ASSET="pockode-$OS-$ARCH"
if [ "$VERSION" = "latest" ]; then
  DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  # Accept both v0.12.1 and 0.12.1, the way install.ps1 does.
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *)  TAG="v$VERSION" ;;
  esac
  DOWNLOAD_URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"
fi

# The default run cannot name a version - `releases/latest` resolves server
# side - but a run that was given one should say which one it acted on.
if [ "$VERSION" = "latest" ]; then
  echo "Downloading Pockode for $OS/$ARCH..."
else
  echo "Downloading Pockode $TAG for $OS/$ARCH..."
fi

# curl's own message for a missing release is a bare "The requested URL returned
# error: 404", which names neither the version nor the URL it was built from.
CURL_ERROR=$(curl -fsSL "$DOWNLOAD_URL" -o "/tmp/$BINARY_NAME" 2>&1) && CURL_STATUS=0 || CURL_STATUS=$?
if [ "$CURL_STATUS" -ne 0 ]; then
  echo "Download failed: $DOWNLOAD_URL" >&2
  if [ -n "$CURL_ERROR" ]; then
    printf '%s\n' "$CURL_ERROR" >&2
  fi
  # 22 is how curl reports an HTTP error under -f. Usually that is a release or
  # an asset that does not exist, which curl cannot tell the user about.
  if [ "$CURL_STATUS" -eq 22 ]; then
    if [ "$VERSION" = "latest" ]; then
      echo "The latest release may not have a $ASSET asset yet." >&2
    else
      echo "Check that release $TAG exists and has a $ASSET asset: https://github.com/$REPO/releases" >&2
    fi
  fi
  # Last, so that a /tmp left unwritable by someone else cannot make set -e cut
  # the explanation short.
  rm -f "/tmp/$BINARY_NAME"
  exit 1
fi

echo "Installing to $INSTALL_DIR/$BINARY_NAME..."
sudo mv "/tmp/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
sudo chmod +x "$INSTALL_DIR/$BINARY_NAME"

echo "Done! Run 'pockode -auth-token YOUR_PASSWORD' to get started."
