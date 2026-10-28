# Agent Chat

Users interact with AI agents through natural language conversations. The system manages bidirectional communication with persistent agent processes (Claude CLI, Codex CLI) via WebSocket JSON-RPC.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──spawn──▶ AI CLI (subprocess)
                              │                     │
                         ChatClient            stream-json
                              │                     │
                         ProcessManager ◀───── AgentSession
```

- **ChatClient** (`server/chat/`) — Coordinates session/process management, persists messages to history, broadcasts events to all WebSocket subscribers.
- **ProcessManager** (`server/process/`) — Manages agent process lifecycle. Streams agent events into history and turn state, and runs the lease reaper that decides how long a process may be held ([the lease table](code/agent-integration.md#the-lease-table)).
- **Agent Session** (`server/agent/`) — Common `Session` interface implemented by each backend (`agent/claude/`, `agent/codex/`). Handles subprocess spawning, stream-json parsing, stdin messaging.

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_chat.go` | `chat.message`, `chat.interrupt`, `chat.messages.subscribe` / `chat.messages.history` ([paging](#history-paging)), permission responses |
| Session config | `server/ws/rpc_session.go` | `session.set_agent_type` / `set_mode` / `set_model` / `set_effort`, each closing the running process because a CLI is told these only at launch; `session.models` and `session.efforts` list the choices ([models](code/agent-integration.md#session-models), [effort](code/agent-integration.md#session-effort)). None of them answer with the new value: the settings in force reach the panel through `session.detail` ([why](code/subscription-system.md#why-a-session-is-two-subscriptions)) |
| Another worktree's sessions | `server/ws/rpc_session_view.go` | `session_view.*` — reading (and discarding) a session stored under a worktree the connection is not in, including one that no longer exists ([how](#sessions-outlive-their-worktree)) |
| Attachments | `server/ws/rpc_attachment.go` | `attachment.get` — the content a chat event references by id, answered in `file.get`'s own shape so one client path renders both ([why](code/agent-integration.md#content-blocks-and-attachments)) |
| Sending files | `server/filetransfer/attachment.go`, `server/chat/attachments.go` | `POST /api/chat/attachments` stores a file in the session's store; `chat.message`'s `attachments` names it by id and each agent delivers it its own way ([how](code/agent-integration.md#files-the-user-sends)). Client side: `web/src/lib/chatAttachments.ts`; the composer's `+` menu (Photos / Files), a drop on the chat or a paste into the composer ([how](#attaching-by-drop-or-paste)) uploads each file as it arrives (`inputStore`), holds Send until every one is stored, and takes the files back if the message is refused |
| Chat client | `server/chat/client.go` | Session coordination, message persistence, event broadcast; `SendMessageExcluding` (user) and `SendSystemMessage` (system automation) share one persist+broadcast path |
| Agent interface | `server/agent/agent.go` | `Session` and `AgentEvent` interfaces |
| Claude impl | `server/agent/claude/claude.go` | Claude CLI subprocess, stream-json parsing, MCP server config |
| Process manager | `server/process/manager.go` | Process lifecycle, event stream, lease reaper |
| Frontend panel | `web/src/components/Chat/ChatPanel.tsx` | The session screen: the header (`SessionHeader.tsx` — the session's title, and the panel behind it holding engine, permission mode, work and usage; over a page, the page's own heading, `Layout/PageHeader.tsx` — [why](#the-session-screen)), the transcript and the composer (`InputBar.tsx`) ([layout](#the-session-screen)) |
| Transcript | `web/src/components/Chat/MessageList.tsx` | Rendering the loaded messages, and every scroll decision made over them: [where the view sits](#where-the-view-sits) (with `useTranscriptScroll.ts` and `scrollAnchor.ts` beside it), the reserve (`HistoryReserve.tsx`) and trigger behind [history paging](#history-paging), and the jump to a pending permission request ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)) |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission handling, and the session's unanswered questions |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage` (which carries `answering` when it is an answer, [answering-ui.md §3](answering-ui.md#3-the-answer-panel)), `interrupt`, `permissionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC (files it carries were uploaded beforehand and are named by id — [how](code/agent-integration.md#files-the-user-sends))
2. ChatClient persists message to session history, forwards to `Process.SendMessage()` — unless the turn is holding a permission request open, the one state a message cannot be delivered in, which is refused as `InvalidParams` with nothing written ([lifecycle.md](lifecycle.md#session-one-reducer)). A turn merely *running* is not refused; the message steers it, and the answer to it begins where the agent reads it rather than where the turn ends — for an agent that cannot report that moment itself, this is also where the read point record is written ([agent-event.md](agent-event.md#the-read-point-message_ingested)).
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, Done, etc.)
5. Events are broadcast to all WebSocket subscribers and persisted to session history
6. On `Done` event, process transitions to `idle`

Besides user-typed messages, the Work system pushes automatic prompts to the same session via `Client.SendSystemMessage`; these are tagged `origin: "system"` with a `meta` summary naming the work, so the frontend can render each as a one-line work event where it happened instead of as a user bubble. See [agent-event.md](agent-event.md#message-origin-user-vs-system) and [code/work-system.md](code/work-system.md#work-messages-in-chat).

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

A question does not block the agent, and its card is pushed out of view — often out of the loaded pages entirely — by whatever the agent streams next. So answering does not happen on the card: the unanswered questions are session state, answered in a card that puts itself up over the transcript — dimming that rectangle alone, and leaving the header, the strip and the composer lit and usable — and reached again, once it is closed, from a strip above the composer. That whole surface is [answering-ui.md](answering-ui.md); the card in the stream is only the record of what was asked.

## The Session Screen

Three bands, top to bottom: the header, the transcript, the composer. Nothing
else is permanent — the attention strip and the composer's error bar come and go
between the last two ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)).

```
[☰] [ Session title ˅        ] [●] [▭] [⚙]   header, h-11 / sm:h-12
    [ Opus · Default         ]
┌─────────────────────────────────────────┐
│        transcript (reading column)   [↓]│
└─────────────────────────────────────────┘
    [+] [ Type a message...        ] [↑]     composer
```

**The header names the session** (`Chat/SessionHeader.tsx`, handed to
`MainContainer` as its `heading`). The title is one button with a second line
under it: the model — the agent's name when the model is Auto, since "Auto" says
only that the CLI decides — and the permission mode in `getSessionModeInfo`'s
words. The engine truncates first; the mode, which says whether the agent's own
permission settings still stand, stays whole. Until the session has described
itself the second line is a skeleton rather than a placeholder "Default", so a
session with every gate down never wears the name of one that keeps them. A
session still called `New Chat` reads as a placeholder (secondary colour), and
one whose title has not arrived yet is a skeleton too; one read out of another
worktree says `Read-only` instead of an engine, and `Unavailable session` if it
cannot be read at all. A route naming no session has nothing to describe, so the
header keeps the project's name and offers no button. The project's name
otherwise lives in the sidebar's worktree switcher.
The preview button (`▭`) is there only when the relay is on
([port-preview.md](port-preview.md)).

**Over a page, the header names the page.** Whatever is on screen gets one
header, and it is about that screen. A page opened over the chat — a diff, a
file, a commit, Settings, the Project list or a work item, the agent roles — is
a page of its own, so its header carries no session: no title, no engine or
mode, no panel to change them from. A project-level page under a session's name
read as belonging to that session, it stacked a second bar under the first on a
phone, and it offered YOLO from a screen that had nothing to do with the
session.

```
[☰] [💬] [ ChatPanel.tsx ›      ] [●] [▭] [⚙]
         [ web/src/… · Unstaged ]
```

The page draws its heading with `Layout/PageHeader.tsx`, and the header hosts it
in the session title's place (a portal into `MainContainer`'s `heading`): the
title and the way back come from the page's own data, so `ChatPanel` keeps no
second, per-type copy of them. Rendered on its own — in a unit test — the same
heading draws as a bar where it stands. The sidebar button stays: on a phone it
is the way from one diff to the next file in the list. Its dot and the one on
"Back to chat" may be lit together, and say different things — the first
stands for the sidebar's tab badges
([responsive-ui.md](responsive-ui.md#at-expanded-the-column-collapses)), the
second for the open session's own unread. The way back is
`MessageSquare` ("Back to chat", with the unread dot) on a page opened from the
chat, and `ArrowLeft` labelled with where it goes (`Back to commit`, `Back to
project`) on a page opened from another page; both are borderless icon buttons
like the sidebar and settings buttons. Then the same two lines in the same box
as the session's (`ui/HeaderTitle.tsx` is shared by both). A title that can be pressed
ends in `ChevronRight`, and one that cannot has no chevron and no hover. A file
name keeps its extension when it truncates (`ChatPanel.integration.te….tsx`).
The second line ends in what says which version of the thing this is (`Staged`,
`Editing`, a short hash), in words rather than a colour, and that part is kept
whole while the folder before it truncates; the whole text is in the title
box's `title`. Each line is a skeleton until its own data arrives, never a
stand-in — a commit's hash shows at once, its subject when it loads — and while
a Git page waits on the repository check the way back and both lines are
skeletons. A page whose kind is still
unknown waits the same way — a work item's title is `Story` or `Task` once it
has loaded, a skeleton until then — but one whose data is never coming (a work
item that failed to load) gets a plain title (`Work`) rather than a skeleton
that would spin forever. Every page over the chat draws its heading this way,
so none keeps a bar of its own under the header.

On Settings the header has no settings button: it would only reopen the page the
user is on, so `ChatPanel` passes no `onOpenSettings` there and a custom
`HeaderContent` sees it absent too.

**The mode is there to be read, not announced.** Many users run YOLO all day; for
them it is the normal state, not an exception, and a mark that keeps warning
about a choice made on purpose is one they learn to look past while it goes on
pulling at the eye from the top of every screen. So the second line is one muted
line (`text-xs text-th-text-muted`) in every mode, and the only colour on it is
the mode's glyph: YOLO's `Zap`, `size-3`, in `text-th-warning`, with the word
beside it muted like the engine's; Default has no glyph, since the mode that
changes nothing needs no mark. That is less than the old mode bar's button
spent — it tinted the word as well, on a bordered button down by the composer —
and that much was already enough: one small spot of colour is findable by
anyone who looks for it and too small to catch an eye that is not looking.
Nothing more is added: no tinted word, no pill, background or border, no extra
line, and nothing that differs by width — the phone header and the desktop one
carry the same line.
The glyph is `aria-hidden` and the word is what the accessible name says, so the
colour carries nothing the text does not — which is what lets it stand in the
light themes, where `th-warning` is too pale to clear the non-text 3:1
([sidebar-ui.md](sidebar-ui.md#visual-weight) has that token fault).

**The title opens the session panel** — a `ResponsivePanel`, a bottom drawer below
the expanded tier and a dropdown under the title at and above it. It holds, in
order, what decides the next message and then what describes the ones sent:

- **Engine** — one row summarising agent, model and effort, which drills into the
  three lists (`Chat/EngineSections.tsx`) in the same panel, with a `‹ Engine` row
  back. On a phone, three lists side by side would leave the drawer showing
  nothing but the engine.
- **Permissions** — Default / YOLO, two rows, in place, each with its glyph
  (`Shield`, `Zap`) and its description, coloured by the second line's rule
  above. What a choice costs is said by the description ("Skips all
  permissions"), at the one moment it is being made.
- **Work** and **Usage** — the session's facts
  ([usage-display-ui.md](usage-display-ui.md),
  [work-system.md](code/work-system.md#session-to-work-navigation)).

A change that succeeds leaves the panel open — a radio group moves its selection
with the arrow keys, and closing on select would leave a keyboard user only the
neighbouring choice. One that fails closes it, and the reason shows in the bar
above the composer. Over a page the header names that page, not the session
([above](#the-session-screen)), so neither the panel nor that bar is shown
there; the bar comes back with the chat. While a turn is open (the server
takes no setting change then) or the settings are still loading, Engine and Permissions stay listed but
unavailable, each saying why. On a read-only session they are not listed at all:
what is missing there is the execution environment, not a moment's availability.

**The composer is one row**: `+`, the textarea, and one slot that holds Send or
Stop — never both ([lifecycle-ui.md §2.3](lifecycle-ui.md#23-chat-composer-and-stop)
has the rule and the 500ms arming). The textarea grows upward and the row is
`items-end`, so both buttons stay with the last line, under the thumb. The `+`
menu (`Chat/ComposerMenu.tsx`) hangs above `+` at every width — three rows do not
earn a sheet — and pressing `+` does not take focus from the draft, so a soft
keyboard does not drop and rise again:

- **Commands** — what typing `/` does: puts `/` in front of the draft, which opens
  the command palette when the result reads as a command name (an empty draft
  does). The menu row is how a phone user learns commands exist at all.
- **Photos** / **Files** — the system pickers (`accept="image/*,video/*"` reaches
  the photo library on a phone; `image/*` alone hides its videos, screen
  recordings included). Each file uploads as soon as it is picked and waits
  in a strip above the row (`Chat/ComposerAttachments.tsx`) with a spinner and a
  progress bar while it uploads (a large video over a slow link takes minutes, and
  a bare spinner cannot be told from a stuck one), a remove button that also
  aborts an upload still in flight, and — on failure — the reason written out, since a `title` is
  out of reach under a thumb. Send waits until every file is stored; a failed one
  has to be removed first, so nothing picked is dropped silently. A file over
  the server's ceiling is refused at pick time, before any upload, with its
  own size beside the limit ("600 MB, over the 512 MB limit"): for a long screen recording,
  how far over it is says how much to trim. How the
  files travel is in [Key Files](#key-files).

  The preview is of the local file, through a `blob:` URL the store releases
  with the entry, so nothing waits on the upload. An image is its own picture —
  up to `max_image_preview_size` from the `auth` reply: the browser decodes an
  image whole, so one past it is a chip with its size, as it will be in the
  transcript ([file.md](file.md#operations)). Past those images, nothing here
  reads a whole file into memory: the upload sends the `File` as it is, and a
  video or audio preview reads only as far as it needs.
  A video is its first frame (`#t=0.001`, `preload="metadata"`, `muted
  playsInline` — what iOS needs to paint one and read no further) in the
  image's square box, with its length and, once uploaded, a play mark; a frame
  that is late or never comes (iOS may not preload a `blob:`) moves nothing.
  An audio file is a chip with a play button, so a voice note can be checked
  before it goes — even while it uploads, since the spinner veils only the
  chip's text — and it takes part in [one sound at a
  time](file.md#playing-audio-and-video). A file the browser cannot open (HEIC
  outside Safari), or a video it can draw no picture of (HEVC in a Chromium
  without it, which opens without an error and plays its sound over black),
  falls back to a plain chip that says it can't be previewed; it is still sent.

Files can also be dropped anywhere under the header or pasted into the
textarea; both are shortcuts for these two rows and follow their rules
([Attaching by Drop or Paste](#attaching-by-drop-or-paste)).

The menu and the palette are exclusive, and both follow the overlay conventions
of [answering-ui.md §4](answering-ui.md#who-owns-escape) ([and the click](answering-ui.md#who-owns-the-dismissing-click)).

**The conversation is a reading column**, `max-w-3xl` (768px) centred, shared by
the transcript, the composer's inner row (with the palette and the menu hung off
it), the attention strip's content and the error bar's: `+` lines up with the
messages' left edge and Send with their right. Borders and backgrounds stay full
width, and so does the transcript's scroll box, so its scrollbar sits at the
window's edge and the wheel works over the margins. The header is not
constrained: it is the window's chrome. With the sidebar open at its default
320px, the column only starts to bind at a window of roughly 1090px, so phones
and tablets are untouched. The scroll-to-bottom button belongs to the column too
([Where the View Sits](#where-the-view-sits)).

**Only the user speaks in bubbles.** The agent's message has no bubble: its text,
tool calls and cards run the full width of the column in `text-th-text-primary`,
and below them a turn-end row (`Chat/MessageActions.tsx`) holds Copy and
Fork — while the turn is running, the tail line (`Working 1m 4s`)
stands in that row's place instead
([turn-progress-ui.md](turn-progress-ui.md#2-the-tail-line)). A turn that
changed files lists them just above the turn-end row, each opening on its
diffs ([tool-call-ui.md](tool-call-ui.md#the-turns-changes)). The user's
bubble keeps the `…` slot beside it. Why the two sides differ is in
[session-fork-ui.md](session-fork-ui.md#entry-point). What the agent thought on
the way is a muted `Thought for 12s` row in the reply, among the tool rows or on
its own ([turn-progress-ui.md](turn-progress-ui.md#1-the-thinking-row)).

## Attaching by Drop or Paste

Besides the `+` menu ([above](#the-session-screen)), files reach the composer
two more ways: dropped onto the chat, or pasted into the textarea. Both are
shortcuts for the menu's Photos / Files, so they add no rules of their own:
every file goes through `attachmentActions.add`, with the same size limit, the
same failed chip and the same Send that waits for every file. Drop and paste
end in one function in `ChatPanel` (`attachFiles`) and are taken or refused by
one decision (`dropRefusal`).

**A drop is taken exactly when the default composer is on screen and its `+`
can be used** — files never go into a draft the user cannot see. `canSend` is
not part of it: being disconnected, loading history or waiting on "Allow or
deny to send" holds back the send, not the attaching. When a drop is not taken,
the first of these that holds is the reason given:

| # | Situation | Reason shown |
|---|-----------|--------------|
| 1 | Read-only session | `Read-only — files can't be attached here` |
| 2 | The route names no session | `Open a session to attach files` |
| 3 | A page that hides the composer (the Work pages, agent roles, the Git workspace's lists — `overlayKeepsComposer`) | `Go back to the chat to attach files` |
| 4 | A registry `InputBar` replaces the default one | `This message box doesn't take files` |
| 5 | The session has not resolved yet | `Wait for the session to load` |
| 6 | The composer is folded: a short screen with the answer card focused | `Close the question card to attach files` |

The order matters where two hold at once: with no session in the route the
session never resolves, so checking #5 first would say "wait" for ever. #4 is
there because a custom bar's input is its own business — `InputBarProps` has
no way to hand it files — and the only bar that takes a paste is the default
one (`InputBar`'s `onPasteFiles`, a prop of that bar, not of the registry
contract).

### Dropping

**The zone is everything `ChatPanel` hands `MainContainer`** — one wrapper
around the top content, the origin bar, the transcript or page, the attention
strip, the error bars and the composer — so the header (and anything hanging
from it), the sidebar and the Files tab are outside it. A page that keeps the
composer (a file, a diff, a commit, settings) keeps the zone taking drops:
dragging a file in while reading another is the common case.

**Only drags whose DOM target is inside the zone count** (`ownDomOnly` on the
shared [drag hook](file.md#dropping-files-onto-the-tree)). A sheet raised from
in here — the fork sheet, the CLI sign-in sheet, the full-screen tool viewer —
is portalled to `document.body`, but its drag events still bubble up the React
tree to the zone; taking them would put files into a composer behind the sheet
and draw the overlay under it. Those drags are left to the window guard and
its "not allowed" cursor. `useIsPageCovered` would have been the wrong test: it
also counts the composer's own `+` menu and the header's dropdown, so a drag
arriving while either was open would be turned away without a reason. A drag
that carries no files — transcript text dragged into the textarea — is not
touched at all.

**While a file drag is over the zone, an overlay covers it** (`ChatDropOverlay`)
with one centred pill and a paperclip: `Drop files to attach`, with an accent
ring and an accent paperclip, when the drop will be taken, or the reason from
the table on a neutral surface with no ring and a plain paperclip when it will
not, and the cursor says `copy` or `none` to match. The
Files tab docks a bar instead because an overlay would hide the rows being
aimed at; the chat has nothing to aim at. The overlay is `pointer-events-none`
(or the drag would be over it rather than the zone) and `aria-hidden`, has no
animation, and sits inside the zone's `isolate` stacking context: above the
answer card, level with the `+` menu at `z-50` and drawn over it by being the
zone's last child, and below the sheets portalled to the body.

### Pasting

**Only into the default composer's textarea.** A paste is files only when the
clipboard carries files and its `text/plain` is empty — or is nothing but the
names of those files (`readPasted` in `hooks/useFileDragZone.ts`); then the
paste is taken and the files attached, with nothing else changed: no focus
move, the caret and draft left as they were. Any other text wins and pastes as
text, as it always did: copying from a spreadsheet, a document or a web page
brings a rendered picture along, and nobody pasting a table wants the picture.

The exception is what a file manager puts on the clipboard. Copying a file
there puts its name or path beside it as text — Finder the name, GNOME Files
and Dolphin the absolute path or a `file:` URI, one per line; Explorer no text
at all — and what was copied is the file. A line counts only when it is a bare
name, an absolute path or a `file:` URI whose last segment is the name of a
file (or folder) the clipboard carries. Matching the names rather than the
shape of the text is what keeps a browser that hands over only Finder's icon
pasting the name: the icon is not the file. A web address or a relative path
never counts, even ending in a carried file's name.

Known limits, each falling back to pasting the text:

- A browser that exposes no file for a file-manager copy (Firefox in some
  setups) pastes the name; dragging is the reliable way there.
- Nautilus before GNOME 42 writes `x-special/nautilus-clipboard` / `copy` /
  URIs into `text/plain`, which does not match.
- A name that does not survive into the text — an extension Finder hides, if
  its text leaves it out (unverified); leading or trailing spaces; a `\` in a
  Linux name; an unencoded `#` or `?` in a URI.

The reverse case is accepted too: text that is exactly the browser's synthetic
image name (`image.png`) beside a picture attaches the picture, since excluding
that name would break pasting a real file called `image.png`.

Pasted files keep the name the browser gives, so several pastes can share
`image.png`. That is harmless: the session's store keys a file by its content,
and the name only travels beside the id
([how](code/agent-integration.md#files-the-user-sends)).

### Folders

A folder cannot be attached. Dropped (or, where the browser exposes one,
pasted), it is split out by the same `readDropped` the Files tab uses
([why](file.md#dropping-a-folder)): the files beside it are attached
and the folder is reported in an error bar above the composer, in words of the
chat's own (`FOLDER_ATTACH_REFUSED` in `ChatPanel.tsx`), which point to the
Files tab — the place a folder *can* go, since it uploads folders
([Uploading a folder](file.md#dropping-a-folder)). Unlike the session
settings' and commands' bars, this one **stays up over a page**: it shows
whenever the composer does, since a drop is taken over a file or a diff and a
refusal there must still be heard. It sits closest to the composer, below the
other two, and is per session — cleared by its ✕, by the next drop or paste
that brings no folder, by a send, and by switching sessions.

## History Paging

Opening a session does not ship its whole transcript. `chat.messages.subscribe`
replies with the newest page of history and a cursor; scrolling up fetches the
pages before it with `chat.messages.history`. A long conversation is mostly tool
calls and their results, and a client only ever renders the tail of it — sending
the rest costs transport, parsing and memory for records nobody looks at.

| Method | Params | Result |
|--------|--------|--------|
| `chat.messages.subscribe` | `id`, `session_id`, `limit?` | `history`, `has_more`, `next_before_seq?`, `turn`, `tool_activity?` |
| `chat.messages.history` | `session_id`, `before_seq?`, `limit?` | `history`, `has_more`, `next_before_seq?` |

- `history` is the page, **oldest record first**, each record stamped with its
  `seq` — its address in the session's history ([`session.HistorySeq`](../server/session/types.go)).
- `before_seq` is **exclusive**: the reply holds the records immediately older
  than the record it names. Omitted (or `0`) asks for the newest page.
- `has_more` says whether anything older than `history[0]` exists; `next_before_seq`
  is the cursor for that page and is absent once `has_more` is false. The server
  computes the cursor rather than letting the client read `history[0].seq`,
  because a record it could not stamp — one that is not a JSON object — carries
  no `seq` at all and would strand paging at that point.
- `limit` of `0` means `session.DefaultHistoryPageSize` (50); anything above
  `session.MaxHistoryPageSize` (500) is clamped. A negative `limit` and a
  `before_seq` naming no record are both refused with an invalid-params error —
  answering an unusable cursor with the newest page would silently restart the
  client's scrollback from the bottom.

- `tool_activity` is what each tool call still in flight last reported doing,
  keyed by `tool_use_id`. It is not part of the page, because that kind of event
  is never recorded — it is the latest value of something still changing
  ([tool-call-model.md](tool-call-model.md#tool_activity-is-not-persisted)) — so a
  client subscribing mid-run would otherwise see a call that has been running for
  half an hour with nothing to say for itself. Absent when no call is in flight.
  The subscription is registered before this snapshot is taken, so an activity
  arriving in between is delivered twice rather than lost, and a latest value
  delivered twice is harmless.

`chat.messages.history` needs no subscription and cannot collide with one. An
older page is settled history: append-only, so it can never change, and every
record a live notification carries is newer than the page subscribing returned.
A client scrolled up therefore keeps paging with the cursor it already holds
while new records stream in below.

### Reading a page on the client

A page is a slice of the record stream, not a slice of the conversation. The
reducer's rules assume it can see the whole stream, and two of those assumptions
stop holding when it can only see a page. Both are repaired in `prependHistoryPage`
([`messageReducer`](../web/src/lib/messageReducer.ts)), where the rest of the
record-to-message rules already live — not in the list component, which would
otherwise have to know what a record means.

**A page does not know what happened after it.** A tool call whose result is one
page newer replays as still running; a question answered later replays as still
waiting. The client keeps every record that settles something recorded earlier —
tool results, permission responses, cancellations, process ends, and a message
carrying `answering` — and replays them over each older page it pulls in. They
are all "update it wherever it is" operations, so replaying them costs nothing
when the target is not in that page either.

The last of those is the only one kept for *half* of itself. An ordinary message
must never be replayed — that would draw a second copy of it — so what is
replayed is the settling it does and not the message, which is what keeps one
record from being two bubbles.

Order matters inside that repair: the page's trailing turn is closed *first*.
The records that ended it are in the page above, so left as it replayed it would
keep a tail line running in the middle of the transcript — and with nothing left
streaming, a later `process_ended` retires only the dialogs and Tasks this page
left open instead of also stamping its status onto a turn that was still running
at this point. What the session is doing is passed in separately rather than
looked for in the page, so every page is retired the same way the newest one
already is — a `process_ended` is written for a session a restart cut short
([agent-integration.md](code/agent-integration.md#restart-repair)), but it lands
at the end of the transcript and says nothing to a page pulled in from further
back. An older page is given `retireAgainstTurn`, not the whole of
`settleAgainstTurn`: how the *last* turn ended is no business of a turn five
pages up, which this page already closed without needing to know
([lifecycle-ui.md](lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)).

The mirror of this is one record the page above has to hand *down*. A record
that only ends a turn — `done`, `error`, `interrupted`, `process_ended` — has
nothing to end when it opens a page, so replaying that page alone learns nothing
from it; the turn it ended is the one the page below trails off on. It is
therefore held as that page's *boundary terminal* and replayed against it, with
its `seq`, before the turn is closed. Without this an interrupted or failed turn
reappears as an ordinary finished one on the way back up — with its error text
gone and any Task it was running still spinning. Output that trails such a turn
cannot reopen it, at a page seam for the same reason it cannot in one stream.

**A page boundary can fall inside one turn.** The older page trails off
mid-answer and the page above opens on content that no `message` event preceded,
and the two halves are joined. Text at the seam goes through the same rule
streaming uses, so the messages either side of it come back as one part, a
paragraph apart, as they would have streamed. What was on screen keeps its
identity through the join, so nothing the user opened closes
([code/frontend-state.md](code/frontend-state.md#part-identity)).

The reducer produces a leading assistant message in one other case, and it is the
one case that must *not* be joined: a page beginning at a read point, where the
agent picked up a message recorded in that page and what follows answers it
rather than continuing the reply below
([code/agent-integration.md](code/agent-integration.md#the-read-point)). That
bubble says so on itself, so the seam can tell the two apart; joining it would
put the later message's answer back in the earlier message's bubble, once per
boundary that lands there.

A turn is the *only* thing a boundary splits and folds back. A work event is
one message where it happened
([code/work-system.md](code/work-system.md#rendering-in-the-transcript)), so it
cannot arrive as two halves. That is not an accident of how it happens to be
rendered, it is a reason for rendering it that way: anything aggregated across
records has to be found and re-anchored at every seam, and an event left where
it landed never does. A subagent's work is the one thing aggregated across
records — it is filed under the call that spawned it — and it is deliberately
*not* re-anchored at a seam: work already drawn stays flat where it loaded when
the call's page arrives, and the call's row only counts it
([code/frontend-state.md](code/frontend-state.md#a-subagents-children)).

Reconnecting re-subscribes and so lands back on the newest page: pages already
scrolled in are dropped rather than stitched back together, since the cursor
chain would have to be replayed from the bottom anyway.

**A page is held by its seam, not by the anchor.** The seam is the bottom edge
of the first loaded row (`Seam` in `web/src/components/Chat/scrollAnchor.ts`). A
page only ever adds content above that edge — rows before the first one, or the
older half of its turn spliced into it from the top, the merge keeping the row's
identity so that it is the same node afterwards
([code/frontend-state.md](code/frontend-state.md#turn-boundaries-and-late-events)).
The rows sit on the bottom edge of the track ([where the view
sits](#where-the-view-sits)), so what a page adds above that edge moves nothing
below it — the reader included — and writes nothing while the view is moving,
which is what lets a page land in the middle of a flick. What can move the edge in that commit is
what changed *below* it: output the agent wrote at the end, committed together
with the page, which moves the seam and the reader alike. How far the edge moved
is therefore how far the reader was carried, and the track's height takes it
back out without touching `scrollTop`. Then the anchor is taken afresh from the
view as it now is; the one held before the page is not carried across it.

Neither of the two obvious measures says the same thing. The content's total
height counts the page and that output together and cannot say which part was
which. The anchor ([where the view sits](#where-the-view-sits)) says it only of an element
the page left alone, and inside a spliced row that may be none of them: the text
at the seam grows from the top of its own part, and the merge rebuilds the row's
parts, so the element the reader was anchored on can have grown above its own top
edge or left the DOM. That is how the anchor used to lose the reader on a splice:
the anchored part was remounted, a fresh anchor was taken at the top of the view,
the view stayed at 0 and the next page was asked for at once.

The seam is recorded every time the view is placed or the reader scrolls, not
when a page arrives: by the time the commit that lands a page is seen, the page
is already laid out above the edge. Recording it on the reader's scroll matters
for one more reason. Layout can change and the reader scroll over it before a
resize observation reaches the list; from then on that layout is where they are,
and a page landing must not count the growth a second time.

Because nothing on the anchor has to survive a page, the first row and its first
part are ordinary candidates, and a reader inside the merged row is held as
finely as anywhere else. If the seam's row is itself gone after the page, the
track is left as it is for that commit and the next is held by whatever the view
now shows — the same answer as an anchor with nothing left
([below](#where-the-view-sits)).

A page count that went *down* is not a page landing, and the transcript reads the
tail again when it sees one. Paging starts over exactly one way — a reconnect
re-subscribes and so lands back on the newest page — and the rows an anchor names
may be in that replacement at offsets it was never measured against. Re-subscribing
clears "a page is loading" with it, the request it discards having learnt by the
time it returns that it no longer speaks for this transcript: a flag left standing
there would leave the transcript refusing to page for good, since refusing while a
page is on its way is exactly how it stays down to one. A reader who never paged
at all has no such edge — their count was already zero — so the state they were in
simply stands, which costs nothing: the replacement usually renders the same rows
under the same ids and the anchor holds, and where it does not, what is left of
it holds the reader, or failing that the view stays where it is.

**Asking for a page is a state, not an event.** While the top of the loaded
history is within one view above the view's top edge (`PAGE_AHEAD_VIEWS` in
`MessageList`), nothing is in flight and nothing has failed, the next page is
asked for. Ahead of the reader rather than when they arrive, so that on a steady
read back up the next page is usually in before they get there; one landing
mid-flick costs nothing, because it goes into [the reserve](#the-history-reserve)
and nothing is written.

Two things notice that state and they answer different halves of it. The
`IntersectionObserver` on the reserve is the only one that can see the reader
*approach*: scrolling commits nothing, so there is no frame in which the list
could have measured it. It watches the reserve with the observer's root stretched
upwards by a view (`rootMargin`), because the reserve's bottom edge is the rows'
top wherever the track puts them — past the track's top included — and its own
top can never be below the view, so the bottom edge is the whole question; the
browser then reports the crossing off the scroll itself, with no work of ours on
any frame of a flick. The measurement of the rows' top taken after every commit —
once the invariant has placed the view — is the only one that can see a page land
without taking that top out of range: a page lands in the reserve and moves
nothing the reader can see, so a short page, or a view taller than a page, crosses
nothing. An observer reports a *crossing*; nothing crossed, so nothing is
reported, and paging would stop a page short of where the reader is heading.

Being asked twice is therefore ordinary, and harmless. A request made while one
is in flight is refused outright, and every request that does go out moves the
cursor further back, so the rule settles at the rows' top out of range or
`has_more` being false however many times it is put. Nothing judges how much a
page added — an empty one, or one whose records all rendered to nothing, simply
leads to the next — which is what removed the last reason to ask whether "the
view moved", and with it the stall that question used to leave behind. The one
state not answered from is a container of zero height: it has not been laid out
yet, and treating that as "the top is near" would ask for history nobody has
come near.

The observer is never rebuilt per page. A fresh observer reports a target already
in range immediately, so rebuilding it is a loop rather than a rule: one page
that leaves the reserve where it was becomes an unbounded run of them. It lives
exactly as long as the reserve node does, except while a failure stands — the
fresh one Retry brings reports at once, which is what a retry wants — and is
attached again when the scroll container mounts. A newest page that replays to
no rows mounts none: the list shows its empty state, with no reserve and nothing
to ask from, until the first live message arrives. What it reports is acted on as
given: a delivered entry was computed at the most recent layout, which is one
this commit's own writes have already gone into.

Whatever has been paged in stays rendered: `MessageList` does not virtualize
([why not](#roads-not-taken)), and a collapsible body it has opened once stays
mounted so that reopening is free (`web/src/components/ui/CollapsibleBody.tsx`). Scrolling back therefore
grows the DOM for as long as the session stays open. That is the trade the
cursor makes affordable — growth happens one page at a time and only as the
user reads back towards it, where replaying the whole transcript on open imposed it on
every session — and a reconnect starts over from the newest page.

### The history reserve

While older history remains, the track keeps room above the oldest loaded row
(`web/src/components/Chat/HistoryReserve.tsx`) for a page to land into without
moving the reader. At rest it is a view tall, never under 96px; mid-flick it is
whatever the track leaves it, down to nothing, as pages and output take its
space ([where the view sits](#where-the-view-sits)). So nothing inside it is laid
out in normal flow: the skeleton is a CSS mask (`.history-reserve-skeleton` in
`web/src/index.css`, the tile in `web/src/assets/history-reserve-tile.svg`) on a
layer placed over the whole reserve, and the failure band is placed against its
bottom edge. Loading, failing and retrying therefore change no layout at all,
and running out moves nothing the reader sees: the reserve's height comes from
the track alone.

The tile repeats upward from the first real row, so the seam with that row is
always the same and any height is cut at the top, where a fade hides the cut.
The skeleton pulses while more history can come, and only its opacity animates:
animating the mask or a shimmer would repaint a viewport-tall area on every frame
of the flick it exists to keep smooth. Reduced motion stills it. Loading is not
announced — pages are fetched without the reader asking and mostly land out of
sight, so a live region would speak on every one — and the skeleton is
`aria-hidden` decoration.

> **Not yet verified on a device.** Whether the pulse repaints every frame
> during an iOS flick has not been checked (Web Inspector → Layers). If it does,
> drop the pulse and keep the still skeleton, which is the reduced-motion look
> already.

A page that fails stills and dims the skeleton — a pulse would say more is on its
way — and puts the reason and a Retry button on the reserve's bottom edge, right
above the oldest row, with `role="alert"`; nothing asks for the next page until
the user presses it. Saying nothing would read as *this is where the conversation
starts* — the one conclusion a failure must not let the user draw — and retrying
on a reserve that has not moved would loop out of sight. A reserve shrunk
mid-flick below the band lets the band rise past the track's top rather than
clipping it; nobody can reach it there mid-flick, and the next rest brings it
back. "Beginning of conversation" is said only on the server's word that nothing
older exists, and only to a user who has actually paged back far enough to
wonder. When history runs out the reserve unmounts and its space is left blank
until the view is at rest, when the track drops it: a skeleton drawn over
"Beginning of conversation" would be false, and the marker itself, mounting
above the reader, moves nothing.

## Where the View Sits

**Two states, and one action.**

| State | Invariant |
|---|---|
| reading the tail | the view is pinned to the end |
| reading somewhere | the anchored element stays the same distance below the container's top edge |

The action is "apply the invariant of the state you are in"
(`web/src/components/Chat/useTranscriptScroll.ts`), and it runs at exactly two
moments: after every commit of `MessageList`, before paint, and on every callback
of a `ResizeObserver` watching both boxes. A diagram settling, a card expanding,
the keyboard opening, the container growing back as an overlay closes — none of
them is a case here, each being one of those two moments already. The one case
named is the commit a page lands in, which an anchored reader is held through by
[the seam](#reading-a-page-on-the-client) instead. The putting right of the
track ([below](#the-track-and-three-kinds-of-write)) has a third moment of its
own: the view coming to rest.

Neither moment covers the other. A commit is where the transcript's own changes
land, and the invariant is applied before the frame that would show them in the
wrong place; a child that settles on its own size without the list re-rendering —
a diagram, a thumbnail, a subagent body expanding itself — reaches the observer
and nowhere else. The observer watches the container as well as the content,
because the container shrinking is just as common and easier to miss: the input
box grows as it is typed into, an error bar appears above it, the keyboard takes
half the screen — none of which change the content's height while all of them
push the tail out of view.

**No write without drift.** A position that is already right is not written to.
Any programmatic write to `scrollTop` cancels iOS momentum scrolling, so a write
that moves nothing still costs something — which is also why there are as few of
them as there are ([the track](#the-track-and-three-kinds-of-write)). "Already
right" means within a pixel: the two heights a scroll box is made of are integers while
`scrollTop` is not.

**The anchor** is the finest candidate to start at or above the top edge of the
view, paired with how far below that edge it started, and the path down to it
(`web/src/components/Chat/scrollAnchor.ts`). The path is taken a level at a time
— the last row to start at or above the edge, then the last candidate inside
that row, and so on as deep as the candidates go: message rows, the top-level
parts inside a row, the top-level blocks of a text part's Markdown, the sections
of an open tool row. One assistant turn is a single row and can be several
screens tall, and one text part can be screens of prose by itself, so anything
coarser says nothing about where inside it the reader is: a tool result landing
in that bubble, or a diagram or an image settling inside the same part, above
their eyes would push what they are reading down. Every level keeps its own
offset, because the levels above the anchored element are what it falls back on.

Positions are read from the layout (`getBoundingClientRect`) and turned into
distance below the top of the content, which does not change while the view
scrolls and so can be compared with a `scrollTop` from another frame. That holds
for any element, so a candidate is whatever node is natural to mark — a Markdown
root's children, a section's own root — where `offsetTop`, measured from the
nearest positioned ancestor, required every candidate to be an unpositioned
wrapper made for the purpose. The walk leaves out what has no place worth
holding: a `hidden` subtree (a collapsed body, a part folded into a tool group)
and anything without layout boxes. Nothing in the transcript scrolls vertically
on its own ([one vertical scroll surface](tool-call-ui.md#one-vertical-scroll-surface)),
so every candidate's position is the transcript's to hold; a table or a code
block that scrolls sideways is a candidate like any block. No clamp holds a
candidate either — a clamped block is held by what holds it: its section, its part, its row.
If one ever does (a clamped Markdown marking its blocks), its cut-off blocks
sit where nothing shows them, and the walk must learn to leave them out again. Each
level is a binary search rather than a walk, since the anchor is taken again on
every scroll event and a long session has thousands of rows; document order is
top-to-bottom order, which is what makes the search sound.

**A lost anchor falls back along its path.** The anchored element can leave the
list — a tool row replaced by the card that took its place, a Markdown block
re-rendered as another element while it streams — or stay in it without being
laid out, and an element with no boxes measures as sitting at the top of the
loaded transcript, so holding it would carry the reader there. The path is
walked from the deepest level up, and the first level still laid out is held at
the offset recorded for it. A level that was folded into a tool group stands in
for itself by the group's summary, kept where the row's top was but never above
the view's top or under a bar pinned there — the place a fold the reader made
would land them ([tool-call-ui.md](tool-call-ui.md#folding-from-the-bar)). With
nothing of the path left, that look leaves the view where it is; losing an anchor
is never a reason to return to the tail.

What a lost anchor never does is take a fresh one from where the view sits *to
put that look right*. The commit that lost it has already moved everything, so
whatever is at the edge now is not what the reader was looking at. Re-picking
there is how a lost anchor used to strand a reader at the top of the history.
One is taken afterwards for the next look only
([why](#the-track-and-three-kinds-of-write)).

**Only the reader's own scrolling changes the state**, and which scroll that was
is decided by direction rather than by listening for the gestures that caused it:

- Reading the tail, movement *upward* that does not come to rest near the end
  (50px) is the reader's, because our own writes here can only take the view
  down. A tap moves nothing and so never arrives at all; a browser find, which
  does move the view, is the reader.
- Reading somewhere, every scroll event is the reader's. Movement *downward* that
  reaches the end returns to the tail; anything else takes the anchor again. A
  restore of our own that lands here re-takes the anchor from a view already
  where it should be, which costs nothing. The direction is required: a card
  collapsing *below* the reader clamps the view to the end, and without it that
  clamp would read as a return to the tail.

Sampling where the view happens to sit cannot tell those apart, and that is the
failure this replaced: a scroll event says where the view went one frame after it
went there, by which time the content has grown again, so a frame of our own
following read as the reader leaving.

**Explicit inputs** are the only other thing that moves the state. Opening a
session, the first message in an empty one, the reader sending a message and a
reconnect replacing the transcript all read the tail. "Sent" is a row the user
typed among the rows added after the previous newest one — not necessarily the
newest itself, since a send to an idle agent lands with its reply's placeholder
below it. A count cannot say it, because a page landing above grows the list
without adding anything at its end, and it routinely lands under a transcript
whose newest row is one the reader typed. "Replaced" is the page count dropping,
or — when the page count has not changed — none of the previous rows
surviving, since replaying history mints every row a new id. The
scroll-to-bottom button — shown only while reading somewhere — reads the tail, and
a jump to a pending permission request anchors on the card — on the card itself,
with the candidates around it as the path above it, since the card need not be a
candidate.

A third, beside the button and the jump, is a row asking for a place:
`holdAt(el, offset)` puts `el`'s top `offset` pixels below the top edge. Rows
reach it through `TranscriptViewContext` (`transcriptViewContext.ts`), which
`MessageList` provides around them. Two kinds of caller use it: an open tool row folding, which
lands the reader on the row instead of on whatever followed its body
([tool-call-ui.md](tool-call-ui.md#folding-from-the-bar)), and a cut block
opening, closing or following its live tail, which holds the edge the reader
was looking at ([tool-call-ui.md](tool-call-ui.md#keeping-the-readers-place)).
The place is clamped
to what the view can reach first, then judged. Reading the tail, a place the
end already shows (within a pixel) *is* the end: the view stays there and keeps
following — which is what folding a pinned row while following comes to, since
everything after it already fits. Only a place the end cannot show leaves the
tail; the view then moves to it and takes the anchor the way the reader's own
scrolling would (`pickAnchor`).

All three move the view instantly, which is a decision and not an omission. Switching
to the tail is itself a commit, so the invariant applied before that commit's
paint would be the first thing to cut short an animation the button had just
started — and exempting the invariant while an animation runs means knowing when
the animation ended, which is the kind of guess this design exists to avoid
(`scrollend` is absent before Safari 18.2). So the list animates no scrolling at
all, and there is no reduced-motion branch left to honour. A jump is written on
the container rather than through `scrollIntoView`, which would scroll the app
shell around it too, and it anchors on where the card actually landed: the end of
the transcript cannot be scrolled past, so a card near it stops short of the top
edge, and an anchor claiming otherwise would have every later commit trying to
push it further.

The button is a pill, `h-8 w-11` with a `touch-target` hit area (44px on a
coarse pointer, 36px on a fine one), horizontally centred above the composer. It
sticks to the bottom of the transcript's scroll box from inside the reading
column (`max-w-3xl`), so it centres on the column whatever the scrollbar takes.
It used to sit in the bottom-right corner, and on a phone that corner is exactly
where the transcript keeps what most needs reading: a row's `+`/`−` counts and
elapsed time, the copy buttons, Open, a permission card's Allow — on a narrow
line the button covered the only number on it. Centred, it covers the middle of
a line of prose, which still reads around it.

It is hidden in two cases even while anchored. **Within reach of the end**
(the same 50px): there is nothing left below to go to. **Over a control that
must stay pressable**: anything spread with `keepClearProps` (exported from
`useTranscriptScroll.ts`) that is inside the button's band — the bottom 60px of
the view, the button's offset plus its coarse hit area plus a little air — hides
it, checked against the layout on every scroll and every time the invariant is
applied. Today that is the pending permission card's answer row. Distance from
the end could not do this job: the turn-end slot under a waiting card keeps its
height ([turn-progress-ui.md §2.1](turn-progress-ui.md#21-where-it-is)), about
56px, so a card's answers could sit inside the button's band while the view was
still more than 50px from the end — and the button was drawn on Allow, right
after a jump to it. It carries a dot once the end of the conversation
has changed since the reader last saw it, which is on leaving the tail or on
coming back within reach of the end. "Changed" is the newest row's id, its body
(`parts`, or a user row's `content`) or its `error` no longer being the one
recorded, compared by identity. It is not the message object, which an
`anchorSeq` backfill replaces without showing anything new, nor the content's
height, which also grows when an older page lands above; a page joining onto the
newest row rewrites its `parts` with older history, so a page landing takes the
newest row as seen. Reading the tail again clears it.

The browser's own scroll anchoring is turned off on the container. The anchoring
here is written by hand, and leaving the browser's on means a second writer of
`scrollTop` that cannot be coordinated with. Safari before 27 does not implement
scroll anchoring at all, and on Safari 27, which shipped it, a field report has
it not compensating here either — so leaving it on would not even produce the
same disagreement on each platform, and it stays `overflow-anchor: none`.

**An overlay covers the transcript rather than unmounting it**, so that the
reader gets back their place, the cards they had opened and the highlight ring —
none of which survive a remount, where the history would
([how, and why not `display: none`](answering-ui.md#it-is-modal-over-one-rectangle-and-nothing-else)).
The container is one height while covered and another when it comes back, which
is a resize, which is already the whole of the mechanism above.

### The track, and three kinds of write

Reading back up a transcript is a flick — the very gesture that brings pages in
and during which output keeps arriving — and a write to `scrollTop` ends it
([above](#where-the-view-sits)). So the invariant is kept with as few of those
writes as it can be, by handing the work to layout. The scroller's only child is
a **track** (`trackRef` in `MessageList`): a column whose height
`useTranscriptScroll` alone writes, read back off its own inline style. The rows
sit on its bottom edge (`justify-end`, the rows' box `shrink-0`), and above them,
while older history remains, is [the history reserve](#the-history-reserve),
which takes whatever height the track leaves. Growth anywhere therefore moves
only what is above it, and where a change happens decides who moves:

| Kind | Change | What is written |
|---|---|---|
| A | above the reader | Nothing. What is above moves up — into the reserve, or, once that is used up, past the track's top, where no scroll can reach it |
| B | below the reader | The track's height, by however far the reader's place moved, which puts it back without touching `scrollTop`. The place is the anchor, or [the seam](#reading-a-page-on-the-client) in the commit a page lands in |
| C | none — the view came to rest | The track to the rows plus a full reserve, and `scrollTop` by the same amount, so nothing on screen moves |

C is what brings back into reach whatever A pushed past the top, restores the
reserve a page landed in to [its size](#the-history-reserve), and drops it once
history has run out. Reading the tail, everything is above the reader, so there
is nothing to hold and only the end to pin.

**At rest** is 120ms without a scroll event while nothing is pressed
(`REST_DELAY_MS`), long enough to span the gap between two scroll events of a
momentum flick. Pressed is a finger or a pen on the screen, or a mouse button
held — dragging the scrollbar, selecting text: the reader is about to move the
view, moving or not. Fingers and pens are told by touch events alone, because a
touch that starts a pan is a `pointercancel` the moment the browser takes it
over while still down; a touch's end is listened for on the node it started on,
which still hears it after React replaces that row. A mouse is told by pointer
events, its release listened for on the window, with `dragend`, the window
losing focus, and the mouse moving with no button down also ending a press —
each can end one with no `pointerup` at all (Chromium can leave it out after a
scrollbar drag). A press that never ended would keep the view from rest for good, and with it
the reserve, paging and anything past the top. Our own writes come back as scroll
events of no movement and do not count as the view moving. C also runs at once
when a change arrives while the view is already at rest, and just before every
deliberate move — the button, a jump, `holdAt` — which writes `scrollTop` anyway.

Two rules keep B honest. The track is never written shorter than `scrollTop`
plus the view's height: shorter, the browser clamps `scrollTop`, which is a
scroll of its own, and the next look reads it as the reader's place moving and
shortens the track again — until what is above has gone out of reach. Content
collapsing below a reader at the end therefore moves what they see; it is the end
coming up, not something to hold. And a look that ends holding no anchor — the
one held was lost, or not carried across a page — takes a fresh one from where
the view now sits, for the next look: not to put this one right, which is done
or cannot be, but because with the rows on the bottom edge, holding nothing means
every line of output below carries the reader up the screen.

What A costs is reach. A page taller than the reserve, landing mid-flick, puts
its oldest rows past the track's top until the reader lets go and the view comes
to rest: a flick going on up meets the top of the track and stops there, short
of them. The alternative is the write that would have stopped it anyway, and
earlier.

A row asking how far the view has moved over it (`TranscriptView.scrollTop`,
which `ClampedContent` uses) is answered from the rows' top, not the track's: the
rows move inside the track without the view scrolling, and C moves the view with
them, and neither is the view moving over the rows.

## Content Height on the First Frame

A height that changes a few frames after the content commits no longer breaks
anything: the resize is the same event as everything else, and the invariant puts
the reader back, and above an anchored reader without a write that could cut a
flick short ([the track](#the-track-and-three-kinds-of-write)). What it still costs is movement
the reader can see — whatever is on the far side of the change from them moves on
the screen — and, in the tail state, a threshold that has to be answered on the frame it is asked on: 50px
decides whether a scroll that moved up came to rest at the end. Content that
settles late is therefore worth avoiding on its own terms, and this section is
what was done about it.

The expensive case turned out not to be asynchronous rendering at all, but a
stylesheet. `react-shiki` hands back shiki's own `<pre>`, which ends up nested
inside `.code-block` and therefore inside `.prose`, where `@tailwindcss/typography`
gives every `pre` a `1.667em` margin; `.code-block`'s own reset only ever
covered the outer box. Every code block in the transcript grew by roughly 40px
the instant it was highlighted — against the 50px that counts as the end, one
block put the view on the line and two took following off it, and under the
model this replaced that loss was permanent. The rule that resets the
inner `pre` sits next to the `overflow` it lost in the same refactor
(`32e9811`), and the height now simply never changes.

What genuinely cannot be known early — the lazy chunk behind a mermaid diagram,
a Markdown image's intrinsic size — is given a reserved box while it waits
(`--async-media-height` in `web/src/index.css`). That reservation is no longer
part of any mechanism: it is there so the waiting state and the settled state are
roughly the same height and the transcript does not visibly jump between them.
A reservation is a guess, and where it cannot be exact — a diagram is whatever
size it turns out to be, and an image takes its own fitted size once it loads
([markdown-images-ui.md](markdown-images-ui.md#block)) — the difference is
simply a resize like any other.

An attachment in a tool result's strip needs no reservation of this kind,
because its shape is known before its bytes are: the block carries the
dimensions the server read out of the content's own header ([why they
travel](code/agent-integration.md#what-is-kept-and-what-is-only-described)), and
the placeholder and the loaded image are given the same box from them — a fixed
height and that aspect ratio, with a default shape for content that reported
none. So content fetched late, which it is (the read starts when the thumbnail
scrolls into view), lands in space that was already the right size.

Video and audio carry no dimensions (the server reads none out of them), so
their entries take a box that needs none: a video thumbnail is a fixed square
whatever the frame's shape, and an audio entry is a chip's height. The first
frame or the length arrives inside it
([tool-call-ui.md](tool-call-ui.md#the-body-problems-2-and-3)). What can still
move happens once: a block with no type that turns out to be video or audio
leaves the image placeholder's default shape for its entry's box, a video
block described as audio leaves its square for the chip (and the reverse),
and an entry that fails becomes a chip, as a failed image thumbnail does.

## Roads Not Taken

**A virtual list.** `react-virtuoso` was introduced (`72f7236`) and taken out
again (`85c0a9a`); it should not come back. Transcript rows differ in height by
orders of magnitude and settle asynchronously, which is precisely the input
virtualization is worst at — its estimates are wrong for the same reason the
measurements above were, and the resulting jitter is harder to reason about
because the list now also owns the scroll position. That migration is also what
dropped the spacer `78d8d81` had added to keep a transcript shorter than the
viewport sitting on its bottom edge; it came back only because the commit that
removed virtuoso re-derived it as `min-h-full` and `justify-end`. That is the
recurring shape of failure here — scrolling gets rebuilt whole, and whatever the
rebuild did not think of is gone with no test and no error to say so.

**`flex-direction: column-reverse`.** The classic way to get pinning for free
from the browser. iOS Safari has long-standing problems with scrolling,
momentum and selection inside a reversed container, and the product is
mobile-first; it also puts the DOM in the opposite order from the one the
transcript is read in.

**CSS `overflow-anchor` as the anchoring mechanism.** On iOS, the platform this
product is built for first, it does nothing before Safari 27 and did not
compensate here on 27 either. A hand-written anchor is required either way,
which leaves the browser's version as a second writer of `scrollTop` rather than
a feature ([turned off](#where-the-view-sits)).

**A ready-made follow library** (`use-stick-to-bottom` and its kind). What such
a library does is half of what is described here — a `ResizeObserver` and a held
intent — and it is the tail half only.
Reverse-infinite anchoring would still be written by hand, and the two halves
would then have to agree about who writes `scrollTop` and when. A dependency
that covers half of one problem and adds a coordination problem is not a saving.

## Known Gaps and What They Were Traded For

- **A page landing while the newest row streams can let output carry the
  reader.** The seam is the first loaded row's bottom edge, and when that row is
  also the one output is streaming into — the newest page a single bubble still
  growing — output landing in it in the same commit as a page grows the row
  *above* that edge, where it moves the seam no more than the page does: it is
  not counted, and the reader inside the row is carried up by it, once. Both the
  output and the page have to reach React between the same two renders, which is
  a narrow window, and the alternative — total height — would miscount on every
  page landing, since it counts the page itself, which needs no correction.
- **A card expanded while reading the tail can be pushed out of view.** Opening a
  body adds height above the end, and re-pinning to the end carries the card that
  was just opened upward — off the top of the screen, if the body is tall enough.
  Holding the pressed header still instead would be a third state, "read the tail
  except over this element", for something the reader undoes with one scroll.
- **A mermaid diagram still jumps when it draws**, from its reserved box to
  whatever size it renders at — and again when the reader loads its images,
  which draws it in a new frame
  ([markdown-images-ui.md](markdown-images-ui.md#diagrams-draw-in-a-sealed-frame)).
  Removing the jump would mean scaling every diagram into a fixed frame, which
  spends the readability of large diagrams — the thing they are there for — on
  a scroll-position detail. The invariant absorbs it: the reader
  keeps their place, and what is on the far side of the diagram from them simply
  moves.
- **The first layout of a session opens at the tail, whatever was asked for.** A
  conversation shorter than the viewport sits on its bottom edge, so a jump to a
  permission card in it cannot put the card at the top — there is nothing to
  scroll. Reloading the page on an overlay's URL comes back the same way: the
  transcript behind it is laid out for the first time and has no place to
  return the reader to yet. Both are the absence of a previous position rather
  than the loss of one.
- **An overlay does not stop paging.** `IntersectionObserver` is specified to
  ignore `visibility`, and the measurement after a commit does not ask either, so
  a covered transcript whose loaded history's top is within a view of it goes on
  asking for history — and the container growing by the height of the unmounted
  composer can bring that top into range and buy one more page than the reader
  would have. It is harmless: it only happens to a reader already near the top
  of what is loaded, the cursor is finite and the run settles at `has_more`
  being false, and the anchor holds their place for the way back. The fix would
  be a rule that knows whether the list is on screen, which is a third piece of
  state of exactly the kind this design is made of removing — the cost of
  keeping it out is a page of history nobody reads.
- **The software keyboard on iOS scrolls the window, not the container.** The
  invariant here holds the container's own `scrollTop`, and that is not what
  moved, so nothing in this document addresses it. It belongs to the shell that
  sizes the chat pane, and is left for that layer to take up.

## Session Persistence

Session metadata and chat history are stored under the session data directory. History is JSON Lines of `EventRecord`s appended on each event. Both agents record where their side of the conversation lives, and reopen it on the next launch. Claude keeps its provider-side session ID in `claude_resume.json` as soon as the CLI reports it, and falls back through a recovery ladder (plain resume → fork → new session) when a launch turns out to be unresumable, so a session cannot be permanently stuck by a first turn that failed ([code/agent-integration.md](code/agent-integration.md#session-recovery-ladder)). Codex keeps a thread id in `codex_resume.json` and reopens the thread from the rollout file the CLI wrote to disk; when that file is gone the session starts a new thread and says so ([code/agent-integration.md](code/agent-integration.md#thread-recovery)). Pockode's own transcript survives either way; what a resume decides is whether the *agent* still has the context.

A session can also be **forked**: `session.fork` starts a new session from a copy of the source's transcript, cut to the moment before the message the user picked — which keeps that message when the agent said it, and drops it when the user did, because the fork returns to before they sent it ([session-fork-ui.md](session-fork-ui.md#the-rule)). The source is left untouched. Whether the agent comes along is that agent's own declared answer, and it is a stronger question than resuming: both shipped agents can follow a fork to a chosen point inside a conversation — Claude to a message, Codex to a turn — and an agent that could not would have its forks refused rather than handing back a session whose agent has never seen the conversation filling its screen ([code/agent-integration.md](code/agent-integration.md#session-forking), UI in [session-fork-ui.md](session-fork-ui.md)).

## Sessions Outlive Their Worktree

Session data is stored per worktree, and deleting a worktree deliberately leaves
it in place ([why](code/work-system.md#what-a-deletion-leaves-behind)). A session
is therefore readable from anywhere else in the project, and never continuable — `session_view.*` is the namespace that reads it,
and it has no method that can say anything to a session
([why it is app-scoped, and what the one non-read is for](websocket-rpc-design.md#method-naming-convention)).

| Method | Params | Result |
|--------|--------|--------|
| `session_view.worktrees` | — | `worktrees`: `worktree`, `exists`, `session_count` |
| `session_view.list` | `worktree`, `exclude_work_sessions?`, `cursor?`, `limit?` | `sessions`, `next_cursor?`, `has_more` |
| `session_view.get` | `worktree`, `session_id` | `session` |
| `session_view.history` | `worktree`, `session_id`, `before_seq?`, `limit?` | `history`, `has_more`, `next_before_seq?` |
| `session_view.attachment` | `worktree`, `session_id`, `id` | `file` |
| `session_view.delete` | `worktree`, `session_id` | — |

- `worktree` is a name and `""` is the main worktree. It is checked with
  `filepath.IsLocal` before it becomes a path, since these are the paths that
  deliberately skip the registry (`server/AGENTS.md`).
- The rows, the detail, the cursors and the history page are **the same shapes
  `session.list.page` and `chat.messages.history` answer with**, deliberately, so
  a client renders and pages a viewed session with the code it already has.
- `session_view.worktrees` lists every worktree that still holds sessions,
  deleted ones included; `exists` is what separates "switch to it" from "read it".
  A worktree with no sessions is not listed, so one disappears from the list when
  its last session goes — and what is then left on disk is
  [work-system.md](code/work-system.md#what-a-deletion-leaves-behind)'s to say.
- **Nothing here subscribes.** What is read belongs to a conversation the reader
  cannot take part in, so there is no update to follow; a client that changes
  something through `session_view.delete` re-reads rather than waiting to be told
  ([work-system.md](code/work-system.md#what-a-deletion-leaves-behind) for why
  there is nobody to notify along that path).
- A worktree recreated under a deleted one's name **inherits its sessions**. The
  data is keyed by name and nothing moves it: the alternative is renaming
  somebody's data behind their back to keep two eras of the same branch apart.

What the user sees of all this — the sidebar filter, the read-only screen, and
what deleting means from there — is
[cross-worktree-session-ui.md](cross-worktree-session-ui.md).
