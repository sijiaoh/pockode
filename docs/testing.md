# Reading a Failing Test

A red `go test ./...` or `pnpm run test` on a machine several agents share is
not, by default, evidence that anything is broken. It is also not, by default,
evidence that nothing is. Telling those apart took four tasks and a lot of
reports that opened by proving "it was already like that" — this document exists
so the next person can skip that part and go straight to the check that
separates the cases.

Start here, not with a bisect.

## Four kinds of red

Three of them are red. The fourth is the dangerous one, because it is green.

| Kind | How it looks | What to change | Seen here |
|---|---|---|---|
| **The machine is oversubscribed** | More failures the busier the box; a different file fails each run; every failure is a timeout, none is an assertion; serial runs are all green | The runner's own concurrency. Give the timeout enough room for scheduling, not for slow tests | frontend vitest; the `ws` 12 MiB deflate test |
| **The test assumes a schedule** | Only fails under load, but always at the same line; there is a `time.Sleep` waiting out something | Wait for the signal instead. **Not** a longer sleep — unless the budget is a backstop rather than the subject, as in the `relay` case below | `agentrole` `TestExternalChange_NotifiesListener`; `relay` `TestUplinkDialOptionsDoNotTruncateTheTunnel` |
| **The test fabricates an unreachable state** | Barely correlates with load; fails at a stable rate even on an idle machine running that package alone | Make the test drive a state the implementation can actually reach | `agent/claude` `TestBackgroundWait_OutputPushesTheDeadlineOut` |
| **Silent pass** | Green. Always green | Make the test assert the precondition it depends on, then mutation-verify | `agent/claude` `TestBackgroundWait_SurvivesAnEmptyTaskList` |

The first three are distinguished by two cheap measurements, in this order:

1. **Run the package alone, several times, on an idle machine.** A kind-3 failure
   survives this; kinds 1 and 2 vanish. `-count=50` finds it faster than
   `-count=1` repeated, but only if the whole package runs — running the single
   test with `-run` can be too fast to lose the race at all.
2. **Add load and watch the shape.** Kind 1 stretches smoothly and in proportion:
   the `ws` deflate test takes a few seconds alone, roughly triples with every
   core pinned by busy loops, and spans a wide band under `go test -race ./...`
   (the measured spread is in its `opTimeout` comment) — no fixed stall anywhere.
   Kind 2 is fine until one specific wait runs out, and then fails at the same
   line every time.

Silent pass has no symptom to measure. The only way to find it is to break the
implementation on purpose and check that the test notices — see
[Verification that verifies](#verification-that-verifies) below.

## Frontend: which timeout is talking to you

Three different timeouts produce three different messages, and they are
unrelated. Match the message before touching a number.

| Message | Knob | Where |
|---|---|---|
| `Test timed out in <n>ms` | `testTimeout` / `hookTimeout` | `packages/shared/vitest-runtime.js` |
| `[vitest-pool-runner]: Timeout waiting for worker to respond` | `maxWorkers` — the worker pool is starved, no individual test is slow. `poolOptions` and `fileParallelism` are the other levers, both left at their defaults | `packages/shared/vitest-runtime.js` |
| testing-library's `Unable to find an element …` with a DOM dump, from a `findBy*` | `asyncUtilTimeout` — **defaults to 1000ms** however high `testTimeout` is, and is enforced by testing-library, not vitest | `web/src/test/setup.ts` |

The third one catches people out: raising `testTimeout` does nothing for a
`findBy*` that already gave up.

The chosen values, and the measurements each was derived from, are in the
comments at those two files. What is worth saying here is the conclusion none of
them states on its own: **the failures were oversubscription, not slow tests.**
Vitest defaults `maxWorkers` to `cores - 1`, which assumes the suite owns the
machine. Each jsdom worker is a fork carrying a full DOM, so on a developer box
shared with other agents the limit reached first is memory, and the suite spends
most of its time contending with itself. Halving the workers did not trade speed
for stability — at comparable load it removed every timeout failure *and* made
the run several times faster.

So if the suite is timing out, look at how many workers it is running before
looking at how long each test is allowed to take.

CI is the other half of this: a GitHub runner does own its machine, the premise
for halving does not hold there, and the config hands `maxWorkers` back to
vitest's default under `CI`. `.github/workflows/frontend.yml` runs test and
build per project with a 10-minute budget, plus one workspace-wide lint job.

## Go: there is no equivalent knob

There is no repository-level concurrency setting to correct on the Go side. Test
binaries for different packages run in parallel because `go test -p` defaults to
`GOMAXPROCS`, and `-p` is a command-line argument, not a file in the repo. That
is also why a package's timing looks completely different under `go test ./...`
than it does run on its own, and why a timeout budget must be sized for the
former.

`.github/workflows/server.yml` runs `go test -v ./...` **without** `-race`, on a
dedicated runner, across three platforms with a 20-minute budget. The worst-case
numbers measured locally under `-race` alongside a dozen other binaries do not
describe CI at all.

The four Go findings, and what each one did *not* change:

- **`server/ws` 12 MiB deflate test** — kind 1. `opTimeout` stayed at 60s; the
  test data, assertions and coverage stayed as they were. Only the comment
  changed: it credited the whole test's wall clock under `./...` to a single
  operation, which made a correct budget look like it had barely any headroom —
  an invitation to raise it. Timing the exchange showed most of that wall clock
  is not under the deadline at all, and the slowest operation that *is* sits
  several times under the limit. A misattributed measurement is worse than no
  measurement: it argues for the wrong change.
- **`server/agentrole`** — kind 2. A fixed sleep became a wait on the listener's
  own signal, with a deliberately loose backstop for the case where the watcher
  never fires at all. The measured spread that backstop is derived from is in the
  comment; the point is that the delay has a lower bound (the debounce) and no
  upper bound, so no fixed sleep was ever going to be correct.
- **`server/relay`** — kind 2, found by the very `./...` reruns that were meant
  to sign the others off. Two sibling tests shared one 200ms dial budget with
  opposite needs: one waits for it to run out, the other needs the dial to beat
  it. For the second the budget is a backstop, not the subject, and 200ms was
  barely twice the slowest handshake measured — so it timed out under `./...`
  and never alone. The budget was raised for that test only; the sibling keeps
  its 200ms, which is correct there.
- **`server/agent/claude`** — kind 3, **zero implementation changes.** Every
  write to the background wait's deadline either arms it from `time.Now()` or
  clears it to zero, so a deadline already in the past is a state the
  implementation cannot produce. The test was creating one by hand and then
  racing the runner over it. The fix replaced the fabricated state with a
  reachable one, and turned the invariant the fix depends on into an assertion —
  a future edit that breaks it now fails deterministically with an explanation
  instead of returning a 7% flake.

That last move generalises: when a fix's safety rests on a relationship between
two values twenty lines apart, assert the relationship. Otherwise the flake comes
back silently the first time someone edits one of them.

## Red on macOS or Windows only

A fifth shape, and the one this document's "run it again" advice cannot touch:
green on every local run and on Linux CI, red on the other two runners. The
first thing to suspect is a path, because the temporary directory a test works
in is the one thing that is spelled differently on each platform: macOS hands
out `/var/folders/...`, which is a symlink to `/private/var/folders/...`, and
Windows hands out an 8.3 short path such as `C:\Users\RUNNER~1\...`. Code that
compares or keys on path strings, and code that resolves them on one route but
not the other, then has two names for one directory — a difference Linux's
`/tmp` never shows, because nothing about it needs resolving.

**That is reproducible locally, and cheaply.** Point `TMPDIR` at a symlink and
Linux behaves like macOS for every `t.TempDir()` in the run:

```sh
mkdir -p /tmp/realtmp && ln -sfn /tmp/realtmp /tmp/linktmp
TMPDIR=/tmp/linktmp go test ./... -count=1
```

This is how the per-worktree git lock keyed by an unresolved path
([git.md](git.md#serialising-writes)) was reproduced and then proven fixed,
after failing on macOS and Windows alone. Reach for it before reading the code
for platform differences by eye: a red run on the machine in front of you tells
you which of your guesses was the right one.

## Shell: a suite neither entry point runs

`go test ./...` and `pnpm run test` do not reach every test in the repository.
The release gate — `scripts/verify-release-assets.sh`, which decides whether a
draft release is complete enough to publish — is bash, and so are its tests,
which no local command runs for you:

```sh
./scripts/verify-release-assets.test.sh
```

Eighty to ninety seconds — most of it spent waiting out the deadlines the
retry behaviour is checked against — and `jq` is the only thing it needs that a
machine running the rest of this repository does not already have. CI runs it in
`.github/workflows/release-assets.yml` — the only place it runs automatically,
and then only when one of the two scripts, `release.yml`, or that workflow
itself changes, because it is `paths`-filtered. It has a workflow to itself
rather than a job in `build.yml` because these two scripts are not among the
files that workflow watches: a job there would make every edit to a shell test
that takes well over a minute pay for two full-platform builds. What each case
covers is in
[scripts/README.md](../scripts/README.md#testing-a-change-to-the-release-path-before-tagging).

Three things to know before reading it red:

- **Its wall clock is sleep, not work.** Those seconds are spent waiting out
  poll intervals and deadlines — measured runs of it burn twenty to thirty
  seconds of CPU in total, well under half the wall clock. Load does not
  stretch it the way kind 1 stretches the Go and vitest suites, so a red here
  is unlikely to be the machine.
- **It runs on Linux; the script runs on macOS.** `release-assets.yml` gives
  the suite an `ubuntu-latest` job, while `release.yml` — the only thing that
  ever runs the gate for real — is `macos-latest`. Anything the two platforms'
  shells and utilities disagree about is uncovered, and that is not
  hypothetical: a bare `mktemp -d`, which GNU accepts and BSD rejects, would
  have failed the gate on its first real tag. Reading caught that one; no run
  here would have.
- **It cannot go red for the thing that matters most.** The workflow step it
  guards runs only on a real tag push, so the stub `gh` it drives the script
  against answers with what GitHub is believed to do, not with what GitHub does.
  Whether an asset is still observably `starting` after the upload action has
  returned — and so whether the gate's 120s cap is enough — is outside what any
  test here can say. Only a real release answers it.

## Agent CLIs: the suite that spends money

The other suite neither entry point runs is the agent integration tests, and it
is held back differently: `//go:build integration` keeps it out of every
untagged build, so `go test ./...` does not compile it, let alone run it. The
commands that do, and the requirement that each CLI be logged in, are in
[server/AGENTS.md](../server/AGENTS.md). What that file does not say is what
running them costs.

**Every turn in it is a real API call.** `TestIntegration_ReportsCost` prints
one of the prices — `turn cost: 0.0725 USD`, for a turn whose whole prompt is
"Reply with just the word one." — and a full run is a few dozen of them. The
shared suite alone sends twenty messages per CLI (fourteen turns that run to
completion, plus six across the four interrupt and mid-turn scenarios), before
either package's own tests. Measured end to end, green and with nothing skipped:
`ok … 239.822s` for `agent/claude`, `ok … 352.377s` for `agent/codex`. That is
also the whole reason CI does not run it — there is no CLI on the runner and no
account to bill if there were — so a green CI says nothing whatever about this
suite.

### Anchor `-run` at both ends

The cheapest mistake on this page to avoid, and one this repository has already
paid for:

```sh
go test -tags=integration ./agent/claude -run 'TestIntegration/Interrupt$'    # wrong
go test -tags=integration ./agent/claude -run '^TestIntegration$/^Interrupt$' # right
```

`-run` splits its argument on `/` and matches each element as an *unanchored*
regexp, so the first command's `TestIntegration` also matches
`TestIntegration_ReportsCost`, `TestIntegration_BackgroundTaskDoesNotEndTheTurn`
and every other top-level `TestIntegration_*` in the package. Those then run in
full: they have no subtests, so the second element filters nothing out of them.
The scenario asked for takes a few seconds; the accident bills for most of a
run.

The two entry points are not named alike either — Claude's is `TestIntegration`,
Codex's is `TestCodexIntegration` — so a pattern carried from one package to the
other matches nothing. That one at least fails cheaply.

### Skip is not a pass, and it is not a failure

Eight places give up rather than assert — three in the shared scenarios, five
in Claude's own tests, none in Codex's. Only the first turns on a capability;
the other seven turn on what the model chose to do this time, which is why the
list can be empty on one run and not on the next.

| Where | It skips when |
|---|---|
| `ForkFromTheMiddle` (`server/agent/integration_test_suite.go`) | the agent implements no `SessionForker` — never true in this repository, where both do |
| `Interrupt` (same file) | the turn ended before producing anything to aim a stop at |
| `Interrupt` (same file) | the stop was sent and the turn ran to completion anyway |
| `TestIntegration_NoInternalSystemNoise` (`server/agent/claude/claude_integration_test.go`) | the model never called the Agent tool, so the turn had no subagent to report progress for |
| `TestIntegration_BackgroundTaskDoesNotEndTheTurn` (same file) | the model waited on the task in-turn, so the background wait was never entered |
| `TestIntegration_StopDuringBackgroundWait` (same file) | the turn ended before any background wait began |
| `TestIntegration_StopDuringBackgroundWait` (same file) | the model never ended its turn on a background task, so Stop was never pressed |
| `TestIntegration_LostBackgroundTasksAreReportedOnRestart` (same file) | the turn ended without leaving a background task running |

A skip is the honest report of a run that proved nothing, and it is the right
answer for all eight: none of these tests can tell "the behaviour is broken"
apart from "the model did not do the thing this run". But it follows that a
scenario which skips every time is not covered by anything, and nothing goes red
to say so. **Read the skip lines of a run, not just its last line.** The
measured runs above skipped none of the eight, and that is luck rather than a
property — particularly for the four background-task rows, which turn on whether
the model felt like backgrounding anything.

### The silent pass this suite used to carry

`Interrupt` is where that distinction was bought. It used to sleep two seconds,
send a stop, and count a turn that had already finished as a pass — the
[silent-pass](#four-kinds-of-red) row exactly, with a price tag. The margin was
not theoretical: left uninterrupted, the turn it drives finishes in 4.7 seconds
on this machine, so the sleep had about two seconds of room and the run went
green on whichever side of it landed. It now aims the stop at the first event
that proves the turn is in flight, and the two ways a turn can end anyway are
the two `Interrupt` rows in the table above. Mutation-verified: with
`SendInterrupt` commented out it skips, where before it passed.

That is the shape worth copying whenever a test depends on something that may
not happen — the branch where it did not happen has to say so, not return.

## Verification that verifies

Several times during this work a command ran, exited 0, and had not checked the
thing it appeared to check. Assume that is possible before quoting a green run as
evidence.

- **Pointing `tsc` at a solution-style config checks nothing.** Both frontend
  `tsconfig.json` files are `files: []` plus `references`, so `tsc --noEmit -p
  tsconfig.json` — and bare `tsc`, which means the same thing — type-checks
  nothing and exits 0. Only `tsc -b` follows the references. In `web` that is
  what `pnpm run build` runs, and switching to it immediately surfaced a real
  `TS2307` the no-op had hidden. `web-cluster`'s build script was bare `tsc`
  until this was found — a deliberate `TS2322` planted in `web-cluster/src`
  passed `pnpm exec tsc` with exit 0 and failed `pnpm exec tsc -b` with exit 2 —
  and now runs `tsc -b` like `web`'s. Both projects' `tsconfig.node.json` list
  `vitest.config.ts`, so the test config is covered as well — but only through
  that reference, which is exactly what bare `tsc` skips.
- **`biome check` exits 0 on warnings.** Several recommended rules —
  `noUnusedVariables` among them — are warnings, not errors, and a run that
  reports them still exits 0: the diagnostic is printed and the gate is green.
  A lint gate that only fails on errors lets that whole class through, which is
  why the root `lint` script passes `--error-on-warnings`. Drop the flag and a
  planted unused variable reports `Found 1 warning` and exits 0.
- **A green lint says nothing about the files outside its scope, and the scope
  was smaller than it looked.** `web`'s `biome check .` meant `web/`, so it
  never saw `../packages/shared`; `web-cluster`'s was narrowed to `src`, so it
  never saw its own `vite.config.ts`. Both were green the whole time, which is
  what kept it invisible — a lint that never reads a file cannot report on it.
  Lint now runs once from the repository root over all three directories;
  `AGENTS.md` describes that arrangement. Reaching for a root `npx biome`
  instead is not a substitute for owning the dependency there: before
  `@biomejs/biome` was a root devDependency, `npx` resolved to an unrelated
  registry package that happens to be named `biome` (0.3.3) and ran that, and
  it exits 0 on anything — including paths that do not exist. Move the
  dependency back down into the projects and that impostor comes back with it.
- **Markdown is outside every lint scope.** Pointed at `docs/`, Biome exits 1
  with `No files were processed in the specified paths` and lists them under
  `These paths were provided but ignored`. **Nothing lints the documentation.**
  What checks it is the tests that read it: the register comparison in
  `web/tests/touchTarget.test.ts`, and `web/tests/docsCitations.test.ts`, which
  holds all of `docs/` to the "cite a path, never a line number" rule in
  `docs/code/AGENTS.md`.
- **A `paths` filter can hide a guard from the change it guards.** Both of those
  documentation tests live under `web/` and run with `pnpm run test` there, but
  `frontend.yml` is `paths`-filtered on the frontend projects and `docs/` is not
  among those paths. A change that edits `docs/` without touching the frontend
  therefore does not trigger Frontend — and `docs/` is the whole of what the
  citation scan reads. Until `.github/workflows/docs.yml`, the guard was the
  silent-pass row of [Four kinds of red](#four-kinds-of-red) wearing a workflow
  badge: green because nothing ran, not because anything passed. That workflow
  runs the citation scan on `docs/**`, and its header says why it is a workflow
  of its own rather than a wider filter on `frontend.yml`. The register
  comparison is still only reached when `web/` changes; nobody has closed that
  one.
- **`--` before a vitest argument runs the whole suite instead of your file.**
  pnpm passes `--` through verbatim, and vitest's CLI parser collects everything
  after it into a bucket the CLI never reads, so those arguments are dropped in
  silence — neither honoured nor rejected. `vitest list <file>` collects that
  file's 7 tests; `vitest list -- <file>` collects 2197, the whole of `web`. The
  parsing is vitest's, not pnpm's, so a forwarding script is not what breaks:
  `pnpm run test`, `pnpm exec vitest run` and calling the binary yourself lose
  them alike. **Arguments go straight after the command; never write `--`.**
  What it costs is not a run that checked nothing — a filter matching no file
  exits 1 with `No test files found`, and nothing sets `passWithNoTests` in
  either project's config or in the shared runtime options — but a run that
  checked far more than you asked: 27 minutes over 148 files, its summary buried
  under a thousand ticks, and any `--maxWorkers` you wrote for a loaded box back
  at the config's number — the very knob
  [the timeout table](#frontend-which-timeout-is-talking-to-you) sends you to.
  To confirm an argument arrived, use one whose output changes shape, like
  `--reporter=dot`; vitest does not validate values, so `--maxWorkers=nope` runs
  happily and exits 0.
- **`--reporter=basic` is gone, and its error points the wrong way.** Vitest 4
  removed it and reads `basic` as a path to a custom reporter module, so the run
  dies before collecting anything with `Failed to load custom Reporter from
  basic` and `Does the file exist?` — which reads as a mistyped path, not as a
  flag that no longer exists. It is red (exit 1, nothing run), so what it costs
  is the time spent looking for the file. `--reporter=dot` is the terse one that
  survived.
- **`go test ... | grep ... | head` then `$?` reads `head`'s status**, which is
  essentially always 0. Capture the output in a variable and check the exit code
  of the command itself — or redirect rather than pipe, `>log 2>&1; echo $?`.
  This is not a Go-only hazard, and on the frontend it is the only way a status
  goes missing: both frontend `test` scripts are a bare `vitest run` and pnpm
  hands the child's code straight back, printing ` ELIFECYCLE  Test failed.`
  besides — so a frontend failure that read as green was read through a pipe. An
  interactive shell has no `pipefail`; the pipeline in `server.yml` is safe only
  because GitHub Actions runs `shell: bash` with `-eo pipefail`, and that same
  `-e` is why the step has to carry the status by hand to reach its report.
- **Green does not mean the assertion works.** Break the implementation on
  purpose and confirm the test goes red. This is the only way to catch a silent
  pass, and it is cheap: revert the mutation right after. Under load,
  `SurvivesAnEmptyTaskList` could collect the warning it asserted on without ever
  exercising the behaviour it was named for — and would have stayed green either
  way, so no amount of running it would have shown that. It now asserts the
  precondition first.
- **An exit status is weak evidence on its own.** Five of the release-gate
  suite's nine cases expect the script to fail, and a script broken badly enough
  fails for entirely the wrong reason. Two things keep them honest. Each also
  asserts on the message printed, so *why* it failed is part of the contract;
  and the suite then re-runs every case against deliberately broken copies of
  the script, failing if a breakage goes unnoticed. Each copy is compared
  against the original first, so a mutation whose pattern stopped matching after
  an edit is reported instead of counted as caught — which is what the manual
  version of this becomes once nobody repeats it.

## Sharing a machine with other agents

- **Record the load.** A timing number without the load average beside it cannot
  be compared to anything. `uptime` before and after.
- **Compare like with like.** "Faster after my change" means nothing if the
  before-run was at load 20 and the after-run at load 5. If an idle window never
  comes, say so and give both loads rather than implying a fair comparison.
- **Run the narrowest scope that reproduces.** A single package under `-count=N`
  answers most questions and costs the other agents far less than `./...`.
- **Reach for `./...` deliberately**, when the question is specifically about
  cross-package contention — that is the condition the parallel binaries create,
  and some failures exist only there.
- **Clean up after load experiments.** Busy loops used to force contention must
  be killed before reporting; check with `pgrep`.
- **Do not tune shared configuration for whatever else happened to be running.**
  The local `maxWorkers` halving is a statement about a developer box, which is
  why CI is explicitly excluded from it rather than inheriting it.
