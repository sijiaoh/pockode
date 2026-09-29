#!/bin/sh
set -e

REPO="sijiaoh/pockode"
BINARY_NAME="pockode"

# The documented entry point is `curl ... | sh`, which gives the script no
# arguments unless the user goes out of their way (`sh -s -- ...`). So the same
# choices are available as environment variables, which are the shorter thing to
# type in front of a pipe. An explicit flag wins over the environment.
VERSION="${POCKODE_VERSION:-latest}"
INSTALL_DIR="${POCKODE_INSTALL_DIR:-}"

usage() {
  cat <<'USAGE'
Installs Pockode on macOS and Linux.

Usage:
  curl -fsSL https://pockode.com/install.sh | sh
  curl -fsSL https://pockode.com/install.sh | POCKODE_VERSION=0.16.0 sh
  curl -fsSL https://pockode.com/install.sh | sh -s -- --version 0.16.0
  curl -fsSL https://pockode.com/install.sh | POCKODE_INSTALL_DIR=/usr/local/bin sh
  curl -fsSL https://pockode.com/install.sh | sh -s -- --install-dir /usr/local/bin

Options:
  --version <version>   Release to install, e.g. v0.16.0, 0.16.0 or latest.
                        Defaults to $POCKODE_VERSION, or the latest release.
  --install-dir <dir>   Where the pockode binary goes. Defaults to
                        $POCKODE_INSTALL_DIR, or ~/.local/bin. Only a directory
                        given here that you cannot write to is installed with sudo.
  -h, --help            Show this message.
USAGE
}

# $1 is the option, $2 an example value, $3 how many arguments were left
# counting the option, and $4 the one after it.
require_value() {
  if [ "$3" -lt 2 ]; then
    printf '%s\n' "Missing value for $1. Try: $1 $2" >&2
    exit 1
  fi
  # Without this, a forgotten value takes the next option as one: a --version
  # would end as a 404 for a release named after it, an --install-dir as a
  # directory named after it.
  case "$4" in
    -*)
      printf '%s\n' "Missing value for $1: next came the option $4. Try: $1 $2" >&2
      exit 1 ;;
  esac
}

# An empty flag is refused rather than taken as the default: unlike an empty
# $POCKODE_INSTALL_DIR, which is how a shell spells "unset", it is a mistake.
set_install_dir() {
  if [ -z "$1" ]; then
    echo "--install-dir must not be empty. Leave it out to install to ~/.local/bin." >&2
    exit 1
  fi
  INSTALL_DIR="$1"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      require_value "$1" 0.16.0 $# "${2-}"
      VERSION="$2"
      shift 2 ;;
    --version=*)
      VERSION="${1#--version=}"
      shift ;;
    --install-dir)
      require_value "$1" /usr/local/bin $# "${2-}"
      set_install_dir "$2"
      shift 2 ;;
    --install-dir=*)
      set_install_dir "${1#--install-dir=}"
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
    echo "Version must not be empty. Try: --version 0.16.0, or --version latest" >&2
    exit 1 ;;
  *[!A-Za-z0-9.+_-]*)
    printf '%s\n' "Invalid version: $VERSION" >&2
    echo "Expected a release tag such as v0.16.0, 0.16.0, or latest." >&2
    exit 1 ;;
esac

# Only the default is kept away from sudo unconditionally. A directory the user
# named is theirs to decide about, including one they cannot write to.
if [ -n "$INSTALL_DIR" ]; then
  INSTALL_DIR_GIVEN=1
else
  INSTALL_DIR_GIVEN=""
  INSTALL_DIR=\~/.local/bin
fi
# The shell leaves a tilde alone in `--install-dir=~/bin` and in a quoted
# POCKODE_INSTALL_DIR, and taken literally it would be a directory named "~".
case "$INSTALL_DIR" in
  \~|\~/*)
    if [ -z "${HOME:-}" ]; then
      printf '%s\n' "Cannot find your home directory for $INSTALL_DIR: \$HOME is not set." >&2
      echo "Set HOME, or choose a directory with --install-dir." >&2
      exit 1
    fi
    INSTALL_DIR="${HOME%/}${INSTALL_DIR#"~"}" ;;
esac
# Absolute, because it is compared against PATH and printed as a command to
# paste into another shell, where a relative path would mean something else.
case "$INSTALL_DIR" in
  /*) ;;
  *) INSTALL_DIR="$PWD/$INSTALL_DIR" ;;
esac
# Without its trailing slashes, or the PATH comparison below misses an exact
# match. The root directory is the one path that is nothing but slashes.
while :; do
  case "$INSTALL_DIR" in
    /) break ;;
    */) INSTALL_DIR="${INSTALL_DIR%/}" ;;
    *) break ;;
  esac
done
TARGET="$INSTALL_DIR/$BINARY_NAME"

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
  # Accept both v0.16.0 and 0.16.0, the way install.ps1 does.
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

# For paths inside the commands printed for the user to paste: quoted only when
# the shell would otherwise split or expand them, so the usual path reads plain.
quote() {
  case "$1" in
    *[!A-Za-z0-9_./-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# The download lands in a directory only this run can write to. A fixed name
# under /tmp is a path anyone on the machine can create - or symlink - first,
# and the install would then write through whatever they left there.
TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/pockode-install.XXXXXX")
TMP_BINARY="$TMP_DIR/$BINARY_NAME"
TMP_CHECKSUMS="$TMP_DIR/checksums.txt"
# Set once there is a staged file to remove.
STAGED=""
# "sudo" once the install has been found to need it, and empty otherwise, so the
# same commands serve both and nothing, cleanup included, asks for a password
# unless the install directory really demanded one.
SUDO=""

# Cleanup runs from a trap, which is after the failure messages below rather
# than between them: a removal that fails itself cannot make set -e cut the
# explanation short. It also covers an interrupted download, which no amount of
# error handling on the curl call would.
cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR" || :
    TMP_DIR=""
  fi
  if [ -n "$STAGED" ]; then
    $SUDO rm -f "$STAGED" || :
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
  echo "Releases before v0.16.0 do not publish one and cannot be installed; ask for v0.16.0 or newer." >&2
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

# Decided only now, after the checksum: a download that is refused must never
# have been the reason for a password prompt. Creating the directory is the
# first write, and it is tried as the user before anything else is considered.
if [ -e "$INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  printf '%s\n' "Nothing was installed: $INSTALL_DIR exists and is not a directory." >&2
  exit 1
fi
if ! { mkdir -p "$INSTALL_DIR" 2> /dev/null && [ -w "$INSTALL_DIR" ]; }; then
  if [ -z "$INSTALL_DIR_GIVEN" ]; then
    # The one thing the default promises is that it never needs root. Usually
    # this is a ~/.local or ~/.local/bin that some earlier `sudo` created.
    # The directory to take back is the first one that exists: when it is
    # ~/.local that stands in the way, fixing ~/.local/bin cannot help.
    BLOCKER="$INSTALL_DIR"
    while [ ! -e "$BLOCKER" ]; do BLOCKER=$(dirname "$BLOCKER"); done
    printf '%s\n' "Nothing was installed: you cannot write to $BLOCKER." >&2
    echo "It is usually left behind by an earlier command run with sudo. Take it back with:" >&2
    printf '%s\n' "  sudo chown -R \"\$(id -un)\" $(quote "$BLOCKER")" >&2
    echo "or install somewhere else with --install-dir." >&2
    exit 1
  fi
  if ! command -v sudo > /dev/null 2>&1; then
    printf '%s\n' "Nothing was installed: you cannot write to $INSTALL_DIR, and sudo is not available." >&2
    echo "Choose a directory you can write to with --install-dir, or leave it out to use ~/.local/bin." >&2
    exit 1
  fi
  printf '%s\n' "You cannot write to $INSTALL_DIR, so installing there needs sudo."
  SUDO="sudo"
  $SUDO mkdir -p "$INSTALL_DIR"
fi

printf '%s\n' "Installing to $TARGET..."
# Staged beside the target so the install itself is a rename within one
# directory, the way install.ps1 does it. A rename is only atomic within one
# volume, and /tmp usually is not the volume $INSTALL_DIR is on: staging here is
# what keeps a failed or interrupted run from leaving a half-written binary
# where a working one was.
#
# mktemp rather than a fixed "$BINARY_NAME.download": a directory the user named
# can be one other people write to too - /usr/local/bin is group-writable on a
# default macOS - and a fixed name there is a path someone can leave a symlink
# at for the cp below to follow, as root when this runs under sudo. Deleting it
# first would only narrow that to the gap between the two commands - a gap wide
# enough to lose. An exclusive create under a name nobody can guess has no gap.
STAGED=$($SUDO mktemp "$INSTALL_DIR/$BINARY_NAME.XXXXXX")
$SUDO cp "$TMP_BINARY" "$STAGED"
# A rename preserves the mode bits, so the mode has to be right before it, and
# it has to be spelled out: mktemp creates the staged file readable by its owner
# alone, and a `chmod +x` on that would install a binary no one else can run.
$SUDO chmod 0755 "$STAGED"
$SUDO mv "$STAGED" "$TARGET"
STAGED=""

# What the user's shell will run when they type `pockode`, which this script
# inherited: `curl ... | sh` runs with their PATH. Compared as files rather than
# as strings, so a PATH entry that reaches $INSTALL_DIR through a symlink, or
# spells it with a stray slash, still counts.
RESOLVED=$(command -v "$BINARY_NAME" 2> /dev/null || :)
if [ -n "$RESOLVED" ] && [ "$RESOLVED" -ef "$TARGET" ]; then
  echo "Done! Run 'pockode -password YOUR_PASSWORD' to get started."
  exit 0
fi

# Another copy that comes first on PATH - typically the /usr/local/bin/pockode
# this script used to install - would keep answering to `pockode` after every
# upgrade. It is only reported: removing it can need the root this install
# otherwise does without.
if [ -n "$RESOLVED" ]; then
  if [ -w "$(dirname "$RESOLVED")" ]; then
    REMOVE="rm"
  else
    REMOVE="sudo rm"
  fi
  echo >&2
  printf '%s\n' "Warning: 'pockode' runs $RESOLVED, not the copy just installed at $TARGET." >&2
  echo "It comes first on your PATH, so it will keep running instead of this one." >&2
  echo "If it is an older install, remove it with:" >&2
  printf '%s\n' "  $REMOVE $(quote "$RESOLVED")" >&2
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*|*":$INSTALL_DIR/:"*) ;;
  *)
    # Written with $HOME where it applies, so the line reads the way the user's
    # own dotfiles do. The rest is escaped for the double quotes it lands in.
    # Matched only with a HOME to match against: without one the pattern is a
    # bare "/*", which would claim every directory for $HOME.
    case "${HOME:+$INSTALL_DIR}" in
      "${HOME%/}"/*) PATH_ENTRY="\$HOME/$(printf '%s' "${INSTALL_DIR#"${HOME%/}"/}" | sed 's/[\\"$`]/\\&/g')" ;;
      *) PATH_ENTRY=$(printf '%s' "$INSTALL_DIR" | sed 's/[\\"$`]/\\&/g') ;;
    esac
    EXPORT_LINE=$(quote "export PATH=\"$PATH_ENTRY:\$PATH\"")
    # $SHELL is the user's login shell, which is the one whose startup file a
    # new terminal reads - not the sh this script is running in.
    case "${SHELL##*/}" in
      zsh) PATH_COMMAND="echo $EXPORT_LINE >> ~/.zshrc" ;;
      # macOS opens every terminal as a login shell, which reads .bash_profile
      # and not .bashrc; Linux terminals are the other way round.
      bash)
        if [ "$OS" = "darwin" ]; then
          PATH_COMMAND="echo $EXPORT_LINE >> ~/.bash_profile"
        else
          PATH_COMMAND="echo $EXPORT_LINE >> ~/.bashrc"
        fi ;;
      fish) PATH_COMMAND="fish_add_path $(quote "$INSTALL_DIR")" ;;
      *) PATH_COMMAND="echo $EXPORT_LINE >> ~/.profile" ;;
    esac
    echo
    printf '%s\n' "$INSTALL_DIR is not on your PATH. To add it, run:"
    printf '%s\n' "  $PATH_COMMAND"
    echo "and open a new terminal."
    ;;
esac

echo
echo "Done! Until 'pockode' finds this copy, start it with its full path:"
printf '%s\n' "  $(quote "$TARGET") -password YOUR_PASSWORD"
