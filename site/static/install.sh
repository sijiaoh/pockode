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
    echo "This installs the macOS/Linux build. On Windows, run this in PowerShell:" >&2
    echo "  irm https://pockode.com/install.ps1 | iex" >&2
    exit 1 ;;
  *)      echo "Unsupported OS: $OS" >&2; exit 1 ;;
esac

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  arm64)   ARCH="arm64" ;;
  *)       echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

ASSET="pockode-$OS-$ARCH"
if [ "$VERSION" = "latest" ]; then
  RELEASE_URL="https://github.com/$REPO/releases/latest/download"
else
  # Accept both v0.12.1 and 0.12.1, the way install.ps1 does.
  case "$VERSION" in
    v*) TAG="$VERSION" ;;
    *)  TAG="v$VERSION" ;;
  esac
  RELEASE_URL="https://github.com/$REPO/releases/download/$TAG"
fi
DOWNLOAD_URL="$RELEASE_URL/$ASSET"
# The checksums come from the same release the binary did. For a named tag that
# is exact. For `latest` it is two independent requests, and a release published
# between them pairs the binary fetched first with the checksums of the release
# that replaced it: the download would be rejected even though nothing is wrong
# with it. Resolving `latest` to
# a tag first would close that window, but only by making every install depend
# on the shape of GitHub's redirect for a race measured in seconds against a
# release cadence measured in days. The mismatch message says so instead, and a
# second run then succeeds - where a real mismatch would not.
CHECKSUMS_URL="$RELEASE_URL/checksums.txt"

# Chosen before anything is downloaded: a machine that cannot verify must not
# install, so there is nothing to be gained by fetching first. Which of the two
# exists is a platform difference, the same one scripts/build.sh writes the file
# around - macOS ships shasum, Linux and busybox ship sha256sum - and both print
# the hash as the first field.
if command -v sha256sum > /dev/null 2>&1; then
  SHA256="sha256sum"
elif command -v shasum > /dev/null 2>&1; then
  SHA256="shasum -a 256"
else
  echo "Cannot verify the download: neither sha256sum nor shasum is installed." >&2
  echo "That is this machine missing a tool, not a problem with the download." >&2
  echo "Install either one (coreutils, or perl) and run this again." >&2
  exit 1
fi

# The default run cannot name a version - `releases/latest` resolves server
# side - but a run that was given one should say which one it acted on.
if [ "$VERSION" = "latest" ]; then
  echo "Downloading Pockode for $OS/$ARCH..."
else
  echo "Downloading Pockode $TAG for $OS/$ARCH..."
fi

# The download lands in a directory only this run can write to. A fixed name
# under /tmp is a path anyone on the machine can create - or symlink - first,
# and the install would then hand root whatever they left there.
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pockode-install.XXXXXX")
TMP_BINARY="$TMP_DIR/$BINARY_NAME"
TMP_CHECKSUMS="$TMP_DIR/checksums.txt"
# Set once there is a staged file to remove, which is also what tells cleanup
# whether it has to reach for sudo at all.
STAGED=""

# Cleanup runs from a trap, which is after the failure messages below rather
# than between them: a removal that fails itself cannot make set -e cut the
# explanation short. It also covers an interrupted download, which no amount of
# error handling on the curl call would.
cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" || :
    TMP_DIR=""
  fi
  # A run that failed before staging anything must not ask for a password just
  # to clean up.
  if [ -n "$STAGED" ]; then
    sudo rm -f "$STAGED" || :
    STAGED=""
  fi
}
trap cleanup EXIT
# A signal does not run the EXIT trap on its own, and 128+signal is the status a
# shell killed by one would have reported.
trap 'cleanup; exit 129' HUP
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# curl's own message for a missing release is a bare "The requested URL returned
# error: 404", which names neither the version nor the URL it was built from.
# The caller adds whatever it can say about that particular URL.
download() {
  DOWNLOAD_ERROR=$(curl -fsSL "$1" -o "$2" 2>&1) && DOWNLOAD_STATUS=0 || DOWNLOAD_STATUS=$?
  if [ "$DOWNLOAD_STATUS" -ne 0 ]; then
    echo "Download failed: $1" >&2
    if [ -n "$DOWNLOAD_ERROR" ]; then
      printf '%s\n' "$DOWNLOAD_ERROR" >&2
    fi
  fi
  return "$DOWNLOAD_STATUS"
}

# The binary first: a run that cannot even reach its asset should say so in
# terms of that asset, not of a checksums file the user never asked for.
if ! download "$DOWNLOAD_URL" "$TMP_BINARY"; then
  # 22 is how curl reports an HTTP error under -f. Usually that is a release or
  # an asset that does not exist, which curl cannot tell the user about.
  if [ "$DOWNLOAD_STATUS" -eq 22 ]; then
    if [ "$VERSION" = "latest" ]; then
      echo "The latest release may not have a $ASSET asset yet." >&2
    else
      echo "Check that release $TAG exists and has a $ASSET asset: https://github.com/$REPO/releases" >&2
    fi
  fi
  exit 1
fi

if ! download "$CHECKSUMS_URL" "$TMP_CHECKSUMS"; then
  echo "Nothing was installed: the download cannot be verified without checksums.txt." >&2
  echo "Releases made before checksums were published do not have one; install a newer release instead." >&2
  exit 1
fi

# checksums.txt covers every asset of the release, so only this platform's line
# is of any use. shasum writes the name with a leading "*" when it hashed in
# binary mode, which is not part of the name. Neither is a trailing CR: a file
# that arrived with CRLF endings is one install.ps1 reads without noticing, and
# the two scripts reading the same file differently is a difference nobody
# would think to look for.
EXPECTED_SHA256=$(awk -v asset="$ASSET" '{ sub(/\r$/, "", $2); sub(/^[*]/, "", $2); if ($2 == asset) { print $1; exit } }' "$TMP_CHECKSUMS")
if [ -z "$EXPECTED_SHA256" ]; then
  echo "Nothing was installed: checksums.txt for this release does not list $ASSET." >&2
  echo "That is a problem with the release rather than with this machine." >&2
  echo "Please report it: https://github.com/$REPO/issues" >&2
  exit 1
fi

# Hashed from stdin, so the output is the hash and nothing else: given a path,
# both tools append it, and it is a different path every run.
ACTUAL_SHA256=$($SHA256 < "$TMP_BINARY" | awk '{ print $1 }')
if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
  echo "Nothing was installed: the download does not match the checksum published for this release." >&2
  echo "  file:     $DOWNLOAD_URL" >&2
  echo "  expected: $EXPECTED_SHA256" >&2
  echo "  actual:   $ACTUAL_SHA256" >&2
  echo "The file is corrupt, or it was tampered with on the way here. Do not run it." >&2
  if [ "$VERSION" = "latest" ]; then
    # The benign explanation, and the only one a second run clears up: the two
    # requests above resolved `latest` independently of each other.
    echo "It can also mean a release was published mid-install, in which case running this again will succeed." >&2
  fi
  exit 1
fi

echo "Installing to $INSTALL_DIR/$BINARY_NAME..."
# Staged beside the target so the install itself is a rename within one
# directory, the way install.ps1 does it. A rename is only atomic within one
# volume, and /tmp usually is not the volume $INSTALL_DIR is on: staging here is
# what keeps a failed or interrupted run from leaving a half-written binary
# where a working one was.
#
# mktemp rather than a fixed "$BINARY_NAME.download": $INSTALL_DIR is root-only
# on Linux but group-writable on a default macOS, so a fixed name there is one
# more path someone can leave a symlink at for the cp below to follow as root.
# Deleting it first would only narrow that to the gap between the two commands -
# a gap wide enough to lose. An exclusive create under a name nobody can guess
# has no such gap.
STAGED=$(sudo mktemp "$INSTALL_DIR/$BINARY_NAME.XXXXXX")
sudo cp "$TMP_BINARY" "$STAGED"
# A rename preserves the mode bits, so the mode has to be right before it, and
# it has to be spelled out: mktemp creates the staged file readable by root
# alone, and a `chmod +x` on that would install a binary no one else can run.
sudo chmod 0755 "$STAGED"
sudo mv "$STAGED" "$INSTALL_DIR/$BINARY_NAME"
STAGED=""

echo "Done! Run 'pockode -auth-token YOUR_PASSWORD' to get started."
