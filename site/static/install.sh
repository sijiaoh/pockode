#!/bin/sh
set -e

REPO="sijiaoh/pockode"
INSTALL_DIR="/usr/local/bin"
BINARY_NAME="pockode"

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

DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/pockode-$OS-$ARCH"

echo "Downloading Pockode for $OS/$ARCH..."
curl -fsSL "$DOWNLOAD_URL" -o "/tmp/$BINARY_NAME"

echo "Installing to $INSTALL_DIR/$BINARY_NAME..."
sudo mv "/tmp/$BINARY_NAME" "$INSTALL_DIR/$BINARY_NAME"
sudo chmod +x "$INSTALL_DIR/$BINARY_NAME"

echo "Done! Run 'pockode -auth-token YOUR_PASSWORD' to get started."
