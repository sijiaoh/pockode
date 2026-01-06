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

echo "Done! Run 'pockode -relay -auth-token YOUR_PASSWORD' to get started."
