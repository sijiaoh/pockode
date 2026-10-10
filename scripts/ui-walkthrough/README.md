# UI walkthrough

Puts the chat screen and the answering UI
([docs/answering-ui.md](../../docs/answering-ui.md)) on a real browser in the
states they are designed for, and saves a screenshot of each, so a design pass
can look at the pixels rather than at class names, and a fix can be compared
before and after. Two more, `marketing` and `marketing-intro`, shoot the app at
work on a small demo project, the same to the byte every run, for the website,
the stores and the demo video.

```bash
scripts/ui-walkthrough/run.sh shoot                        # every suite but the marketing ones, abyss light + dark
scripts/ui-walkthrough/run.sh shoot marketing              # only the marketing shots
scripts/ui-walkthrough/run.sh shoot chat                   # only the chat suite
scripts/ui-walkthrough/run.sh shoot question --themes=all  # all 5 themes × light/dark
scripts/ui-walkthrough/run.sh shoot chat subagent,permission 360x740 dark  # some scenes, viewports, themes
scripts/ui-walkthrough/run.sh up                           # just the environment, to click through by hand
scripts/ui-walkthrough/run.sh up marketing                 # the same, on the marketing suite's project
scripts/ui-walkthrough/run.sh down
scripts/ui-walkthrough/run.sh stills                       # frame the marketing shots into finished images
scripts/ui-walkthrough/run.sh video                        # the demo video and its GIF, from the same shots
scripts/ui-walkthrough/run.sh assets                       # shoot + stills + video into site/static/marketing
scripts/ui-walkthrough/run.sh assets --confirm             # the same, keeping only what two renders agree on
```

A filter is a substring of a suite (`chat`, `question`, `marketing`,
`marketing-intro` — so `marketing` takes both), scene, viewport or
theme name; commas join alternatives, and with several filters a scene runs
only where every one matches. The two marketing suites run only when a filter
names them (`shoot marketing`, or `assets`): they take minutes longer than the
rest together and need `DEV_SERVER_PORT` free, which a design pass on the chat
should not pay for. Scene names are the `SCENES` lists in each
suite's `scenes.mjs`, viewports are `VIEWPORTS` in `harness.mjs`.

`shoot` starts a fresh server for each suite and takes it down afterwards, so
two runs — and two suites — never see each other's sessions. `up` leaves one
running at <http://localhost:18970>, password `walkthrough`, with nothing in
it — the sessions are made by `shoot`. `PORT` moves it, and `up` refuses a port
something else is already serving. A suite with a `devserver.mjs` (only
`marketing`) also gets that dev server, started in its project on
`DEV_SERVER_PORT` (default 18973, not Vite's 5173, which is likely taken), and
stopped with the server.

On a shared machine the chat suite takes about ten minutes, the question
suite about half an hour and the two marketing suites ten to twenty minutes
together, each with a build and a server start of its own; `--themes=all`
takes the first two five times as long.
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
  each suite's `scenarios.mjs`.
- **A scratch project** under `.walkthrough/state/<suite>/`, so nothing
  touches this checkout but `server/static`. `seed.mjs` writes it: the
  suite's `project.mjs` where it has one (`marketing`, and `marketing-intro`,
  which reuses it), a one-file repository otherwise, every commit dated from
  `WALKTHROUGH_CLOCK` in `run.sh` so its hash is the same every run. The chat
  suite's tool calls name files that do not exist: nothing reads them back.
- **Playwright** (`playwright-core`, pinned in `run.sh`) installed into
  `.walkthrough/node`, outside the workspace, with the headless shell that
  release drives. The shell's missing system libraries, if any, are unpacked
  from Ubuntu 24.04 packages into `.walkthrough/libroot` — no root needed. On
  another distribution, install the shell's dependencies the usual way
  (`playwright-core install-deps`) instead.

`harness.mjs` is what the suites share — the server connection, the
viewports and themes, the runner; a suite is a `scenes.mjs` exporting its
name, output directory, viewports, `setup` and `SCENES`, listed in
`shoot.mjs`. Optionally, a suite also names the `themes` it is shot in
(theme ids, such as `abyss-dark`), `optIn` (it runs only when a filter names
it), `contextOptions` spread into every browser context, `screenshotOptions`
into every screenshot, `browserArgs` for Chromium, `prepare(context, scene)`
run on each context before the scene navigates (a failure in it is retried
like the scene's own), and `serial`: its scenes depend on one another's order,
so they run one at a time, as listed, after the rest. A scene may name the `viewports` it is taken at.

## Output

`.walkthrough/shots/<suite>-ui/<state>_<viewport>_<theme>.png` (gitignored;
`SHOTS_DIR` moves `.walkthrough/shots`). Shots are overwritten, not cleared, so
a filtered run adds to a full one. A scene that fails leaves
`FAILED_<scene>_…png` with what was on screen, and the run exits non-zero; the
next run of that suite clears those.

In the chat and question suites, timestamps and clocks differ from run to run,
and on the desktop sidebar so do the rows: every scene that sends something
has a session of its own. The marketing suite pins all of that; see below.

| Viewport | Device | Suites |
|---|---|---|
| `375x667`, `375x560` | phone: touch, coarse pointer, DPR 2 | chat, question |
| `390x844` | phone | question |
| `360x740` | phone — the narrowest in common use, where a subagent's Process runs out of room first | chat |
| `1440x900` | desktop: fine pointer | chat, question |
| `390x804` | phone, less the status bar and home strip a frame draws | marketing |
| `390x760` | the same, less the browser's address bar as well (Port Preview's page) | marketing |
| `desktop@2x` | `1440x900` at DPR 2 | marketing |

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
| `long` — *Webhook retries*, YOLO | one long turn: thinking, reads (one of a 60-line file), a failing command, a long command, a background command that finishes later in the turn, an Explore subagent with its own reads and failing command, edits to 8 files (one edit failing), and a Markdown answer with headings, a wide table and a long code block |
| `attachments` — *Crash report* | a message sent with an image and a log; a reply that edits 2 files |
| `permission` — *Clean rebuild* | a turn waiting on one Bash permission, with an Always Allow rule |
| `permissionMulti` — *Backoff cap* | a turn waiting on two at once, an Edit and a Write |
| `asking` — *Durable job queue* | a turn that asked a question |
| `running` — *Flaky dispatcher test* | a turn left open on a running command |
| `fullRun` — *Full test run* | one command with a 20-line command and a 60-line log, between paragraphs of prose |
| `parked` — *Webhook load test* | a turn the CLI ended with its background command still running: parked on it (blocked: background) |
| `thinking` — *Retry budget* | sent by the scene; a turn left open thinking |
| `toolRunning` — *Migration dry run* | sent by the scene; a read, a search and a command left running, folded into a group |

| Scene | States (file name prefixes) |
|---|---|
| `long-turn` | `long-turn-01`, `-02`, … the whole turn a screen at a time from the top; `long-turn-keyboard` |
| `header` | `header-session-panel` — the title's panel, permission mode included |
| `expanded` | `expanded-thinking`, `-group-reads`, `-read-long`, `-read-open` (opened in place, at its *Show less*; the console's `read-show-less` says whether *Show less* cut that box again), `-bash-failed`, `-bash-long-command`, `-bash-background`, `-group-edits`, `-edit`, `-write`, `-edit-failed` — each opened alone, at the top of the screen |
| `subagent` | `subagent-open`, `subagent-process`, `subagent-process-end`, `subagent-step-failed` |
| `sticky` | `sticky-row` (a failed command's title pinned, its second line gone under it), `sticky-outer` (the subagent's title pinned over its Process), `sticky-nested` (a row inside the Process pinned over the subagent's), `sticky-nested-focus` (keyboard focus on the subagent's button raises its bar over the pinned inner one; logged with the bar's z-index and opacity), `sticky-nested-leaving` (that row's end carrying its bar out), `sticky-focus` (a control scrolled up into view inside a long body), `sticky-pending` (a pending card's bar, tint and frame) — each logs where every open row's bar measured, as does `sticky-nested-pushed` (content growing above the pinned inner row, with no scroll, unpins it) |
| `sticky-fold` | `fold-pinned` (the failed command folded from its pinned bar, landed at the top), `fold-on-screen` (folded with its title on screen, title unmoved), `fold-nested-pinned` (a row inside the Process folded from its bar, landed under the subagent's), `fold-nested-on-screen`, `fold-into-group` (a row kept open in a closed group folded from its bar: the group's summary lands at the top) — each logs the row's and the title's top before and after, and whether focus stayed on the row; `fold-pinned-key` logs the same, folded with Enter |
| `sticky-tail` | `tail-open` (a Read opened while following a running turn, its bar pinned on a phone), `tail-fold` (folded from that bar: the view stays at the end) — logs the bar, the fold, how far the view is from the end and whether the scroll button shows, and after a fold whether growth is still followed |
| `keep-place` | `keep-open` (the whole open row on one screen; logged as `keep-fits`), `keep-earlier` (*Show N earlier lines* with the log's last line mid-screen), `keep-less-unseen` (closed with its button under the pinned title) — each logs the box's edges, the button and the line at the box's bottom before and after, as do `keep-less`, `keep-more-command` and `keep-less-command`; `keep-header-pinned` (the opened output's header pinned under the row's title), `keep-header-leaving` (carried off under the title at the output's end) — each logs both bars, whether the title is still on top and whether a tap 8px above the collapse control is still the header's — and `keep-header-closed` (closed from that header mid-output; logs where the header landed and what has focus) |
| `changes` | `changes-card`, `changes-card-all` (past *Show N more files*), `changes-file-open` |
| `markdown` | `markdown-table`, `markdown-code` |
| `attachments` | `attachments-sent`, `composer-menu`, `composer-attachments`, `composer-attachments-keyboard` |
| `message-actions` | `message-actions` (the reply's Copy and Fork row, the user bubble's `…`), `message-menu-user`, `message-actions-fork-blocked`, `message-menu-fork-blocked` (the menu a blocked Fork opens) — the blocked pair staged as `no-anchor-seq`, the scene says why |
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

## The marketing suite

The raw captures [docs/marketing-assets.md](../../docs/marketing-assets.md)
frames: tidy, a small todo app (`marketing/project.mjs`), and the story *Add
due dates to todos* with its three tasks (§8.2). The story is started through
MCP; from there the fake plays every agent — the coordinator creating and
starting the tasks, each task reporting on the story and closing itself, the
third asking where undated todos go and the coordinator taking that question
to the user — and calls every Pockode tool through the real MCP path, so the
work store holds what real agents leave. The turns are
`marketing/scenarios.mjs`. Their edits are real — the fake writes each file
before it reports it — so the Git panel and the diff show what the changes
card says: 3 files `+86 −9` for the third, 6 files `+142 −18` committed. The
default story role and the first task role are renamed `PM` and `Engineer`
first, since their names are on every row.

Abyss dark only, the phone at `390x804` (the frame draws the status bar and
the home strip, §2) and the desktop at `desktop@2x` (1440×900), both at DPR 2, in Geist
— the faces the app names and does not ship, served from the pinned `geist`
package `run.sh` installs beside Playwright.

| Scene | Viewport | States |
|---|---|---|
| `project` | `390x804` | `project` — the list, the story running with its three tasks |
| `story` | `390x804` | `story` — the story's page, its tasks all running |
| `parallel` | `desktop@2x` | `desktop-story` (the story's page, the three task sessions running in the sidebar), `desktop-task` (task 3's chat, a call still running) — storyboard shot 3 |
| `asking` | `390x804` | `story-asking` — the story's page, tasks 1 and 2 running, task 3 waiting on its answer (§7's `phone-story`) |
| `answer` | `390x804` | `question` (just asked), `question-picked` (the recommended option picked, not sent) |
| `transcript` | `390x804` | `chat-question` (the request, the answered question and the next turn starting), `chat-tools` (a group of edits opened), `chat-changes` (the turn's changes card) |
| `diff` | `390x804` | `diff` — `TodoItem.tsx` |
| `preview` | `390x804` | `preview-sheet` — the Port Preview sheet over task 3's chat, `5173` entered; then Open, whose tab must log in with a ticket and land on `your-pc-5173.cloud.pockode.com` |
| `devserver` | `390x760` | `preview-page` — tidy's page (`marketing/tidy.html`), opened from its dev server directly |
| `commit` | `390x804` | `git-changes`, `commit-sheet`, `committed` |
| `reports` | `390x804` | `story-reports` — the closed story's page at the tasks' reports |
| `desktop` | `desktop@2x` | `desktop-chat`, `desktop-diff` |

The video's first two shots need the project before there is a story in it,
and this suite has the story running before its first scene, so they are a
suite of their own, `marketing-intro`, on a server of its own: the same
project, roles and look, its shots beside these.

| Scene | Viewport | States |
|---|---|---|
| `empty` | `390x804` | `project-empty` — the project screen with nothing on it |
| `create` | `390x804` | `new-story` (the New Story sheet, the role preselected), `new-story-filled` (the title typed), `story-new` (the story it created, not started) |

A server with no session at all has the app open a chat of its own and leave
the project screen for it, so the intro's `setup` makes that one chat first.

A state the video taps out of (`shot(state, { tap })`) has a sidecar beside
its PNG, `<state>_<viewport>_<theme>.json`, with the centre of the element
tapped, in viewport px — so a button the app moves takes the video's tap ring
with it. Every keyframe the video moves on from needs one; `run.sh video`
fails on a keyframe without it rather than cut on no tap.

Output is `.walkthrough/shots/marketing/`. Two runs with nothing changed in
between write the same bytes, because every source of difference is pinned:

- **Time.** The page's clock is fixed at `WALKTHROUGH_CLOCK` (in `run.sh`,
  §1.4's instant), in UTC and `en-US`, and every timestamp the server sends
  (`*_at`, `since`) is rewritten to that instant on its way to the page, and
  every duration it measured (`duration_ms`, `open_elapsed_ms`) to four
  seconds — the suite routes the WebSocket through Playwright to do it. The
  server's own clock is not touched; what reaches the page is the same as if
  it had been.
- **Git.** The seeded history is dated before the clock and committed as
  `Pockode Demo <demo@example.com>`; the server runs with `GIT_AUTHOR_DATE`
  and `GIT_COMMITTER_DATE` at the clock, so a commit made in the panel has
  the same hash every run. Both run with the global and system git config
  ignored and no identity from the environment, so a signing key or a hook of
  whoever runs it cannot change them.
- **The question card.** The fake posts its question a moment after the call
  that posts it, so that the server records them in that order and the page
  draws one card. It cannot see the server read the call, so
  `shared.ask` checks the order recorded for task 3's question and fails
  the run if it was lost, rather than shooting two rows. (The coordinator's
  copy races the same way; no shot shows its chat.)
- **The agents' order.** The task agents run at once, so each holds at a
  gate — a file in the server's data directory the suite creates — before it
  starts and again with a tool call still running. `setup` lets them on one
  at a time and waits for each to reach the server, so the order everything
  happened in, which the sidebar and the list sort by, never changes; all
  sessions are marked read before any shot. The sidebar's *show task
  sessions* toggle is set, or it would list none of them.
- **Order.** The suite is `serial`: its scenes run one at a time, in order,
  each on every viewport before the next. `setup` leaves the three tasks
  running; `shared.ask` lets the third on until it has asked, the other two
  still running; `shared.release` lets those two close; and `shared.answer`
  answers the question and lets the story close. Each runs at most once and a
  scene takes the one it needs first, so `shoot marketing diff` alone finds
  what a full run does. None can be taken twice, so a failed one stays failed
  for the rest of the run. `commit` resets the branch to where `setup` left it
  before and after.
- **Port Preview.** The app offers it only with a relay address, and there is
  no relay: for the `preview` scene alone (its `remoteUrl`), the `auth` reply
  carries `https://your-pc.cloud.pockode.com`, so no other shot gains the
  header button. The server issues a preview ticket only with a relay up, so
  the suite answers `port_preview.ticket` itself, and a route plays the
  preview host's ticket login, sending the tab on to the root as the host's
  redirect would — from the page, since a redirect a route answers is followed
  past the routes, onto the network. The tab is routed to the dev server, so
  nothing leaves the machine. The dev server serves one static page.
- **Usage.** Each turn reports fixed tokens and price (a scenario's `usage`),
  which the fake's result frame carries.
- **Rendering.** Shots are taken with `animations: "disabled"` — reduced
  motion does not stop a CSS colour transition, and one caught part-way is a
  few levels off — and the browser runs with `--disable-partial-raster`, since
  a tile repainted in part antialiases a few levels differently from one
  painted whole. Geist is served as one static file per weight, not as the
  variable font, whose bold weights a context now and then antialiased
  differently.

A scene added later keeps that by opening what `setup`
made, or what a `shared` step made once, rather than sending anything itself;
one that has to change the project puts it back. A work's turns are its
`MARKETING` entry in `scenarios.mjs`, picked by the work's title, which every
message Pockode sends a work carries — except an answer, which quotes its
question and is played only in the conversation that asked it (`follows`). Changing a chat's content changes the shots, of course — that is a
change to commit, not drift.

### Finished stills

`run.sh stills` turns the captures an earlier `shoot marketing` left into the
finished images of docs/marketing-assets.md — no build, no server, about half
a minute. It writes into `ASSETS_DIR` (default `.walkthrough/assets/`) in the
layout `site/static/marketing/` takes (§9):

| File | What |
|---|---|
| `screenshots/phone-{question,story,changes,diff,commit,preview}.png` | a capture in the phone frame (§2), 1020×1928, transparent; `preview` with the address bar (§3.2) |
| `screenshots/desktop.png` | `desktop-story` in the browser window (§3.1), 3072×2072, transparent |
| `og-image.png`, `og-image@2x.png` | the social image (§5), 1200×630 and twice that |
| `architecture-{dark,light}.png` | the architecture figure (§6), 2440×720, transparent |
| `architecture-dark-portrait.png` | its portrait variant for narrow screens (§6.1), 720×1600, transparent |

Each is an HTML page (`marketing/stills/`) rendered by the same headless shell
and Geist as the captures, and nothing in it moves or reads the time, so the
same captures give the same bytes. The frames are in `frames.mjs` on their
own — with the viewport each one's capture is taken at and where it sits in
the frame — and what the pages load (captures, logo, fonts) is in `serve.mjs`,
for anything else that shows a framed capture; the video does. The status bar
and home strip continue the capture's own top and bottom rows (§2), so a
change in the app's header colour carries into the frame without an edit
here.

### Demo video

`run.sh video` turns the same captures into the ~31s demo of
docs/marketing-assets.md §4 — no build, no server — writing into
`ASSETS_DIR/video/`:

| File | What |
|---|---|
| `demo.mp4` | 1920×1080, 30fps, H.264 High, CRF 20 |
| `demo.webm` | 1920×1080, 30fps, VP9, CRF 32 |
| `demo.gif` | 800×450, 10fps, looping; every move a cut. The run fails if it is over 6 MB |
| `demo-poster.png` | the frame in the middle of the question shot's first keyframe |

The storyboard — shots, captions, durations, keyframes — is
`marketing/video/storyboard.mjs`, so a copy edit is a line there. The stage,
`marketing/video/stage.html`, lays out the keyframes in the frames of
`marketing/stills/frames.mjs` and draws any time `t` it is asked for; nothing
on it runs on a clock. `render.mjs` steps `t` through every frame, screenshots
it and pipes it to ffmpeg. The terminal in the first shot is pockode's real
banner: `server/internal/cmd/marketingbanner` (in the server's module, so its CI
builds it) calls the server's `startup` package with
the demo's values, under `script` so it keeps its colours, at the version of
the nearest release tag (prereleases skipped). So the run needs `go`, `script`
(util-linux, so Linux only) and the tags — a shallow clone has none. A
keyframe's capture must be the size of its frame's viewport, and the banner
may print nothing the stage cannot draw in Geist Mono; either fails the run rather than the picture.

The video is the same bytes every run over the same captures. The frames are
a function of `t` alone, and ffmpeg is pinned — the `ffmpeg-static` package
`run.sh` installs into `.walkthrough/ffmpeg`, which fetches one fixed static
build — and runs bit-exact on one thread, so no encoder version, random
segment ID or split of the work differs. A new tag changes the version in the
banner, and with it the video.

Rendering takes a few minutes. A frame whose stage is in the same state as the
one before it (a held keyframe) is that frame's screenshot again.

### All of it, into the site

`run.sh assets` is `shoot marketing`, `stills` and `video` in one, written
into the committed `site/static/marketing/` (§9), which the README and the site
both point at. The render goes to `.walkthrough/` first and replaces the
committed copy only once all of it has succeeded; an asset it no longer makes
is deleted from there too. Over an unchanged UI and the same tag, a rerun
leaves no diff.

`run.sh assets --confirm` is what the Marketing assets workflow
(`.github/workflows/marketing-assets.yml`, started by hand) runs before it
opens a pull request. When anything changed it renders a second time, and a
file is only updated where both renders agree: rare glyph antialiasing noise
in a capture would otherwise become a pull request of its own. A file that
came out differently each time keeps its committed bytes and is listed in
`.walkthrough/assets-unconfirmed.txt`, which the workflow turns into warnings
on the run and a list in the pull request.

A render takes 15–25 minutes, and `--confirm` doubles that whenever anything
changed.

To run the workflow, start *Marketing assets* from the repository's Actions
tab on the branch the assets should land on (a tag is refused). It commits any
change to `marketing-assets/<branch>` and opens a pull request into that
branch; a later run force-pushes the same branch and updates the pull request,
or closes it if the assets turned out to be up to date after all. A failed run
uploads the captures and the server logs as the `walkthrough` artifact. Opening
the pull request needs *Allow GitHub Actions to create and approve pull
requests* in the repository's Actions settings. The runner is pinned to Ubuntu
24.04, since the pixels depend on the system the browser draws on — so a
render on another system may differ by antialiasing from the committed bytes,
and committing the workflow's render keeps them from churning.

### Changing an asset

Where each part comes from, so a change is made once:

| To change | Edit | Then |
|---|---|---|
| what the app shows — the project, the story, an agent's turn, its edits | `marketing/project.mjs`, `marketing/scenarios.mjs` | `assets` |
| which state is captured, or a new capture | `SCENES` in `marketing/scenes.mjs` (or `marketing-intro/`), keeping to the rules under *The marketing suite* | `assets` |
| which capture a still frames, or a new still | `PHONE_SHOTS` / `DESKTOP_SHOT` in `marketing/stills/render.mjs` | `stills`, or `assets` |
| the frames | `marketing/stills/frames.mjs` (the video uses them too) | `stills` and `video`, or `assets` |
| what the assets say about Pockode — the social image's pitch, the title and end cards, the terminal's command | `site/data/messaging.yaml`, never a renderer ([*The copy*](../../docs/marketing-assets.md#the-copy)); `marketing/messaging.mjs` reads it | `stills` and `video`, or `assets` |
| the social image's layout, the architecture figure | `marketing/stills/{social,architecture}.mjs` | `stills`, or `assets` |
| a caption, a shot's length, its keyframes | `marketing/video/storyboard.mjs` | `video`, or `assets` |
| the Port Preview page | `marketing/tidy.html` | `assets` |

`stills` and `video` re-render from the captures already in
`.walkthrough/shots/marketing/` into `.walkthrough/assets/`, which is the quick
way to look at a change; `assets` is what writes the committed copy. A visual
change belongs in [docs/marketing-assets.md](../../docs/marketing-assets.md)
first: it is the specification these files implement.
