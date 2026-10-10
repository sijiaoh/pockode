---
title: Install options and platforms
description: Supported systems, installing to another directory or a pinned version, upgrading, uninstalling, and what Windows needs.
linkTitle: Install options
weight: 40
---

{{< install >}}

## Platforms

| System | Architecture | Release file |
|---|---|---|
| macOS | Intel, Apple silicon | `pockode-darwin-amd64`, `pockode-darwin-arm64` |
| Linux | amd64, arm64 | `pockode-linux-amd64`, `pockode-linux-arm64` |
| Windows | x64 (also Windows 11 on Arm) | `pockode-windows-amd64.exe` |

Windows 10 on Arm cannot run x64 programs and is not supported. Each file is the whole program, web app included. Pockode also needs `git` for its Git and worktree features, and the `claude` or `codex` CLI.

## macOS and Linux

The script installs to `~/.local/bin/pockode` without `sudo`. If that directory is not on your `PATH`, it prints the line to add for your shell. It verifies the download against the release's `checksums.txt` before installing anything.

Install somewhere else (repeat it on every upgrade — the script does not remember it):

```sh
curl -fsSL https://pockode.com/install.sh | sh -s -- --install-dir /usr/local/bin
```

Install a specific version (`v0.16.0` or newer):

```sh
curl -fsSL https://pockode.com/install.sh | sh -s -- --version 0.16.0
```

**Upgrade** by running the install command again. **Uninstall** with `rm ~/.local/bin/pockode`. Each project's `.pockode` directory — its sessions, settings and work — is left alone either way.

An older install in `/usr/local/bin` may come first on your `PATH` and keep running; the script warns you and prints the `rm` command that removes it.

## Windows

The script installs `pockode.exe` to `%LOCALAPPDATA%\Programs\Pockode` and adds it to your user `PATH`, without administrator rights. The terminal you installed from can run it at once; terminals that were already open need reopening.

Anything but a default install goes through a script block:

```powershell
& ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Version v0.16.0
& ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -InstallDir D:\tools\pockode
& ([scriptblock]::Create((irm https://pockode.com/install.ps1))) -Uninstall
```

Things Windows needs alongside it:

- **[Git for Windows](https://git-scm.com/download/win)** for Git, and for the `bash` that runs the worktree setup script. If Pockode cannot find that `bash`, worktrees are still created but their setup script is skipped, and the app says so.
- **The AI CLI installed on the Windows side.** A CLI installed inside WSL is invisible to Pockode.
- **A restart of `pockode` if a CLI's installer added a new `PATH` entry**, so it inherits it. CLIs in `%APPDATA%\npm`, `%USERPROFILE%\.local\bin` and `%USERPROFILE%\.cargo\bin` are found without one.

## Verify a download yourself

Every release publishes `checksums.txt` beside the binaries:

```sh
sha256sum pockode-linux-amd64        # or: shasum -a 256 pockode-linux-amd64
grep pockode-linux-amd64 checksums.txt
```

If the install script reports a checksum mismatch, do not run the file. Run the script once more — a release published in between can cause it — and if it fails again, [report it](https://github.com/sijiaoh/pockode/issues).

Releases are on [GitHub](https://github.com/sijiaoh/pockode/releases). Pockode is pre-1.0 and released often; read the notes before upgrading. Check what you have with:

```sh
pockode -version
```
