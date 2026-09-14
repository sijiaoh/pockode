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
vitest's default under `CI`. `.github/workflows/frontend.yml` runs lint, test and
build per project with a 10-minute budget.

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
- **`npx biome check docs` is not Biome.** No Biome lives at the repository root
  — the binary is in `web/node_modules` and `web-cluster/node_modules` — so `npx`
  falls back to the registry package that happens to be named `biome` (0.3.3,
  unrelated to `@biomejs/biome`) and runs that. It exits 0 on a path that does
  not exist and on a file the real Biome fails, so a green run from the root is
  not evidence about anything. The real one is `pnpm exec biome check …` from
  inside `web` or `web-cluster`, and pointed at `docs/` it answers `these paths
  were provided but ignored` and exits 1 — Markdown is in neither project's
  scope. **Nothing lints the documentation.** What checks it is the tests that
  read it, such as the register comparison in `web/tests/touchTarget.test.ts`.
- **`go test ... | grep ... | head` then `$?` reads `head`'s status**, which is
  essentially always 0. Capture the output in a variable and check the exit code
  of the command itself. An interactive shell has no `pipefail`; the pipeline in
  `server.yml` is safe only because GitHub Actions runs `shell: bash` with
  `-eo pipefail`, and that same `-e` is why the step has to carry the status by
  hand to reach its report.
- **Green does not mean the assertion works.** Break the implementation on
  purpose and confirm the test goes red. This is the only way to catch a silent
  pass, and it is cheap: revert the mutation right after. Under load,
  `SurvivesAnEmptyTaskList` could collect the warning it asserted on without ever
  exercising the behaviour it was named for — and would have stayed green either
  way, so no amount of running it would have shown that. It now asserts the
  precondition first.

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
