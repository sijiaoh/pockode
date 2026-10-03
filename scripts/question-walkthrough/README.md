# Answering UI walkthrough

Puts the answering UI ([docs/answering-ui.md](../../docs/answering-ui.md)) on a
real browser in every state that document describes, and saves a screenshot of
each, so a design pass can look at the pixels rather than at class names, and a
fix can be compared before and after.

```bash
scripts/question-walkthrough/run.sh shoot                  # every state, abyss light + dark
scripts/question-walkthrough/run.sh shoot --themes=all     # every state, all 5 themes × light/dark
scripts/question-walkthrough/run.sh shoot note,decline 375x667  # only some scenes, viewports, themes
scripts/question-walkthrough/run.sh up                     # just the environment, to click through by hand
scripts/question-walkthrough/run.sh down
```

A filter is a substring of a scene, viewport or theme name (`shoot.mjs`'s
`SCENES`, `VIEWPORTS`, `THEMES`); commas join alternatives, and with several
filters a scene runs only where every one matches.

`shoot` always starts from a fresh environment and takes it down afterwards,
so two runs see the same sessions. `up` leaves it running at
<http://localhost:18970>, password `walkthrough`. `PORT` moves it, and `up`
refuses a port something else is already serving.

On a shared machine a full default run takes about half an hour, and
`--themes=all` five times that; `WALKTHROUGH_WORKERS` (default 4) is how many
browser contexts run at once. A scene that times out is tried once more, unless
it had already sent its answers.

## What runs

- **The real server and the production frontend.** `up` builds `web` into
  `server/static` (its usual, gitignored output) and builds the server with it
  embedded — what a user runs, and quick to load in each fresh browser context,
  where vite's dev server takes half a minute.
- **A fake `claude`** (`fake-cli/claude.mjs`, behind a `claude` wrapper),
  first on the server's `PATH`. It speaks enough stream-json for a turn and
  asks through the real path: its `question_post` goes to the server's local
  MCP API under its own session, so the tool row, the `question_posted` records
  and the unanswered list are what a real agent leaves. No money, no network,
  the same questions every time. A chat message that is exactly a scenario's
  `prompt` in `scenarios.mjs` asks that scenario; a work's kickoff asks `work`;
  anything else gets one line.
- **A scratch project** under `.walkthrough/state/project`, so nothing touches
  this checkout but `server/static`.
- **Playwright** (`playwright-core`, pinned in `run.sh`) installed into
  `.walkthrough/node`, outside the workspace, with the headless shell that
  release drives. The shell's missing system libraries, if any, are unpacked
  from Ubuntu 24.04 packages into `.walkthrough/libroot` — no root needed. On
  another distribution, install the shell's dependencies the usual way
  (`playwright-core install-deps`) instead.

## Output

`.walkthrough/shots/question-ui/<state>_<viewport>_<theme>.png` (gitignored;
`SHOTS_DIR` moves it). Shots are overwritten, not cleared, so a filtered run
adds to a full one. A scene that fails leaves `FAILED_<scene>_…png` with what
was on screen, and the run exits non-zero; the next run clears those.

Timestamps differ from run to run, and on the desktop sidebar so do the rows:
every scene that sends answers has a session of its own.

| Viewport | Device |
|---|---|
| `375x667`, `390x844`, `375x560` | phone: touch, coarse pointer, DPR 2 |
| `1440x900` | desktop: fine pointer |

The soft keyboard is simulated by taking 300px off the viewport's height: the
app's viewport meta asks for `interactive-widget=resizes-content`, under which
a keyboard does exactly that.

The states, and the scene that takes them, are the `SCENES` list in
`shoot.mjs`; each runs in a fresh browser context, so no draft carries from one
to the next.
