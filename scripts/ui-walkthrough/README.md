# UI walkthrough

Puts the chat screen and the answering UI
([docs/answering-ui.md](../../docs/answering-ui.md)) on a real browser in the
states they are designed for, and saves a screenshot of each, so a design pass
can look at the pixels rather than at class names, and a fix can be compared
before and after.

```bash
scripts/ui-walkthrough/run.sh shoot                        # both suites, abyss light + dark
scripts/ui-walkthrough/run.sh shoot chat                   # only the chat suite
scripts/ui-walkthrough/run.sh shoot question --themes=all  # all 5 themes × light/dark
scripts/ui-walkthrough/run.sh shoot chat subagent,permission 360x740 dark  # some scenes, viewports, themes
scripts/ui-walkthrough/run.sh up                           # just the environment, to click through by hand
scripts/ui-walkthrough/run.sh down
```

A filter is a substring of a suite (`chat`, `question`), scene, viewport or
theme name; commas join alternatives, and with several filters a scene runs
only where every one matches. Scene names are the `SCENES` lists in each
suite's `scenes.mjs`, viewports are `VIEWPORTS` in `harness.mjs`.

`shoot` always starts from a fresh environment and takes it down afterwards,
so two runs see the same sessions. `up` leaves it running at
<http://localhost:18970>, password `walkthrough`, with nothing in it — the
sessions are made by `shoot`. `PORT` moves it, and `up` refuses a port
something else is already serving.

On a shared machine the chat suite takes about ten minutes and the question
suite about half an hour; `--themes=all` takes five times that.
`WALKTHROUGH_WORKERS` (default 4) is how many browser contexts run at once. A
scene that times out is tried once more, unless it had already sent something.

## What runs

- **The real server and the production frontend.** `up` builds `web` into
  `server/static` (its usual, gitignored output) and builds the server with it
  embedded — what a user runs, and quick to load in each fresh browser context,
  where vite's dev server takes half a minute.
- **A fake `claude`** (`fake-cli/claude.mjs`, behind a `claude` wrapper),
  first on the server's `PATH`. It speaks enough stream-json for a turn — tool
  calls and results, thinking, a subagent's frames under its call, the task
  lifecycle a background command and a subagent report through, permission
  requests it waits on the answer to, a turn it leaves open. It asks questions
  through the real path: its `question_post` goes to the server's local MCP
  API under its own session, so the tool row, the `question_posted` records
  and the unanswered list are what a real agent leaves. No money, no network,
  the same turn every time. What it plays is picked by the message (the
  comment at the top of `claude.mjs` has the rules); the turns themselves are
  `question/scenarios.mjs` and `chat/scenarios.mjs`.
- **A scratch project** under `.walkthrough/state/project`, so nothing touches
  this checkout but `server/static`. The fake's tool calls name files in it
  that do not exist: nothing reads them back.
- **Playwright** (`playwright-core`, pinned in `run.sh`) installed into
  `.walkthrough/node`, outside the workspace, with the headless shell that
  release drives. The shell's missing system libraries, if any, are unpacked
  from Ubuntu 24.04 packages into `.walkthrough/libroot` — no root needed. On
  another distribution, install the shell's dependencies the usual way
  (`playwright-core install-deps`) instead.

`harness.mjs` is what both suites share — the server connection, the
viewports and themes, the runner; a suite is a `scenes.mjs` exporting its
name, output directory, viewports, `setup` and `SCENES`, listed in
`shoot.mjs`.

## Output

`.walkthrough/shots/<suite>-ui/<state>_<viewport>_<theme>.png` (gitignored;
`SHOTS_DIR` moves `.walkthrough/shots`). Shots are overwritten, not cleared, so
a filtered run adds to a full one. A scene that fails leaves
`FAILED_<scene>_…png` with what was on screen, and the run exits non-zero; the
next run of that suite clears those.

Timestamps and clocks differ from run to run, and on the desktop sidebar so do
the rows: every scene that sends something has a session of its own.

| Viewport | Device | Suites |
|---|---|---|
| `375x667`, `375x560` | phone: touch, coarse pointer, DPR 2 | both |
| `390x844` | phone | question |
| `360x740` | phone — the narrowest in common use, where a subagent's Process runs out of room first | chat |
| `1440x900` | desktop: fine pointer | both |

The soft keyboard is simulated by taking 300px off the viewport's height: the
app's viewport meta asks for `interactive-widget=resizes-content`, under which
a keyboard does exactly that — the layout viewport shrinks and the page lays
out again, as it does in a smaller window. Shots with the keyboard up are
named `…-keyboard` and are taken on the phone viewports only, with the caret
in the field the keyboard is for.

That is Android Chrome's keyboard, not iOS Safari's: Safari ignores
`interactive-widget`, keeps the layout viewport and lets the keyboard cover
the bottom of the visual viewport instead. So a keyboard shot — and any height
measured from one — says nothing about an iPhone; check those states on a real
device. Nor does the resized page scroll the focused field into view, as
Chrome may on a real phone; a field hidden in a shot may show on the phone,
but a layout has to keep its own focused field visible rather than count on
that (the browser does not scroll again when the field grows).

## The chat suite

Every chat is played once, in `setup`, before the first screenshot; each scene
opens one in a fresh browser context. The exceptions are `thinking`, which
sends its own message, since the live `Thinking…` line is only said to a page
that is watching when the thinking starts — and `tool-running`, since a running
row's clock counts from when the page saw the call start. Every shot is taken
with reduced motion, so a live row shows its still dot, not a spinner.

| Chat (`chat/scenarios.mjs`) | What it is |
|---|---|
| `long` — *Webhook retries*, YOLO | one long turn: thinking, reads (one of a 180-line file), a failing command, a long command, a background command that finishes later in the turn, an Explore subagent with its own reads and failing command, edits to 8 files (one edit failing), and a Markdown answer with headings, a wide table and a long code block |
| `attachments` — *Crash report* | a message sent with an image and a log; a reply that edits 2 files |
| `permission` — *Clean rebuild* | a turn waiting on one Bash permission, with an Always Allow rule |
| `permissionMulti` — *Backoff cap* | a turn waiting on two at once, an Edit and a Write |
| `asking` — *Durable job queue* | a turn that asked a question |
| `running` — *Flaky dispatcher test* | a turn left open on a running command |
| `parked` — *Webhook load test* | a turn the CLI ended with its background command still running: parked on it (blocked: background) |
| `thinking` — *Retry budget* | sent by the scene; a turn left open thinking |
| `toolRunning` — *Migration dry run* | sent by the scene; a read, a search and a command left running, folded into a group |

| Scene | States (file name prefixes) |
|---|---|
| `long-turn` | `long-turn-01`, `-02`, … the whole turn a screen at a time from the top; `long-turn-keyboard` |
| `header` | `header-session-panel` — the title's panel, permission mode included |
| `expanded` | `expanded-thinking`, `-group-reads`, `-read-long`, `-bash-failed`, `-bash-long-command`, `-bash-background`, `-group-edits`, `-edit`, `-write`, `-edit-failed` — each opened alone, at the top of the screen |
| `subagent` | `subagent-open`, `subagent-process`, `subagent-process-end`, `subagent-step-failed` |
| `changes` | `changes-card`, `changes-card-all` (past *Show N more files*), `changes-file-open` |
| `markdown` | `markdown-table`, `markdown-code` |
| `attachments` | `attachments-sent`, `composer-menu`, `composer-attachments`, `composer-attachments-keyboard` |
| `permission` | `permission-card`, `permission-strip` (scrolled to the top; on a phone that takes the card off screen and leaves the strip), `permission-keyboard` |
| `permission-multi` | `permission-multi-edit`, `permission-multi-write` |
| `asking` | `asking-panel`, `asking-strip`, `asking-keyboard` |
| `running` | `running`, `running-bash-open` |
| `parked` | `parked` — opened mid-wait, so the reply's turn-end slot is the one settled on load |
| `thinking` | `thinking-draft-keyboard`, `streaming` (rows arriving, `Working`), `thinking-live` |
| `tool-running` | `tool-running-group` (the group's `3 steps · <current call>` and its clock), `tool-running-group-motion` (the same with motion allowed: a spinner where every other shot has a still dot), `tool-running-row` (the group open: the running row's own clock) |

## The question suite

The answering UI in every state its document describes: the states, and the
scene that takes them, are the `SCENES` list in `question/scenes.mjs`.
