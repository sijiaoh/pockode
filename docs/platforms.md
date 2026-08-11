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
| Windows | `amd64` | `pockode-windows-amd64.exe` | `irm https://pockode.com/install.ps1 \| iex` |

There is no `windows/arm64` artifact; ARM64 machines get the x64 one. Windows 11
on Arm runs x64 binaries, and it runs them without a WOW64 layer — no filesystem
or registry redirection, and system binaries are Arm64X PE files that x64 and
Arm64 processes load from the same locations. That is the part that matters here,
more than speed: everything Pockode does differently on Windows is a path lookup
(finding the `bash.exe` inside Git for Windows, stepping around the WSL `bash.exe`
in the system directory, resolving an AI CLI that is not on the inherited `PATH`).
Under emulation those resolve exactly as they would natively. The CPU cost lands
on a process that is idle almost all the time — Pockode is a WebSocket server that
shells out, and the two things that actually burn CPU, `git.exe` and the AI CLI,
are separate processes running natively (Git for Windows has shipped a native
Arm64 build since 2.47.1).

Windows 10 on Arm emulates x86 only, never x64, so it is not supported.
`install.ps1` stops with an error there rather than installing a binary that
cannot start.

What would change the decision: a bug that only reproduces under emulation, or
someone actually asking for a native build. Neither the build script nor CI is an
obstacle — `windows/arm64` is a first-class Go target and GitHub has offered
`windows-11-arm` runners since August 2025. Until then a second artifact only adds
a choice to the download page and a variable to every bug report, in exchange for
something emulation already provides.

## Installing on Windows

```powershell
irm https://pockode.com/install.ps1 | iex
```

Then run `pockode` from the project directory you want to work in — that is what
it operates on by default (`--work`) — and scan the QR code it prints:

```powershell
pockode -auth-token YOUR_PASSWORD
```

The script puts `pockode.exe` in `%LOCALAPPDATA%\Programs\Pockode` and adds that
directory to your user `PATH`. None of it needs administrator rights, which is the
deliberate difference from `install.sh` and its `sudo` write to `/usr/local/bin`.
**Open a new terminal afterwards**: the one you ran the command in resolved its
`PATH` when it started.

Re-running the same command upgrades in place.

Piping into `iex` cannot pass arguments, so pinning a version and uninstalling go
through a script block instead:

```powershell
& ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Version v0.12.1
& ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Uninstall
```

Uninstalling removes `pockode.exe` and the `PATH` entry. It deliberately leaves
the `.pockode` directory in each of your projects alone — sessions, settings and
work items stay where they are.

There is no winget, scoop or chocolatey package. All three would point at the same
release asset this script downloads, so none of them replaces it — each only adds
a manifest to keep current with every version, one of them through a pull request
to a repository this project does not own. Worth revisiting once the Windows build
has users.

`install.sh` still covers macOS and Linux only, but under Git Bash, MSYS or Cygwin
it now points at the command above instead of failing with `Unsupported OS`.

Downloading `pockode-windows-amd64.exe` from the
[latest release](https://github.com/sijiaoh/pockode/releases/latest) and running
it directly still works if you would rather not run a script. Nothing in the
server depends on the file name or where it lives.

## Git on Windows

Pockode's git and worktree features shell out to the `git` CLI. macOS and Linux
usually already have it; on Windows install
[Git for Windows](https://git-scm.com/download/win) and make sure `git` is on
`PATH`.

Git for Windows matters for a second reason: it is also where Pockode finds the
`bash` it needs for the worktree setup hook. That part is optional — without it
worktrees are still created, only their setup script is skipped, and Pockode says
so in the app rather than only in the log (see below).

## AI CLIs on Windows

Pockode runs `claude` and `codex` as subprocesses on every platform, so at least
one of them has to be installed and reachable. The startup banner reports what was
found:

```
    ▸ Agents claude  codex (not found)
```

If neither is found the banner says so and points at the fix, because otherwise
the first sign would be a session failing to start days later.

Finding them is where Windows differs, in three ways:

- **A CLI installed inside WSL is invisible.** WSL and Windows have separate
  filesystems and separate `PATH`s, and `npm install -g` inside WSL installs into
  the Linux one. Install the CLI on the Windows side.
- **Restart Pockode after installing a CLI.** A process keeps the environment it
  was started with, so the `PATH` entry an installer appends is not visible to an
  already-running `pockode.exe` — the CLI is right there, but the `PATH` Pockode
  inherited is stale. To soften that, it also looks in `%APPDATA%\npm`,
  `%USERPROFILE%\.local\bin` and `%USERPROFILE%\.cargo\bin`, which is where the
  CLI installers actually write. The "not found" error lists every directory it
  tried, so the conclusion is checkable from your side.
- **A `%VARIABLE%` in your project path can be rejected.** `npm install -g`
  installs the CLIs as `claude.cmd` / `codex.cmd`, and Windows runs batch files
  through `cmd.exe`, which expands `%NAME%` even inside quotes. Pockode hands the
  CLI a path under your project directory, so if that path contains a `%NAME%`
  naming a variable that is actually defined, it refuses to start the session and
  names the variable instead of silently passing a different path. A path with a
  lone `%`, such as `C:\50% done\proj`, is fine. Rename the directory, or install
  the CLI as a native `.exe`.

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

**If no bash is found, the hook is skipped and the worktree is still created** —
and you are told in the app, not just in the log. The New Worktree sheet says up
front that the setup script will not run and why; after creation it stays open on
"this worktree was created, but its setup script did not run" until you dismiss
it; and the same notice sits under Settings → Worktree → Setup Hook for as long as
the condition lasts. Each of them names the two ways out: install Git for Windows,
or delete `worktree-setup.sh` so Pockode stops trying to run it.

The server log still carries the same `worktree setup hook skipped` warning, with
the full list of paths that were tried. That list is what makes a non-standard git
install diagnosable — scoop, chocolatey shims or a portable copy unpacked
somewhere custom can keep `bash.exe` outside the locations above.

Hooks are bash scripts on every platform; there is no PowerShell (`.ps1`) hook.
A second hook format would mean the same setup knowledge lives in two files that
drift apart quietly — and the failure mode it introduces is worse than the one it
removes: today the hook is skipped and says so, whereas a `.ps1` alongside a `.sh`
would run different logic on Windows that a macOS colleague would never see go out
of sync. The gap it would close is also narrow: on Windows, installing git
essentially means installing Git for Windows, which brings `bash.exe` with it.
Worth revisiting only for a case that installing Git for Windows cannot fix, such
as a policy that forbids it, or a hook that genuinely needs PowerShell.

## Paths on Windows

Anywhere Pockode takes a directory from you — the `--work`, `--data` and
`--log-file` flags, a cluster node's path, the worktree base directory setting —
both separators work, and a leading `~` is expanded to your home directory.

That last part is worth stating because it is not the shell doing it. `bash` and
`zsh` expand `~` before the server ever sees it; neither `cmd.exe` nor PowerShell
does, so on Windows `--work ~\projects` reaches the server verbatim. Pockode
expands it itself, which is why the same value behaves the same on every
platform.

## File Permissions on Windows

Unix mode bits are not access control on Windows — Go maps them only to the
read-only attribute, and a file inherits the ACL of its parent directory
instead. That matters because the default ACL below a drive root grants every
local account read access: a data directory at `C:\dev\app\.pockode` would be
readable by everyone on the machine, while the same directory under
`%USERPROFILE%` would not.

So Pockode does not rely on mode bits there. At startup it replaces the data
directory's ACL with one naming only you, SYSTEM and Administrators, and the
files inside — `server.json`, `relay.json`, session transcripts, `server.log` —
inherit it. In `--git` mode the `.git` directory Pockode creates is restricted
the same way, so the PAT in `.git\.git-credentials` stays covered even though
git rewrites that file after every push. Administrators stay on the list
deliberately: they can take ownership of any file regardless, so removing them
would break backup and antivirus tools without keeping anything secret.

Two consequences worth knowing:

- **Another Windows account cannot use the same data directory.** That is the
  point of the change, and it matches how `0700` behaves on unix — but if you
  previously shared a project directory between two accounts, the second one
  will now be denied.
- **On FAT or exFAT there is nothing to restrict.** A project on a removable
  drive has no ACLs at all. Pockode logs a warning naming the path and starts
  anyway rather than refusing to run; treat the credentials there as readable by
  anyone with access to the drive.

The reasoning behind restricting a directory rather than each file, and behind
each of the choices above, is in
[Authentication → Credentials on Disk](code/authentication.md#credentials-on-disk).

## Running in the Background on Windows

Task Scheduler with "run whether user is logged on or not" is the way to keep
Pockode running without a logged-in session, and it works. A Windows service works
too, but only behind a wrapper such as NSSM or WinSW: `pockode.exe` is an ordinary
console program and does not speak the service control protocol `sc create`
expects.

Both of those launch with no console at all, which used to matter in cluster mode:
asking a node to exit relied on a Ctrl+Break console event, so exactly the
always-on setups the product is aimed at would have gone straight to a forced
kill. A node is signalled through a named kernel event now, which has nothing to
do with consoles — see
[Asking a node to exit on Windows](cluster.md#asking-a-node-to-exit-on-windows).

Three things that are easy to get wrong here:

- `Start-Process -WindowStyle Hidden` is *not* running without a console. It still
  gets one; only the window is hidden. Console-based shutdown always reached those
  processes, as it did when starting from a terminal or with `-NoNewWindow`. Only
  services and logged-off scheduled tasks were ever affected.
- Starting an AI CLI does not flash a console window. Pockode gives it a console
  of its own with no window attached, in every mode.
- Closing the terminal a cluster was started from no longer takes its nodes down
  with it. Stop a node from the UI instead; see the same section above for why the
  behaviour changed.

## Developing Pockode on Windows

`scripts/build.sh` and `scripts/dev.sh` are bash scripts, verified only on macOS
and Linux. Use WSL on Windows.

That is a decision, not an oversight. Release artifacts are cross-compiled by CI
on macOS, and what a Windows user downloads is a single `.exe` with the frontend
embedded, so whether the build chain is portable never reaches them. `build.sh`
may well work under Git Bash — MSYS rewrites the `-o` path it hands to the native
`go.exe` — but that has never been verified, and WSL is the supported answer.

The server test suite does run on `windows-latest`; the frontend one does not, and
deliberately. The realistic Windows-only frontend failure is a lockfile missing a
platform-specific optional binary, and all three lockfiles carry the full set of
`win32` artifacts. What is left — case sensitivity, line endings — is stricter on
Linux, so a Windows leg would catch nothing the existing one misses.

This rests on the project [not taking code contributions yet](../README.md#feedback).
When that changes, "frontend development on Windows has never been exercised"
stops being hypothetical and this section should be re-evaluated.
