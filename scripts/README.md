# Scripts

Helper scripts for local development and release builds, plus how a tag turns
into a published release.

The shell scripts here are bash, run only on macOS and Linux. On Windows use WSL
— see [Developing Pockode on Windows](../docs/platforms.md#developing-pockode-on-windows)
for why that is a decision rather than an oversight.

## `build.sh` — Release build

Builds both frontends (`web`, `web-cluster`) into the server's static
directories, writes the third-party notices beside them, then compiles the Go
server binary into `dist/`.

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

### `THIRD_PARTY_NOTICES.txt`

Each run also writes the third-party notices for exactly the platforms it
builds, ships them as a release asset and embeds them in every binary; a build
whose notices cannot be completed stops before anything lands in `dist/`. Where
they come from and what to do when they fail is in
[Third-party notices](#notices--third-party-notices).

### Environment variables

| Variable     | Default | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| `VERSION`    | `dev`   | Version stamped into the binary (leading `v` is stripped). |
| `OUTPUT_DIR` | `dist`  | Directory the binaries, `checksums.txt` and `THIRD_PARTY_NOTICES.txt` are written to. Absolute, or relative to the repository root. |

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
| Build | `./scripts/build.sh` — five binaries, `checksums.txt` and `THIRD_PARTY_NOTICES.txt` in `dist/` |
| Create draft release | Uploads `dist/*` to a release that is still a **draft** |
| Verify draft assets | `./scripts/verify-release-assets.sh dist` — see below |
| Publish release | Flips the draft to published, setting `make_latest` explicitly |
| Rebuild pockode.com | Stable releases only, as a job of its own after publishing: dispatches the *Site* workflow on main so the site's changelog picks the release up ([site/README.md](../site/README.md#the-changelog)) |

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
holds the four things that have to be true of a draft before it is published:

1. `dist/` is not empty. Both sides of a diff of an empty directory against a
   release with no assets are empty, and diff then agrees — the one way this
   check could pass while the release carries nothing, which is the accident it
   exists to catch.
2. `dist/THIRD_PARTY_NOTICES.txt` exists and is not empty. The diff below only
   compares the release with `dist/`, so a `build.sh` that stopped writing the
   notices would leave both sides agreeing on binaries published without them.
3. Every asset has `state == "uploaded"`. This is a **bounded wait**, polled
   every 5s for up to 120s, not a one-shot equality check: whether an asset is
   still `starting` once the upload action has returned has never been measured
   here, and a strict check would turn any such window into a random red
   release. With no window to wait out, the first poll passes and nothing is
   spent. The 120s is derived from the job's own budget rather than from
   GitHub's timing — `release.yml` allows the job 15 minutes and a run of it
   takes 2–3, so a cap well inside the remainder is what makes a stuck asset
   come out as a named error instead of as a killed job.
4. The asset names are exactly `ls dist`.

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
`macos-latest` whenever `build.sh`, either notices generator, `release.yml` or
`build.yml` itself changes — and on demand, via `workflow_dispatch` — then
checks the `checksums.txt` that comes out, and that `THIRD_PARTY_NOTICES.txt`
has both its sections and is embedded in every binary. It exists because a tag is otherwise the first thing that ever runs
this code, and by then the release is already published.

`.github/workflows/release-assets.yml` — a workflow of its own, because it
watches the two verify-assets scripts rather than `build.sh`, and needs neither
a toolchain nor a build — runs `verify-release-assets.test.sh`, which drives
`verify-release-assets.sh` against a stub `gh` that answers with canned release
bodies: assets already uploaded, assets that finish on a later poll, assets that
never finish, a `gh` that fails twice and then answers, a `gh` that answers and
warns on the same call, a `gh` that fails for the whole window, a `gh` that
fails without saying why, an empty `dist/`, a release short an asset, and a
`dist/` and a release that agree with each other but both lack the notices. Each
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

## `notices/` — Third-party notices

Every release carries `THIRD_PARTY_NOTICES.txt`, which holds the license text of
all the third-party software inside the binary: the server's Go modules, the Go
runtime, and the npm packages bundled into both frontends. Two generators write
it. Each one reads what the build actually links or bundles, not a list someone
keeps by hand — only the few gaps that cannot be read are filled in by hand
([Manual entries](#manual-entries)) — so adding or bumping a dependency needs no
extra step unless a generator fails, as [below](#when-it-fails).

### Where it ends up

- **In every binary.** `build.sh` copies the file into both `server/static/` and
  `server/cluster/static/`, so the binary serves it without authentication at
  `/THIRD_PARTY_NOTICES.txt`, in normal mode and in cluster mode alike. Both
  directories are gitignored, and the frontend builds empty them first, which is
  why the copy happens after those builds. Cluster mode serves only the second
  directory: with the file in the first alone, the URL would fall through to the
  cluster frontend's `index.html`. Of the two places the file ends up, this is
  the one that reaches users, because `install.sh` and `install.ps1` download
  only the binary and `checksums.txt`. Nothing in the UI links to the URL yet.
- **As a release asset**, `dist/THIRD_PARTY_NOTICES.txt`. It is uploaded with
  the rest of `dist/*` for anyone who downloads from the Releases page and
  wants to read it without running anything. `checksums.txt` still lists only
  the binaries, since the install scripts look up their line by binary name and
  `build.yml` counts the lines.
- **Not in the Docker image.** `server/Dockerfile` builds only `web` and runs
  `go build` without `build.sh`, so the binary in the image carries no notices.
  That is acceptable only because no workflow builds or publishes the image:
  an image users build for themselves is not something we distribute.
  If an image is ever published, it becomes something we distribute and has to
  carry the notices. Its build would then have to run both generators — the Go
  one in the Go stage, with the platform the image is built for; the frontend
  one where Node is, with `web-cluster`'s dependencies installed as well, since
  its bundle is part of the frontend section — and put the joined file into
  `static/` before `go build` (and into `cluster/static/` too, if the image
  ever builds `web-cluster` for cluster mode). The manual build in
  [server/AGENTS.md](../server/AGENTS.md) carries no notices either; that is
  fine, because it makes a development binary, not a release.

### Where it comes from

`build.sh` runs both generators after the frontend builds and before
`go build`. Each one writes a file of its own; `build.sh` then joins the two:
server section, blank line, web section. Each section starts with a heading,
`Pockode server: third-party software` or
`Pockode web interface: third-party software`. Each entry in it gives a name
and version, the page its source code can be got from (MPL-2.0, which yamux
uses, requires that), the SPDX license, and then every license file in full.
Given the same inputs, both generators produce byte-identical output.

**Server — `server/internal/cmd/thirdpartynotices`.**

```bash
go run -C server ./internal/cmd/thirdpartynotices linux/amd64 darwin/arm64 > server.txt
```

- It takes the platforms as arguments and requires at least one. `build.sh`
  passes its own `platforms` array — under `--local`, just the host — because
  what gets linked can differ by platform. For each one it runs
  `go list -deps` with that `GOOS`/`GOARCH` and `CGO_ENABLED=0`, just as the
  build does, and takes the union of the modules found.
- For each linked package it uses the license file nearest the package on the
  way up to the module root, so a license in a subdirectory overrides the root
  one. `NOTICE*` and `PATENTS*` files next to it are included. A replaced module
  is read from its replacement.
- The Go runtime and standard library are part of every binary. They get their
  own entry, with `GOROOT`'s `LICENSE` and `PATENTS`, labelled with the version
  of the toolchain doing the build.
- It identifies licenses with
  [`github.com/google/licensecheck`](https://github.com/google/licensecheck),
  the classifier pkg.go.dev uses. licensecheck is not linked into `pockode`, so
  it does not appear in the notices itself.
- Last come the hand-kept entries from `manual.go` (see
  [Manual entries](#manual-entries)).

**Frontend — `scripts/notices/`.**

```bash
pnpm run notices:frontend                      # notices to stdout
node scripts/notices/frontend.mjs --out FILE   # what build.sh runs
pnpm run test:notices                          # the generator's own tests
```

- It needs `pnpm install` and takes about ten seconds. It builds `web` and
  `web-cluster` once more, in production mode, each with its own
  `vite.config.ts` and its own lockfile-pinned Vite, into a scratch directory
  that is thrown away. It never touches `server/static`.
- It reads what is shipped from the build's Rollup output, not from
  `package.json`, because `package.json` is wrong in both directions here:
  `tailwindcss` sits in `web`'s `dependencies` but is a build tool, the
  devDependency `@tailwindcss/typography` does ship CSS, and an import that is
  tree-shaken away ships nothing. The comment at the top of `npm.mjs` lists the
  sources it reads: rendered modules, Vite's injected helpers, and the CSS
  Tailwind compiles.
- **Files the bundler cannot see inside.** When a file from a package arrives
  as `?raw`, `?url` or `?inline`, or as a copied asset, the package's whole
  production dependency tree is listed, because such a file may be a prebuilt
  bundle of those dependencies. Today that file is
  `mermaid/dist/mermaid.min.js?raw`: Mermaid's self-contained build, with D3,
  DOMPurify, KaTeX, cytoscape, lodash-es and others inside. When this was
  written, it accounted for about 95 of the roughly 240 packages listed. The approach
  errs on the side of listing too much: some dependencies of Mermaid's that
  only run under Node are listed even though they are probably not in that
  build. If Mermaid is ever imported
  normally, the list becomes exact without any change here.
- **Packages bundled inside another package.** A package's own build may have
  inlined others, which then ship without being in the module graph or even
  among its dependencies. For every shipped file with a source map (the one
  its `sourceMappingURL` names, or a `.map` beside it), each package the map's
  `sources` name under `node_modules` is listed too. This is how Mermaid's
  bundle is known to carry `js-yaml`, and libraries the `tslib` helpers they
  were compiled with. The license is read from an installed copy, of the same
  version when there is one and of another otherwise: a bundle's dependencies
  drift from what is installed, and crediting a neighbouring version beats
  crediting nobody. A package not installed at all needs a manual entry.
- **Content generated from a devDependency.** `@shikijs/langs` and
  `@shikijs/themes` ship TextMate grammars and themes from many authors, built
  from `tm-grammars` and `tm-themes`, and no map records that. `CONTENT_FROM`
  in `npm-manual.mjs` names those sources, which are root devDependencies
  (within the ranges Shiki declares) so that their `LICENSE` and `NOTICE` — the
  latter holding every grammar's and theme's upstream license — can be read.
  Their NOTICE files also cover grammars this build leaves out; that
  over-credits, which is harmless. A few grammars have no upstream license that
  `tm-grammars` could find; its NOTICE lists only the ones that do.
- **Code outside `node_modules` counts as Pockode's own**, including
  `@pockode/shared`. Third-party code copied into the repository is therefore
  invisible to this generator, and the frontend has no equivalent of
  `manual.go` for it. Vendoring such code means adding one.

### When it fails

Both generators collect every license problem before they stop, so one run
lists them all. They print the problems to stderr, exit 1, and write no output.
In `build.sh`, which runs under `set -e`, that stops the build before any binary or
notices file reaches `dist/`, so `release.yml` fails at its Build step, before a
draft release exists. Both kinds of failure are caught earlier, on the pull
request that causes them:

| Message | Fails first in | What to do |
| ------- | -------------- | ---------- |
| `module M V: no license file in package directory D or above it` | Server (`go test ./...`, `TestEveryLinkedModuleIsLicensed`) | A module that publishes no license cannot be redistributed, and nothing can supply one for it: `manual.go` is only for code that no module brings in. Leave the dependency out, or use a version or a fork that does have a license (a `replace` is read from the replacement). |
| `M V: LICENSE: license not recognized`, or `license only N% recognized (as ID), below 75%` | Server, as above | Read the file. Below 75% the file may add terms of its own. Accepting it is a decision about the dependency, which is already *Ask First* in [server/AGENTS.md](../server/AGENTS.md). `minCoverage` applies to every module, so lowering it needs the reason added to its comment. |
| `F is ported from another fzf version than V`, or `F does not carry fzfLicense in its header` | Server (`TestFzfEntryMatchesPortedHeaders`) | The headers in `server/fuzzy` are the source. Update `fzfEntry`'s version or `fzfLicense` in `manual.go` to match them. |
| `N@V (path): package.json declares no license; …` | Frontend, `notices` job | Read the license from the package's license file and add a `license` entry for that `name@version` to `npm-manual.mjs`, with its `source`. |
| `N@V (path): no LICENSE, COPYING or NOTICE file with the L text; …` | Frontend, `notices` job | Find the text upstream for that version (the repository, the Readme) and add a `text` entry; its `source` is printed in the notices. If no copyright line exists anywhere, say in `source` whom you attributed it to and why — `use-composed-ref` is the precedent. |
| `N@V: publishes its own license in package.json now; …` or `… its own license file now; …` | Frontend, `notices` job | Delete that field from the entry, and the entry itself once it is empty. |
| `N@V: bundled into O but not installed, …` or `N (bundled in O): …` | Frontend, `notices` job | A source map says `O` carries `N`, and no version of `N` is installed. Find `N`'s license for that release (or the latest, if the map records no version) and add an entry under exactly that key with `license`, `text` and `source`. |
| `P: no longer shipped; drop its CONTENT_FROM entry …` / `S: the source of what P ships is not installed; …` | Frontend, `notices` job | Drop the entry, or add `S` to the root `devDependencies` within the range `P` declares for it (`pnpm add -Dw`). |
| `N@V: no longer shipped; drop its entry …` | Frontend, `notices` job | Usually a version bump. Delete the entry. If the new version still lacks the information, the same run also reports it under the new version — check whether upstream has fixed it before adding the entry again under that version. |
| `cannot tell which package the module / asset … comes from`, `cannot find the package …`, `M: cannot find its dependency D` | Frontend, `notices` job | Run `pnpm install` first. If the problem persists, the build is doing something the collector does not recognize, such as a new kind of virtual module or a plugin that injects code. Extend `npm.mjs` and its tests instead of adding an entry. |

`TestEveryLinkedModuleIsLicensed` checks every platform in `build.sh`'s
`platforms` array, reading the array from the script, so a module linked only on
`linux/arm64` fails on its pull request too, even though no runner is that
platform: `go list` needs no cross-compiler. It reads `go.mod` and `go.sum`
itself, because `go list` runs in a child process the test cache does not see;
without that, a changed requirement could replay an earlier cached pass.
Frontend's `notices` job runs when the frontends, `packages/`,
the root `package.json`, the lockfile or `scripts/notices/` change, so any
dependency bump triggers it. To check locally, run
`go test ./internal/cmd/thirdpartynotices` in `server/`, and
`pnpm run notices:frontend > /dev/null`.

After a passing build, `build.yml` checks that `dist/THIRD_PARTY_NOTICES.txt`
has both section headings and that each of the five binaries embeds them. The
release gate refuses a `dist/` without the file (see
[`verify-release-assets.sh`](#verify-release-assetssh--release-gate)).

### Manual entries

Each kind of manual entry has exactly one place, and an entry that no longer
matches what it describes fails a check: the Go one fails `go test`, an npm one
fails the generator.

- **Go: `manualEntries` in `server/internal/cmd/thirdpartynotices/manual.go`.**
  This is third-party code compiled into the server that no module brings in,
  so `go list` cannot see it. Today it holds a single entry: the fzf port in
  `server/fuzzy` ([docs/code/fuzzy-matching.md](../docs/code/fuzzy-matching.md#third-party-code)).
  `manual_test.go` checks the entry against the headers of the ported files.
  Porting code from anywhere else means adding an entry here.
- **npm: `MANUAL` in `scripts/notices/npm-manual.mjs`.** These fill in the
  `license`, the `text`, or both, for a shipped package that does not publish
  them itself. They are keyed by the exact `name@version`, and each has a
  `source` saying where the value came from. A package that is bundled into a
  shipped one but not installed anywhere needs both `license` and `text`, and
  is keyed by `name (bundled in owner@version)` when the map records no
  version. Today there are five: `format`, `khroma`, `use-composed-ref`, and
  `path-browserify` and `style-inject` bundled into Mermaid and
  react-zoom-pan-pinch. `CONTENT_FROM` in the same file is the other manual
  part: which shipped packages are generated from which devDependency. An entry for a package that now publishes
  the value, or for one that is no longer shipped, fails the generator, so the
  table cannot go stale.

## `dev.sh` — Development server

Runs the backend and frontend together with hot reload. Pass `--cluster` to run
the cluster-mode stack instead of the normal one.

```bash
./scripts/dev.sh            # normal mode
./scripts/dev.sh --cluster  # cluster mode
```

## `messaging/` — README generation and copy checks

The README's logo, tagline, demo GIF, quick start, platforms, features,
screenshots and license line are generated from
[`site/data/messaging.yaml`](../site/data/messaging.yaml), the one source the
site and the marketing assets read too. Each generated block sits between
`<!-- messaging:NAME -->` and `<!-- /messaging:NAME -->`; everything outside
the markers is hand-written. Change the wording in the source, never between
the markers, then:

```bash
pnpm run readme            # rewrite the README's messaging blocks
pnpm run check:messaging   # what CI runs (the Messaging workflow)
pnpm run test:messaging    # the checks' own tests, and the marketing palette's
```

`check:messaging` fails when:

- the README's blocks disagree with the source (`readme.mjs --check`);
- the README or anything under `site/` names a `pockode` flag the server does
  not have, one it marks deprecated, or one written with two dashes
  (`flags.mjs`). The server is the truth: the check builds it (Go required)
  and reads its own `-h` and `cluster -h`, so there is no flag list to keep in
  step. It reads a flag in a `pockode …` command line, and — in Markdown, HTML
  and YAML — a code span that is nothing but a flag (`` `-relay=false` ``). A
  flag of another tool belongs inside its own command line
  (`sh -s -- --version 0.16.0`), which the check leaves alone.

## `site/` — pockode.com build, checks and fonts

```bash
scripts/site/hugo.sh --gc --minify        # build with the pinned Hugo (CI runs this)
node scripts/site/links.mjs site/public   # after the build: the README's site links resolve
node --test "scripts/site/*.test.mjs"     # the link check's own tests
scripts/site/fonts.sh                     # rewrite the site's subset fonts (npm and uv)
```

The *Site* workflow builds with the first and runs the next two after it, beside
Lighthouse; [site/README.md](../site/README.md#checks) says what each holds. On
main it then deploys that build to Cloudflare Pages
([site/README.md](../site/README.md#deploying)).

## `ui-walkthrough/` — Chat and answering UI screenshots

Runs the server with a fake `claude` that plays scripted turns on demand — tool
calls, subagents, permission requests, questions, turns left running — and
drives a headless browser through the chat UI and the answering UI at phone and
desktop sizes, light and dark. Its `assets` command also shoots a demo project
and renders the marketing images, demo video and GIF in `site/static/marketing/`
([docs/marketing-assets.md](../docs/marketing-assets.md)). See
[its README](ui-walkthrough/README.md).
