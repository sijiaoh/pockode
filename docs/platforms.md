# Platform Support

Which prebuilt binaries exist, how to install them, and what each platform needs
around them. Build details for the release artifacts are in
[scripts/README.md](../scripts/README.md).

## Release Binaries

Every [release](https://github.com/sijiaoh/pockode/releases/latest) attaches one
binary per platform. Each one embeds the frontend, so it is the only thing to
download.

| Platform | Architecture | Artifact | Install |
|----------|--------------|----------|---------|
| macOS | Intel (`amd64`) | `pockode-darwin-amd64` | `curl -fsSL https://pockode.com/install.sh \| sh` |
| macOS | Apple silicon (`arm64`) | `pockode-darwin-arm64` | same |
| Linux | `amd64` | `pockode-linux-amd64` | same |
| Linux | `arm64` | `pockode-linux-arm64` | same |
| Windows | `amd64` | `pockode-windows-amd64.exe` | [Download from the release](#installing-on-windows) |

There is no `windows/arm64` artifact. Windows 11 on ARM runs x64 binaries under
emulation, and this one is pure Go built with `CGO_ENABLED=0`, so a native build
would buy close to nothing — and shipping an architecture the project cannot test
would leave users to find out whether it works.

## Installing on Windows

`install.sh` covers macOS and Linux only: it resolves the platform with
`uname -s`, so under Git Bash or MSYS it exits with `Unsupported OS` instead of
installing anything. Download the binary directly:

1. Get `pockode-windows-amd64.exe` from the
   [latest release](https://github.com/sijiaoh/pockode/releases/latest).
2. Run it from the project directory you want to work in — that is what Pockode
   operates on by default (`--work`):

   ```powershell
   .\pockode-windows-amd64.exe -auth-token YOUR_PASSWORD
   ```

3. Scan the QR code it prints.

Rename the file to `pockode.exe` and put it somewhere on `PATH` if you would
rather not type the full name; nothing in the server depends on the file name.

## Git on Windows

Pockode's git and worktree features shell out to the `git` CLI. macOS and Linux
usually already have it; on Windows install
[Git for Windows](https://git-scm.com/download/win) and make sure `git` is on
`PATH`.

Git for Windows matters for a second reason: it is also where Pockode finds the
`bash` it needs for the worktree setup hook.

## Worktree Setup Hook on Windows

The setup hook is a bash script: `worktree-setup.sh` in the data directory
(`.pockode/` unless `--data` says otherwise), run after a new worktree is
created.

Windows has no bash of its own, so Pockode looks for the `bash.exe` bundled with
Git for Windows — first in the installation that the `git.exe` on `PATH` belongs
to, then in the default install locations
(`%ProgramFiles%\Git`, `%ProgramFiles(x86)%\Git`, `%LocalAppData%\Programs\Git`).
A portable or relocated install therefore wins over a stale copy under
`Program Files`.

`bash.exe` is deliberately not resolved through `PATH`: Windows 10 and later ship
one in the system directory that launches WSL, which would run the hook inside a
Linux VM where the Windows paths it is handed do not resolve.

**If no bash is found, the hook is skipped and the worktree is still created.**
The skip is reported as a `worktree setup hook skipped` warning in the server log,
listing every path that was tried and how to get out of it (install Git for
Windows, or delete the hook file to stop Pockode from trying to run it).

Two consequences worth knowing before you rely on the hook:

- That warning goes to the server log only — the app on your phone shows the
  worktree as created either way. A worktree whose setup step never ran looks
  exactly like one whose setup step succeeded.
- Non-standard git installs (scoop, chocolatey shims, a portable copy unpacked
  somewhere custom) may keep `bash.exe` outside the locations above. The warning
  lists what was searched, so the fix is usually visible from the log.

Hooks are bash scripts on every platform. There is no PowerShell (`.ps1`) hook.

## File Permissions on Windows

The server writes its credential files — `server.json` and `relay.json` in the
data directory, `.git/.git-credentials` in the repository — with `0600`. On
Windows those mode bits are not access control: Go maps them only to the
read-only attribute, and the file inherits the ACL of its parent directory.
Anyone who can read the containing directory can read the credentials in it, so
on a machine with other users restrict those directories yourself.
