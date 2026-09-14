# Scripts

Helper scripts for local development and release builds, plus how a tag turns
into a published release.

Every script here is bash, run only on macOS and Linux. On Windows use WSL
— see [Developing Pockode on Windows](../docs/platforms.md#developing-pockode-on-windows)
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
git tag v0.17.0
git push origin v0.17.0
```

The tag is the version, and there is no version file to bump alongside it:
`build.sh` runs with `VERSION=${GITHUB_REF_NAME}` and strips the leading `v`,
then `-ldflags` replaces the `dev` fallback in the source, so `v0.17.0` is what
makes `pockode -version` print `pockode 0.17.0`.

| Step | What it does |
| ---- | ------------ |
| Build | `./scripts/build.sh` — five binaries and `checksums.txt` in `dist/` |
| Create draft release | Uploads `dist/*` to a release that is still a **draft** |
| Verify draft assets | `./scripts/verify-release-assets.sh dist` — see below |
| Publish release | Flips the draft to published, setting `make_latest` explicitly |

Four properties of that sequence are worth knowing before you touch it. All but
one have already gone wrong once; the exception — an asset's name saying nothing
about whether it arrived — is a way this could go wrong that nothing had ruled
out:

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
- **An asset's name says nothing about whether it arrived.** GitHub lists an
  asset it is still receiving under its final name, with `state` set to
  `starting` rather than `uploaded`, so a diff of names alone would pass a
  release carrying a half-written binary. The verification waits for every
  asset to reach `uploaded`, with a timeout — see below for why that is a wait
  rather than a plain equality check.
- **`make_latest` is spelled out rather than left to default.** It defaults to
  true, and the install scripts install whatever
  [`/releases/latest`](https://github.com/sijiaoh/pockode/releases/latest)
  points at — a prerelease inheriting that default would put every new install
  on an alpha. A tag containing `-` (`v0.17.0-alpha.1`) is published as a
  prerelease and does not become `latest`; anything else does.

### `verify-release-assets.sh` — Release gate

Run as `./scripts/verify-release-assets.sh dist`, with `GH_TOKEN`,
`GITHUB_REPOSITORY`, `GITHUB_REF_NAME` and `RELEASE_ID` in the environment. It
holds the three things that have to be true of a draft before it is published:

1. `dist/` is not empty. Both sides of a diff of an empty directory against a
   release with no assets are empty, and diff then agrees — the one way this
   check could pass while the release carries nothing, which is the accident it
   exists to catch.
2. Every asset has `state == "uploaded"`. This is a **bounded wait**, polled
   every 5s for up to 120s, not a one-shot equality check: whether an asset is
   still `starting` once the upload action has returned has never been measured
   here, and a strict check would turn any such window into a random red
   release. With no window to wait out, the first poll passes and nothing is
   spent. The 120s is derived from the job's own budget rather than from
   GitHub's timing — `release.yml` allows the job 15 minutes and a run of it
   takes 2–3, so a cap well inside the remainder is what makes a stuck asset
   come out as a named error instead of as a killed job.
3. The asset names are exactly `ls dist`.

A timeout names each asset that is still waiting and the state it is in; the
point is to distinguish "GitHub is slow" from "this one file never landed".

A `gh` call that fails is treated as a round that got no answer rather than as a
verdict: the reason is kept, and the next poll tries again. The wait is several
calls wide, so without that, one 502 or one rate-limit reply anywhere in the
window would throw away a whole draft. The deadline is the only bound — there is
no attempt count on top of it — and reaching it still fails, which is what
separates tolerating the jitter from tolerating the outcome. If the deadline
arrives with the last call still failing, what is printed is that call's own
error, not the stuck-asset list: nothing was learned about the assets at all,
and naming one as stuck sends whoever reads it hunting an upload that was never
stuck. A round that is lost and then retried says so in the log as it happens,
so a release that went out after three 502s does not read afterwards as one
that went out cleanly. Capturing `gh`'s stderr for that report is also what
would otherwise swallow it on a call that *succeeds*, so anything such a call
writes — a deprecation notice about the endpoint this gate rests on, say — is
handed on to the log too, as a note rather than as a reason to keep waiting.

The script deliberately avoids piping `gh` into anything. A workflow step's
default shell is `bash -e` without `pipefail`, so a failing `gh` inside a
pipeline hands its status to the next command and leaves its empty output
behind — which reads exactly like a release that has no assets yet.

### Testing a change to the release path before tagging

`.github/workflows/build.yml` runs `build.sh` on `ubuntu-latest` and
`macos-latest` whenever `build.sh`, `release.yml` or `build.yml` itself changes
— and on demand, via `workflow_dispatch` — then checks the `checksums.txt` that
comes out. It exists because a tag is otherwise the first thing that ever runs
this code, and by then the release is already published.

`.github/workflows/release-assets.yml` — a workflow of its own, because it
watches the two verify-assets scripts rather than `build.sh`, and needs neither
a toolchain nor a build — runs `verify-release-assets.test.sh`, which drives
`verify-release-assets.sh` against a stub `gh` that answers with canned release
bodies: assets already uploaded, assets that finish on a later poll, assets that
never finish, a `gh` that fails twice and then answers, a `gh` that answers and
warns on the same call, a `gh` that fails for the whole window, a `gh` that
fails without saying why, an empty `dist/`, and a release short an asset. Each
case that expects a failure asserts on the message printed and not only on the
exit status, and the suite then re-runs every one of them against deliberately
broken copies of the script, failing if a breakage goes unnoticed — a script
broken badly enough exits non-zero for entirely the wrong reason, so neither
layer is worth much alone. Run it locally with
`./scripts/verify-release-assets.test.sh`; it takes about eighty-five seconds —
most of it spent waiting out deadlines, which is what the retry it now checks
costs — and `jq` is the only thing it needs that working on the rest of this
repository does not already require.

What neither of those covers is GitHub's actual `starting` → `uploaded` timing,
and so whether 120s is enough. Only a real release answers that. For the release
steps themselves, push a prerelease tag (`v0.17.0-alpha.1`), let the workflow
run against the real API, then delete the release and its tag with
`gh release delete <tag> --cleanup-tag`. A prerelease is safe to experiment with
precisely because it cannot take `latest`.

## `dev.sh` — Development server

Runs the backend and frontend together with hot reload. Pass `--cluster` to run
the cluster-mode stack instead of the normal one.

```bash
./scripts/dev.sh            # normal mode
./scripts/dev.sh --cluster  # cluster mode
```
