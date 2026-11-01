# New Session UI

How a session is created now that it can be either of two kinds: the one
**New Session** button in the sessions tab, the choice between **Chat** and
**Canvas** made on the new session's empty state, and the setting that decides
which of the two a new session starts as. It also fixes the contract this UI
holds the server to — when the kind can still change, who refuses it, and what
everything that reads the kind sees.

Related: [canvas-ui.md](canvas-ui.md) for what a canvas session is (§1 for the
rule, §13.1 for the session option), [agent-chat.md](agent-chat.md)
for the session screen, [sidebar-ui.md](sidebar-ui.md) for the sessions tab's
rows, [agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session) for
the creates that do not come from the button.

## Key Files

| Path | Role |
|---|---|
| `web/src/components/Session/SessionsTab.tsx`, `web/src/lib/sessionCreate.ts` | The **New Session** button; the one create in flight (§2) |
| `web/src/lib/sessionKind.ts` | The two kinds, their labels, glyphs and hints, shared by the chooser and the setting |
| `web/src/components/Chat/SessionKindChooser.tsx`, `web/src/components/Chat/useSessionKindSwitch.ts` | The chooser (§3.2) and the write behind it: the hold on Send, the refusal line, the focus (§3.3, §3.4) |
| `web/src/components/Chat/ChatPanel.tsx`, `MessageList.tsx`, `web/src/components/Canvas/CanvasView.tsx` | When the chooser is shown and where (§3.1, §3.5); the view following the kind; the header toggle and History hidden until started (§3.6) |
| `web/src/components/ui/ToggleGroup.tsx` | The segmented control, with its `disabled` prop |
| `web/src/components/Settings/sections/SessionSection.tsx` | The default kind setting (§5) |
| `web/src/lib/sessionStore.ts` | `NEW_SESSION_TITLE` and `isPlaceholderTitle`, which also accepts `New Chat` (§2) |
| `server/ws/rpc_session.go` | `session.set_canvas` and the default applied at `session.create` (§4.1, §4.3) |
| `server/session/store.go`, `server/session/types.go` | `Started`, `MarkStarted`, `SetCanvas` (§4.2) |
| `server/chat/client.go`, `server/process/manager.go` | Marking `Started` on the first delivery; closing a process spawned for the other kind (`CloseIfCanvasDiffers`) |

## 1. The rule

**The kind is fixed when the agent is first told anything, not when the row is
created.** [canvas-ui.md §1](canvas-ui.md#1-the-rules) fixes the property so an
agent that was told one thing never lives in a session that became another.
Nothing is told to any agent before the session's first message is delivered,
so until then the kind is a draft of the session — like the engine, which
`session.set_agent_type` already lets the user change on a session that has
not started — and from then on it is fixed for good.

"Started" is one server-side fact, `SessionMeta.Started` (§4.2): set under the
store lock immediately before the first message is delivered, never cleared,
true from birth for a fork. The chooser exists exactly while it is false; the
server refuses a change exactly while it is true.

## 2. One New Session button

```
┌───────────────────────────────────────┐
│ [ +  New Session              ]  [⋯]  │   L1 primary, then the session filter
└───────────────────────────────────────┘
```

- **One button, named `New Session`**, in the place and classes the New Chat
  button had (`SessionsTab`: L1, `bg-th-accent`, `flex-1`, `Plus`). The
  **Canvas** button that stood beside it is gone. A session is no longer born a kind the user has
  to pick before seeing it; the row gets back the width the second button took.
- **No kind in the request.** The button calls `createSession()` with no params;
  the server applies the project's default (§5). The kind is chosen inside the
  session (§3), so the button needs no menu, split part or long-press.
- **One create in flight.** `sessionCreate.ts` has a single
  in-flight slot: every create asks the same question (no kind), so a double
  tap, the effect that re-runs mid-request and a prefill handoff
  ([agent-handoff-ui.md §1.4](agent-handoff-ui.md#14-no-current-session)) all
  join one request. There is no per-kind split: a chat session *can* become a
  canvas one later, so it is an answer to any caller, and Retry after a failed
  create is simply a create again. The
  worktree check on joining stays.
- **The placeholder title is `New Session` too** (`store.go`'s initial
  `Title`, `NEW_SESSION_TITLE`): a canvas session listed as `New Chat` would be
  the same misnaming. Sessions stored under the old `New Chat` title
  are still read as placeholders ([agent-chat.md](agent-chat.md)'s secondary
  colour): the frontend's placeholder check (`isPlaceholderTitle`, read by
  `SessionHeader` and `ChatPanel`) accepts both titles. The server only writes the title; it compares none. No
  migration rewrites stored titles.

## 3. The chooser on the empty state

### 3.1 Where it is

The chooser replaces the muted line of the empty state, in **whichever view the
session is in** — and the view follows the kind:

| Kind | View it is in | The line it replaces | Before start |
|---|---|---|---|
| Chat | chat view, the ordinary composer below | `Start a conversation...` | the chooser, Chat lit |
| Canvas | canvas view, the collapsed input below | `Nothing drawn yet` | the chooser, Canvas lit |

It sits where the line sat — centred in the area between the header and the
input — so pressing the other kind leaves the chooser where it is and changes
the screen around it: the composer becomes the collapsed line or the other way
round. It is one component (`SessionKindChooser`), rendered by `MessageList`'s
empty branch (before `CustomEmptyState`, which an extension may still put under
it) and by `CanvasView`'s revision-0 branch.

```
Phone, chat (360px)                    Phone, canvas
┌──────────────────────────────┐       ┌──────────────────────────────┐
│ ☰  New Session ⌄          ⚙ │       │ ☰  New Session ⌄          ⚙ │
├──────────────────────────────┤       ├──────────────────────────────┤
│                              │       │                              │
│  SESSION                     │       │  SESSION                     │
│ ┌──────────────────────────┐ │       │ ┌──────────────────────────┐ │
│ │ [💬 Chat ] │  ▦ Canvas    │ │       │ │  💬 Chat   │[▦ Canvas ]  │ │
│ └──────────────────────────┘ │       │ └──────────────────────────┘ │
│  You and the agent talk in   │       │  The agent draws a page and  │
│  a transcript.               │       │  you work in it.             │
│  Can be changed until you    │       │  Can be changed until you    │
│  send the first message.     │       │  send the first message.     │
│                              │       │                              │
├──────────────────────────────┤       ├──────────────────────────────┤
│ [+] [ Message…          ] ➤ │       │ [ Message…                 ] │
└──────────────────────────────┘       └──────────────────────────────┘
```

On a desktop it is the same block, `max-w-sm` and centred in the pane; nothing
changes shape by width ([canvas-ui.md §2.1](canvas-ui.md#21-the-view-switch)'s
reasoning: one control to learn on both devices). On a phone it takes the
column width less the pane's usual `px-4`. With the soft keyboard up the area
shrinks; the block stays centred and the area scrolls if it is shorter than the
block (a phone in landscape), never covering the input.

### 3.2 What it is made of

**`ToggleGroup`**, the settings' instant-apply segmented control, used as it is
— not a new control. It already is what this needs: one segment per value, the
stored value lit, no optimistic state of its own, a refusal shown as `error`
under it, and a skeleton while the value is not known. Reusing it means the
chooser and the setting (§5) are visibly the same choice.

- `label="Session"` (its uppercase muted label; also the group's `aria-label`).
- Items `chat`, `canvas` — `MessageSquare` / `Chat` and `PanelsTopLeft` /
  `Canvas`, the glyphs the header uses for the chat and the session list uses
  for a canvas row.
- `hint`: the lit kind's one line — Chat `You and the agent talk in a
  transcript.`, Canvas `The agent draws a page and you work in it.` Under it,
  outside the group, one more muted `text-xs` line, the same for both: `Can be
  changed until you send the first message.` This is the line that says the
  choice is not forever *yet* — and that sending is what fixes it.
- `selected` is the session's stored `canvas` (detail, else the list row —
  both carry it, [canvas-ui.md §13.1](canvas-ui.md#131-the-session-option));
  `valueState` is `pending` until either has arrived, so
  the group never claims a kind it has not heard.
- One addition to `ToggleGroup`: a `disabled` prop, for §3.3's request in
  flight. It is `aria-disabled` (dimmed, presses ignored) rather than the
  native attribute, which would drop the focus §3.3 keeps on the segment. The
  settings do not pass it.

How the current kind reads: the lit segment (`bg-th-bg-tertiary`, primary text,
`aria-pressed=true`), the hint that names it, and the screen itself — the
composer or the collapsed canvas line is already the kind. A screen reader
hears `Session, group; Chat, toggle button, pressed`.

### 3.3 Pressing the other kind

1. The group is `disabled` for the length of the hold below; no spinner — the
   round trip is one RPC, and a spinner on every fast press is noise. Pressing
   the lit segment sends nothing (it only clears a refusal line, §3.4).
2. `session.set_canvas` (§4.1). The lit segment moves when the session's
   `canvas` comes back changed (detail push), not at the press — ToggleGroup's
   rule, so the lit segment is always the server's answer.
3. The view follows the stored kind: to Canvas puts the session on canvas view
   (the view a canvas session opens on, [canvas-ui.md §2](canvas-ui.md#2-the-screen));
   to Chat leaves the canvas screen for chat view. Nothing is pushed onto
   history. This happens only before the start: once the session has started,
   a kind arriving late (a lagging detail) never pulls a reader off the view
   they chose.
4. The draft is kept. Both views edit the same draft (`inputStore`), so text
   typed under one kind is still there under the other; the composer collapses
   into the canvas line with it, as switching views does today.
5. Focus stays on the segment pressed: the chooser drawn in the other view is
   a new one, and it focuses its lit segment as it mounts. Chat view's composer
   does not grab the caret on this switch (`focusOnOpen` is off while the user
   is choosing): the user is choosing, not typing.

**Sending while a switch is in flight waits for it.** Send (and Enter, and an
extension empty state's hints) is held until `set_canvas` has answered **and** the stored kind has moved, so the first
message is delivered to the kind on screen — and carries `canvas_size` exactly
when it is a canvas message. The reply and the detail push travel apart and
land in either order, so waiting for the reply alone could let Send go out
under the kind the screen is leaving. Any move counts, not only to the kind
asked for: another device may have switched it back meanwhile, and waiting for
the asked kind would then hold Send for good. The hold is the composer's
ordinary disabled Send; it lasts one round trip. (The server judges
`canvas_size` against the kind the send itself fixes and drops it for a chat
session, so a stray size is harmless; the hold keeps the screen honest.)

### 3.4 When the switch fails

The reason goes in the group's own `error` line (`role="alert"`, `text-th-error`),
under the segments and their hint, above the fixed line — not in the chat's
setting error bar: the user's eyes are on the chooser, and it is the chooser's
write. The lit segment stays on the stored kind, which is still the truth; the
error clears on the next press, on either segment, or when the chooser goes
away.

| Server answer | Line |
|---|---|
| `session_started` (§4.1) — the first message got there first, from this device or another | `This session has already started, so it stays a {chat\|canvas} session.` The chooser then disappears as `started` arrives (§3.5), and the error with it: there is nothing left to choose |
| any other refusal (`InvalidParams`: `session not found`, or a work session, which is never offered the chooser) | no line: the shell already handles a deleted session by leaving it |
| anything else (a disconnect, an internal error) | `Couldn't switch: {reason}` — and the next press retries |

### 3.5 Once the first message is sent

The chooser is shown while **all** of these hold, and gone the moment any stops:

- the session is not `started` (§4.2) — nor `activated`, which stands in for
  sessions stored before `started` existed, as on the server;
- the transcript is loaded and empty;
- the session is not read-only (another worktree) and not a work session
  (`work_id` absent on the detail, or on the list row until the detail
  arrives; §4.1: the work system's sessions are always chat, and start at
  once).

"Empty" counts messages, not records: a history holding only a
`process_ended` record (a process closed by a switch, or by an engine change)
is still an empty transcript.

So it goes **at the press of Send**: the send's echo is put in the transcript
at once (`deliverEcho`), before the server answers or `started` arrives, and
the user sees the choice freeze where they made it. A refused send takes its
echo with it; nothing was delivered, `started` is still false, and the chooser
comes back with the draft.

In canvas view the chooser does not wait for the canvas state: it is drawn
whether or not a `chat.canvas_state` has arrived, where the blank area of
[canvas-ui.md §2](canvas-ui.md#2-the-screen) would otherwise be.

After it goes, each view shows what it shows for a started session today:

- Chat — the transcript, the user's message first.
- Canvas — `The agent is drawing…` while the turn runs, then the page;
  `Nothing drawn yet` only if the turn ends having drawn nothing.

### 3.6 The header and the session list before the session starts

The stored kind is real from the first moment — the default (§5) is written at
create — so everything that shows the kind shows the stored one, live:

- **Session list glyph**: the canvas row's `PanelsTopLeft` (and `, canvas` for
  a screen reader) follows the stored value, so it appears and disappears as
  the user switches. The row exists so the session screen opens on the right
  view before detail arrives; following the stored value keeps that true.
- **The header's Chat view toggle** ([canvas-ui.md §2.1](canvas-ui.md#21-the-view-switch))
  and **the session panel's Canvas section** (History) are **absent until the
  session has started**, even on a canvas one. The toggle is the detour to the
  transcript; before the first message there is no transcript to go to, and a
  `Chat view` toggle above a chooser offering `Chat` would read as the same
  choice made twice — pressing one would seem to have done the other. History
  has no page to open (revision 0). Both appear with `started`. The canvas
  view's own History button in its input line is not this section: it is drawn
  before start as at any revision 0, `aria-disabled`. the header's
  title is the only flexible box on the row, so the title gives way when the
  toggle appears, as it does when any header control comes and goes.

## 4. The contract

### 4.1 `session.set_canvas`

```
session.set_canvas { session_id: string, canvas: boolean } -> {}
```

Beside `session.set_agent_type`, in `ws/rpc_session.go`, and shaped like it:

- Refused with `CodeInvalidParams` and data `{ reason: "session_started" }`
  (`replyErrorData`, as the auth errors carry theirs) when the session has
  started (`Started || Activated` — `Activated` covers sessions
  created before `Started` existed; §4.2). The message: `cannot change session
  kind after the session has started`.
- Refused for a session the work system created (they are never canvas
  sessions, canvas-ui.md §13.1; `work.Store.FindBySessionID` tells), and for
  one that is not found.
- Setting the value it already has is a successful no-op.
- **Order: write, then close what is stale.** The store write
  (`Store.SetCanvas`) re-checks `Started` under the meta lock, so it and the
  send's `MarkStarted` are ordered. Only after it is accepted is the session's
  process closed, and only if it was spawned for the other kind
  (`process.Manager.CloseIfCanvasDiffers`, judged under the manager's lock). A
  process can exist for an unstarted session (one spawned for a send that was
  then refused) and it carries the old `--canvas`. A switch that loses to a
  send is refused and closes nothing, so the process just told the old kind
  keeps the session. A process spawned from the new value is never closed by
  the switch or by a send. (Closing *before* the write, as first designed, can
  kill a process a send has just delivered to, when the send marks `Started`
  between the switch's check and its close.)
- Switching to canvas pushes `chat.canvas_state { revision: 0 }` to the
  session's chat subscribers, so the canvas store holds a state for a session
  it was not told about at subscribe (`chat.messages.subscribe` answers
  `canvas` only for a canvas session). Without it the canvas area of a session
  switched and then started would stay blank until the first drawing, instead
  of reading `The agent is drawing…`. Switching to chat pushes nothing; the
  client stops reading the canvas store for the session when its kind is chat.
- The session's list item and detail are pushed as for any meta change.

### 4.2 `SessionMeta.Started`

```go
// Started is set immediately before the first message is delivered to the
// session's agent, and never cleared. Canvas can change only while it is false
// (docs/new-session-ui.md §1).
Started bool `json:"started,omitempty"`
```

- Set in `chat.Client.sendEvent` **after** its refusal checks and **before** the
  record is appended and the prompt delivered, by a store call that sets it
  under the meta lock and returns the meta. If the process `sendEvent` holds was
  started with a different `Canvas` than that meta's (`Process.Canvas`, the
  value it was started with), it is closed through the same
  `CloseIfCanvasDiffers` and a new one taken, in a loop, since a concurrent
  send may have spawned another from a meta read before the switch. This is
  a switch landing between the spawn and the mark. The canvas size a message
  carries is judged against the same meta and dropped for a chat session. Every sender goes through it: typed messages, canvas
  actions, commands, system messages (a work kickoff starts its session).
- `CreateFork` sets it: a fork's history has been told to an agent, and its
  kind is copied from the source (unchanged).
- Carried on `SessionListItem` (`started?: true`) and, through the embedded
  meta, on `SessionDetail`. The client reads it from detail, falling back to
  the list row, as it reads `canvas`.

Not `Activated`: that becomes true when the agent *produces output*, which can
be long after it was told the kind — or never, for a first turn nobody heard
back from. Changing the engine on such a session is allowed and safe (the old
CLI is closed and the new one resumes nothing); changing the kind is not, since
the agent has been told the guidance and tool list of one kind.

### 4.3 `session.create` and the default

```
session.create { canvas?: boolean } -> SessionListItem
```

`canvas` absent means **the project's default** (§5), resolved by
`handleSessionCreate` where it already applies the default engine and mode;
present means that kind. `rpc.SessionCreateParams.Canvas` becomes `*bool` so
absent and `false` can be told apart. The app sends no params (§2); the explicit
form stays for callers that must have one kind (tests, an extension). Sessions
the work system creates are chat whatever the default says.

### 4.4 Everything that reads the kind

All of them read `SessionMeta.Canvas`, and none of them can read it while it
still changes in a way that matters, because each reads it only once the agent
has been, or is being, told:

| Reader | When it reads | Why it sees the final value |
|---|---|---|
| `StartOptions.Canvas` → the MCP proxy's `--canvas`, the guidance (`GuidanceFor`), Codex's thread instructions | process spawn | a process spawned before the switch is closed by it (§4.1); a spawn after `Started` reads the fixed value |
| The tool refusals (`Sessions.ResolveCanvas`) | at each tool call | a tool is called only in a turn, which only a delivered message opens |
| The CLI question refusal wording (`CLIQuestionRefusalFor`) | process spawn, from `StartOptions.Canvas` | as the first row |
| `CreateFork` | at the fork | a fork needs an anchor message, so its source has started |
| The list glyph, the opening view | live | they show the stored value as it changes (§3.6), which is the point |
| The header's view switch, the session panel's Canvas section | live | absent until `started` |

The list item and detail now carry a value that can change before `Started`,
so they are not copies of a birth fact the way `forked_from` is. Both are read
from the one stored record and pushed by the same update, so they pass the
subscription rule on the terms `title` and `turn` do
([code/subscription-system.md](code/subscription-system.md#why-a-session-is-two-subscriptions)).

## 5. The default kind setting

```
Settings → Session

  ENGINE        [Claude · Opus · High ⌄]
  New sessions start with this engine. …

  MODE          [ Default | YOLO ]
  …

  NEW SESSIONS  [ 💬 Chat | ▦ Canvas ]
  Each new session can still be switched before its first message.
```

- **Per project, on the server**: `Settings.DefaultCanvas bool`
  (`json:"default_canvas,omitempty"`), next to `DefaultAgentType` and
  `DefaultMode`. Those are the defaults "new sessions start with", and they
  live in the project's server settings, not on a device: the default is
  applied by the server at `session.create` (§4.3), so every client and every
  create path — the button, a prefill handoff from the Git screen, another
  device — gets the same kind. A per-device default would make the same press
  create different sessions on the phone and the desktop, and would need the
  kind back in the request, which §2 keeps out of it. Absent is `false`, chat — what
  every project does today.
- **Where**: `SessionSection`, after Mode — a `ToggleGroup` with
  `label="New sessions"`, the same two items as the chooser (`sessionKind.ts`),
  and the hint above.
  It applies on tap with `updateSettings({ default_canvas })`, its refusal in
  its own `error` and its waiting state from `useGlobalSettingsStatus`, exactly
  as Mode does.
- It decides only what a new session *starts as*: changing it touches no
  existing session, started or not.

## 6. Considered and not done

- **The choice in the header** (a kind toggle beside the title until the first
  message). The header is the session's identity and the app's controls;
  a choice made once, before anything has happened, belongs on the empty
  screen where the user is looking, and the header would have to change shape
  when it went away. The user asked for it on the empty state.
- **A split New Session button or a kind menu on it.** It brings back the
  choice before the session exists, which is what this change removes.
- **Cards with an illustration of each kind.** More persuasive on a first use,
  but a new control, taller than a phone's empty area with the keyboard up, and
  a different control from the setting. The segmented control plus one line
  says the same.
- **Optimistic switching.** The view would flip and then flip back on a
  refusal — which is exactly the race (§3.4) where a refusal is likely.
- **Fixing at `Activated`.** See §4.2.
