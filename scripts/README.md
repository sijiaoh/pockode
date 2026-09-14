# Scripts

Helper scripts for local development and release builds, plus how a tag turns
into a published release.

Both scripts are bash, verified only on macOS and Linux. On Windows use WSL — see
[Developing Pockode on Windows](../docs/platforms.md#developing-pockode-on-windows)
for why that is a decision rather than an oversight.

## `build.sh` — Release build

Builds both frontends (`web`, `web-cluster`) into the server's static
directories, then compiles the Go server binary into `dist/`.

```bash
# Build for all release platforms (default)
./scripts/build.sh

# Build only for the current machine's platform (faster, for local dev)
./scripts/build.sh --local
```

### All-platform vs local

| Mode              | Command                   | Platforms built                                          | When to use                                  |
| ----------------- | ------------------------- | -------------------------------------------------------- | -------------------------------------------- |
| All platforms     | `./scripts/build.sh`      | `darwin/amd64`, `darwin/arm64`, `linux/amd64`, `linux/arm64`, `windows/amd64` | Producing release artifacts                  |
| Local only        | `./scripts/build.sh --local` | `$(go env GOOS)/$(go env GOARCH)`                     | Fast local builds / testing a single binary  |

`--local` cross-compiles nothing — it targets only the platform Go reports for
the current machine, which skips the other four builds. Use it when you just
need a runnable binary for the machine you are on; use the default when you need
the full set of release binaries.

Binaries are named `pockode-<os>-<arch>`, with a `.exe` suffix on Windows.

### `checksums.txt`

Each run also writes a `checksums.txt` next to the binaries, listing only the
ones it just built — so `--local` leaves a one-line file rather than stale
entries from an earlier full build. It ships as a release asset (`release.yml`
uploads `dist/*`), and both install scripts refuse to install a download that
does not match it; the user-facing side of that is
[Verifying the Download](../docs/platforms.md#verifying-the-download).

Lines are the standard `sha256sum` format — a 64-character lower-case hex hash,
two spaces, and a bare file name with no directory in front of it, because that
is the name the install scripts look their own line up by. The hashing uses
`sha256sum` where it exists and `shasum -a 256` otherwise, which is what a
release build on macOS gets; both tools write the same line, and either verifies
the other's output with `-c`.

### Environment variables

| Variable     | Default | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| `VERSION`    | `dev`   | Version stamped into the binary (leading `v` is stripped). |
| `OUTPUT_DIR` | `dist`  | Directory the binaries and `checksums.txt` are written to. Absolute, or relative to the repository root. |

## Releasing

Pushing a tag matching `v*` is the whole release procedure —
`.github/workflows/release.yml` does the rest on `macos-latest`:

```bash
git tag v0.16.0
git push origin v0.16.0
```

The tag is the version: `build.sh` runs with `VERSION=<tag>`, so the number
`pockode -version` prints comes from there and from nowhere else in the
repository.

| Step | What it does |
| ---- | ------------ |
| Build | `./scripts/build.sh` — five binaries and `checksums.txt` in `dist/` |
| Create draft release | Uploads `dist/*` to a release that is still a **draft** |
| Verify draft assets | Diffs the release's asset names against `ls dist` |
| Publish release | Flips the draft to published, setting `make_latest` explicitly |

Three properties of that sequence are worth knowing before you touch it, because
each one has already gone wrong once:

- **Assets can only be uploaded while the release is a draft.** The repository
  has immutable releases enabled, so an upload into a published release is
  rejected outright. Creating the release as a draft and publishing it
  afterwards is what makes the assets land — for a prerelease as much as for a
  final one.
- **Verification happens before publishing.** A release that is short a binary
  fails the run while it is still invisible, leaving a draft to delete by hand.
  The alternative — noticing afterwards — is not a cleanup you can do: an
  immutable release cannot be given its missing assets later, so it has to be
  deleted and the tag re-cut.
- **`make_latest` is spelled out rather than left to default.** It defaults to
  true, and the install scripts install whatever
  [`/releases/latest`](https://github.com/sijiaoh/pockode/releases/latest)
  points at — a prerelease inheriting that default would put every new install
  on an alpha. A tag containing `-` (`v0.16.0-alpha.1`) is published as a
  prerelease and does not become `latest`; anything else does.

### Testing a change to the release path before tagging

`.github/workflows/build.yml` runs `build.sh` on `ubuntu-latest` and
`macos-latest` whenever `build.sh`, `release.yml` or `build.yml` itself changes,
and checks the `checksums.txt` that comes out. It exists because a tag is
otherwise the first thing that ever runs this code, and by then the release is
already published.

It does not exercise the release steps themselves. For those, push a prerelease
tag (`v0.16.0-alpha.1`), let the workflow run against the real API, then delete
the release and its tag with `gh release delete <tag> --cleanup-tag`. A
prerelease is safe to experiment with precisely because it cannot take `latest`.

## `dev.sh` — Development server

Runs the backend and frontend together with hot reload. Pass `--cluster` to run
the cluster-mode stack instead of the normal one.

```bash
./scripts/dev.sh            # normal mode
./scripts/dev.sh --cluster  # cluster mode
```
