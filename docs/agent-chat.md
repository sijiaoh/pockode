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

- **ChatClient** (`server/chat/`) — Coordinates session/process management, records messages, answers and warnings through the session's `chatstream.Sequencer`, which persists each and puts it on the live stream in seq order ([why](code/agent-integration.md#history-storage)).
- **ProcessManager** (`server/process/`) — Manages agent process lifecycle. Streams agent events into history and turn state, and runs the lease reaper that decides how long a process may be held ([the lease table](code/agent-integration.md#the-lease-table)).
- **Agent Session** (`server/agent/`) — Common `Session` interface implemented by each backend (`agent/claude/`, `agent/codex/`). Handles subprocess spawning, stream-json parsing, stdin messaging.

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_chat.go` | `chat.message`, `chat.interrupt`, `chat.messages.subscribe` / `chat.messages.history` ([paging](#history-paging)), permission responses |
| Session config | `server/ws/rpc_session.go` | `session.set_agent_type` / `set_mode` / `set_model` / `set_effort`, each closing the running process because a CLI is told these only at launch; `session.set_html_first`, refused once the session has `started`, which closes nothing — the first send replaces a process started with the other value ([why](code/agent-integration.md#html-first-sessions)); `session.models` and `session.efforts` list the choices ([models](code/agent-integration.md#session-models), [effort](code/agent-integration.md#session-effort)). None of them answer with the new value: the settings in force reach the panel through `session.detail` ([why](code/subscription-system.md#why-a-session-is-two-subscriptions)) |
| Another worktree's sessions | `server/ws/rpc_session_view.go` | `session_view.*` — reading (and discarding) a session stored under a worktree the connection is not in, including one that no longer exists ([how](#sessions-outlive-their-worktree)) |
| Attachments | `server/ws/rpc_attachment.go` | `attachment.get` — the content a chat event references by id, answered in `file.get`'s own shape so one client path renders both ([why](code/agent-integration.md#content-blocks-and-attachments)) |
| Agent pages | `server/ws/rpc_html_page.go` | `html_page.get` `{session_id, id}` → `{page: {id, title, html, base?, created_at}}` — a page an agent drew, by the id its `tool_result` record carries as `html_page`; immutable, so never subscribed to ([how](code/work-system.md#rendering-tool)) |
| Sending files | `server/filetransfer/attachment.go`, `server/chat/attachments.go` | `POST /api/chat/attachments` stores a file in the session's store; `chat.message`'s `attachments` names it by id and each agent delivers it its own way ([how](code/agent-integration.md#files-the-user-sends)). Client side: `web/src/lib/chatAttachments.ts`; the composer's `+` menu (Photos / Files), a drop on the chat or a paste into the composer ([how](#attaching-by-drop-or-paste)) uploads each file as it arrives (`inputStore`), holds Send until every one is stored, and takes the files back if the message is refused |
| Chat client | `server/chat/client.go` | Session coordination and the records Pockode writes itself; `SendMessage` (user) and `SendSystemMessage` (system automation) share one path into the sequencer |
| Agent interface | `server/agent/agent.go` | `Session` and `AgentEvent` interfaces |
| Claude impl | `server/agent/claude/claude.go` | Claude CLI subprocess, stream-json parsing, MCP server config |
| Process manager | `server/process/manager.go` | Process lifecycle, event stream, lease reaper |
| Frontend panel | `web/src/components/Chat/ChatPanel.tsx` | The session screen: the header (`SessionHeader.tsx` — the session's title, and the panel behind it holding engine, permission mode, work and usage; over a page, the page's own heading, `Layout/PageHeader.tsx` — [why](#the-session-screen)), the transcript and the composer (`InputBar.tsx`) ([layout](#the-session-screen)) |
| Transcript | `web/src/components/Chat/MessageList.tsx` | Rendering the loaded messages, and every scroll decision made over them: [where the view sits](#where-the-view-sits) (with `useTranscriptScroll.ts` and `scrollAnchor.ts` beside it), the reserve (`HistoryReserve.tsx`) and trigger behind [history paging](#history-paging), and the jump to a pending permission request ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip); its landing in `transcriptJump.ts`, shared with a subagent's transcript) |
| Subagent transcript | `web/src/components/Chat/SubagentTranscript.tsx` | A subagent's work as a transcript of its own, over the chat's: a stack of levels, each a layer with its own scroller on `useTranscriptScroll` ([subagent-transcript-ui.md](subagent-transcript-ui.md)) |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission handling, and the session's unanswered questions |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage` (which carries `answering` when it is an answer, [answering-ui.md §3](answering-ui.md#3-the-answer-panel)), `interrupt`, `permissionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC, under a `message_id` the client minted — a UUID in canonical form, which the record carries (files it carries were uploaded beforehand and are named by id — [how](code/agent-integration.md#files-the-user-sends)). A send under an id the session's history already holds sends nothing and writes nothing and is answered as sent, so a client may retry one whose reply it lost — unless that earlier attempt wrote the record and then failed to reach the agent, which its retry is told (`chat.ErrRecordedNotDelivered`, [why](code/websocket-rpc.md#sending-a-message)).
2. ChatClient persists message to session history, forwards to `Process.SendMessage()` — unless the turn is holding a permission request open, the one state a message cannot be delivered in, which is refused as `InvalidParams` with nothing written ([lifecycle.md](lifecycle.md#session-one-reducer)). A turn merely *running* is not refused; the message steers it, and the answer to it begins where the agent reads it rather than where the turn ends — for an agent that cannot report that moment itself, this is also where the read point record is written ([agent-event.md](agent-event.md#the-read-point-message_ingested)).
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, Done, etc.)
5. Each event is persisted to session history, folded into the session's projection as it is written, and then handed to `ChatMessagesWatcher`, in one step per session (`chatstream.Sequencer`), which queues what the record changed — a `chat.update` of turns and items — for every WebSocket subscriber, in seq order; a live event (`tool_activity`, `thinking_delta`) is not persisted and goes out as a `chat.delta` ([Live updates](#live-updates))
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
the mode's glyph: YOLO's `Zap` or Unattended's `Bot`, `size-3`, in
`text-th-warning`, with the word beside it muted like the engine's; Default has
no glyph, since the mode that changes nothing needs no mark. A mode this build
does not know is named by its raw id beside a muted `CircleHelp` — never as
Default, since a session with its gates down must not read as one that keeps
them ([unattended-mode-ui.md §2.4](unattended-mode-ui.md#24-a-mode-this-build-does-not-know)). That is less than the old mode bar's button
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
- **Permissions** — Default / YOLO / Unattended, three rows, in place, each
  with its glyph (`Shield`, `Zap`, `Bot`) and its description, coloured by the
  second line's rule above. What a choice costs is said by the description
  ("Skips all permissions"), at the one moment it is being made. Unattended's
  cannot say it all — that it is *more* permissive than YOLO, and spends tokens
  on a reviewer — so choosing it opens a confirmation first, which a custom
  `ModeSelector` goes through too (`hooks/useModeConfirmation.tsx`,
  [unattended-mode-ui.md §2.2](unattended-mode-ui.md#22-choosing-it-the-confirmation)).
  Under an unknown mode no row is selected, and a line says so.
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
and tablets are untouched. One block leaves the column where it binds: a page
the agent drew takes the pane's width, up to 1280px
([why](tool-call-ui.md#a-page-the-agent-drew-html_render)). The scroll-to-bottom
button belongs to the column too ([Where the View Sits](#where-the-view-sits)).

**Only the user speaks in bubbles.** The agent's message has no bubble: its text,
tool calls and cards run the full width of the column in `text-th-text-primary`,
and below them a turn-end row (`Chat/MessageActions.tsx`) holds Copy and
Fork — while the turn is running, the tail line (`Working 1m 4s`)
stands in that row's place instead
([turn-progress-ui.md](turn-progress-ui.md#2-the-tail-line)). A settled turn
that changed files closes with a card of them, above that row, headed
by the turn's work figures — `Worked 2m 13s · 14 tool calls · 3 files
changed` — each file opening on its diffs and on the calls that made them; a
turn that made calls and changed no file has its figures at the right end of
the turn-end row instead
([tool-call-ui.md](tool-call-ui.md#the-turns-changes)). The user's
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
replies with the newest page of it and a cursor; scrolling up fetches the
pages before it with `chat.messages.history` (`session_view.history` for a
session of another worktree, which pages the same way). A long conversation is
mostly tool calls and their results, and a client only ever renders the tail of
it — sending the rest costs transport, parsing and memory for items nobody
looks at.

| Method | Params | Result |
|--------|--------|--------|
| `chat.messages.subscribe` | `id`, `session_id`, `limit?`, `resume?` (`server_instance`, `after_seq`) | `delivery`; for `"snapshot"` `turns`, `has_more`, `next_before_seq?`, `through_seq?`, `plan?`, for `"resume"` `update`; and `turn`, `streams`, `server_time` |
| `chat.messages.history` | `session_id`, `before_seq?`, `limit?` | `turns`, `has_more`, `next_before_seq?`, `through_seq?`, `plan?`, `server_time` |

**A page is a slice of the conversation, not of the record stream.** It is cut
from the session's history projection
([agent-integration.md](code/agent-integration.md#the-history-projection)) and
holds *items*, oldest first, grouped into the turns they belong to. Every item
is complete as it stands when the page is cut: a tool run carries its status,
its permission request and what became of it, its result (a background
outcome beside the placeholder it replaced) and the plan filed on it; a
subagent's call carries its own words, thinking and calls inside it, at any
depth, however the records interleaved; a question carries its answer or its
withdrawal — and, reopened because a Stop discarded the message its answer went
out in, the answer it lost (`discarded_answer`, with `discarded_in` naming that
message) until it is answered again or withdrawn; a message says whether a Stop
discarded it. So no page needs
another to be read — what an older page holds is earlier items, never a missing
piece of one on this page — and nothing about a page boundary has to be
repaired.

```json
{
  "turns": [
    {
      "turn": {"turn_id": "T7", "origin": "prompt", "message_id": "m7",
               "started_at": "…", "start_seq": 41, "ended": true,
               "outcome": "completed", "ended_by": "done", "end_seq": 52,
               "ended_at": "…"},
      "continued": true,
      "items": [
        {"kind": "text", "seq": 44, "last_seq": 44, "text": {"content": "Looking."}},
        {"kind": "tool", "seq": 45, "last_seq": 51, "tool": {
          "tool_use_id": "tu1", "tool_name": "Task", "tool_input": {…},
          "status": "succeeded", "started_at": "…", "ended_at": "…",
          "result": {"text": "…", "duration_ms": 9000, "seq": 51},
          "children": [
            {"kind": "thinking", "seq": 46, "last_seq": 46, "thinking": {"content": "…", "parent_tool_use_id": "tu1"}},
            {"kind": "tool", "seq": 47, "last_seq": 50, "tool": {
              "tool_use_id": "tu2", "tool_name": "Bash", "parent_tool_use_id": "tu1",
              "status": "succeeded",
              "permission": {"request_id": "p1", "status": "allowed", "choice": "allow", "seq": 48},
              "result": {"text": "ok", "seq": 50}}}
          ]}}
      ]
    }
  ],
  "has_more": true,
  "next_before_seq": 44,
  "through_seq": 52
}
```

- **A stretch is `{turn?, continued?, items, discarded?}`.** `turn` is the
  whole turn as it stands — its origin, opening message, start, and whether,
  how and when it ended — whichever page its items are on; absent for items
  outside every turn (a message whose turn never started, a warning written
  between turns). `discarded` lists the messages the Stop that ended it threw
  away unread, a legacy one by the excerpt its warning quoted. A turn is
  usually one stretch, but a page boundary can cut it: the newer half is then
  `continued` — the item before its first, on the older page, is the same
  turn's. Output tagged with a turn after the next one had started (a Codex
  straggler) is a stretch of its own after that turn's, naming its turn, and
  is not `continued`. Either way a stretch reads on its own; a client that
  wants one block per turn joins stretches by `turn_id`.
- **A turn's `outcome` is `completed`, `failed`, `auth_failed` or
  `aborted`; `ended_by` is the signal that ended it** — `done`, `failed`,
  `auth_failed`, `interrupted`, `process_ended`, `process_started` — which says
  what `aborted` cannot: whether the turn was stopped or lost its process, a
  difference the transcript draws. Both are absent while `ended` is false.
- **An item is `{id, kind, seq?, last_seq?, <kind>: payload}`**, the payload under
  the field named after its kind: `message`, `text`, `thinking`, `tool`,
  `question`, `plan`, `read`, `system`, `warning`, `error`, `raw`,
  `command_output`. The shapes are the `projection.PageItem` family
  ([`server/projection/page.go`](../server/projection/page.go)). Not items: a
  turn's ending (`done`, `interrupted`, `process_ended` are its `turn`; an
  `error` is both an item and the turn's outcome), a `turn_started`, a
  `background_wait`, and the records that settle an item, which are folded
  into it. A `read` item is a read point, where the agent picked up the
  message it names — the place a reply splits. A `plan` item is a plan record
  filed on no call the history holds (a Codex plan); one filed on a call rides
  on that call's `tool` item. A fetch (`origin_tool_use_id`) stays a `tool`
  item of its own naming the call it reads, in its own turn: it always comes
  after that call, so a client paging newest-first holds every fetch of a call
  by the time the call's page arrives.
- **`id` names the item**: the same item has the same id on every page and in
  every update, and no other item has it. It is the item's place among all the
  transcript's items, nested ones included, counted from one, so items at one
  level — the top level, or one run's children — are in id order. A client
  keys its copy by it and derives nothing else from it. It holds for as long
  as the history is the one it was read from: a history replaced under a
  subscription ends it with `chat.resync`.
- **`seq` is the item's first record's, and is the item's place;** absent for
  an item in no file (the warning a damaged history gets).
  **`last_seq` is the newest record that went into it** — a tool run's nested
  items' included — so it moves when a call returns, an answer arrives, or a
  backgrounded run reports its outcome turns later. Both are record-level
  seqs, the addresses a fork anchor names
  ([session-fork-ui.md](session-fork-ui.md#data-contract)); as before, a
  client quotes them back and never computes with them.
- **`before_seq` is exclusive**: the reply holds the items immediately older
  than the item it names. Omitted (or `0`) asks for the newest page. It must be
  a cursor the server handed out (`next_before_seq`), which is the seq of the
  page's first item: an item in no file has none, so a page never starts on
  one.
- `has_more` says whether items older than the page's first exist;
  `next_before_seq` is the cursor for that page and is absent once `has_more`
  is false.
- **`limit` is a budget in records**, not a count of items: the newest items
  come back until the records that went into them — a tool run's nested work
  included — reach it, and the page ends on the item that spends it. An item
  is never split, so a page holds at least one however large it is (the
  longest real turn is about 670 records; a subagent run inside one is one
  item). `0` means `projection.DefaultPageSize` (50); anything above
  `projection.MaxPageSize` (500) is clamped. A negative `limit` and a
  `before_seq` past the newest record are both refused with an invalid-params
  error — answering an unusable cursor with the newest page would silently
  restart the client's scrollback from the bottom. A `before_seq` inside a gap
  (seqs are not dense, see
  [agent-integration.md](code/agent-integration.md#history-storage)) is not
  unusable: it still means "older than this".
- `through_seq` is the newest record the page had folded when it was cut. A
  `chat.update` whose `through_seq` is not past it says nothing the page does
  not ([Live updates](#live-updates)).
- `plan` is the session's current plan as of `through_seq` — the newest
  main-thread plan record, as a `plan` item with its seq. It is state, not an
  item of the page: the plan in force can be on any page.
- **The file is not read per request.** A session somebody subscribes to is
  held in memory from the first subscriber to the last
  (`ChatMessagesWatcher`), and its pages — the snapshot and every
  `chat.messages.history` after it — are cut from that projection. Once
  nobody holds it, it lingers two minutes, and a page of a session nobody
  holds (paging without a subscription) starts the same linger, so a
  reconnect or the next page does not fold the file again.
  `session_view.history` of a worktree that is not loaded keeps its fold the
  same way, for as long as the history file is unchanged — nothing here hears
  of that directory's writes, so each page checks the file's version instead.
- A `seq` is an address only for as long as the server process that handed it
  out: appends are not fsynced, so a power loss can drop a tail the client
  already holds, and the restarted server gives those seqs to different
  records. The `auth` reply's `server_instance` (`rpc.AuthResult.ServerInstance`)
  is new on every process start, and a connection never outlives its process,
  so every seq a connection carries belongs to the instance its `auth` named.
  Seqs held from a connection whose `server_instance` differs from the current
  one are to be replaced by a fresh snapshot (`chat.messages.subscribe`), never
  continued from with a cursor or resumed from. A client names the instance its
  copy came from when it asks to resume, and the server answers a copy from
  another instance with a snapshot ([live updates](#live-updates)).
- `server_time` is the server's clock as the reply was built. A call still
  running in a page is counted from its `started_at`
  ([agent-integration.md](code/agent-integration.md)) against this reading plus
  however long ago the reply arrived, never against the phone's own clock — the
  same rule as the turn's `open_elapsed_ms`. Moments are sent as the server
  recorded them; correcting for the phone's clock stays the client's.

- `streams` is what is still being generated as the subscription opens:
  `thinking` — the main agent's thinking so far, `{content?, full_reasoning?}`,
  absent when it is not thinking — and `tools`, by `tool_use_id`, what each call
  in flight has said about itself: `{activity?, output?, output_truncated?,
  subagent_progress?}`. None of it is ever recorded
  ([tool-call-model.md](tool-call-model.md#tool_activity-is-not-persisted)), so
  a client subscribing mid-run would otherwise see a call that has been running
  for half an hour with nothing to say for itself. The `chat.delta`
  notifications continue it exactly ([Live updates](#live-updates)).

`chat.messages.history` needs no subscription. Its cursors name places, and a
place never moves — items are only ever added after the newest — so a client
scrolled up keeps paging with the cursor it already holds while the newest
page grows below. What an older page says of an item is how it stands when the
page is cut, which for an item still changing (a backgrounded run, an open
question) can be newer than what the client was told when it subscribed.


### Live updates

A subscription is kept current with three notifications, all carrying the
subscription `id` for routing, and nothing else: the records themselves never
go out. What a record changed is said in the terms a page uses, and a stream
still being generated is extended in place, close to Codex's `item/started` /
`item/completed` and its deltas.

**`chat.update`** is what one history record changed
(`projection.Update`, [`server/projection/update.go`](../server/projection/update.go)):

```json
{"id": "client-1", "through_seq": 61,
 "turns": [{"turn": {"turn_id": "T8", "origin": "prompt", "ended": true, "outcome": "aborted", "ended_by": "interrupted", "end_seq": 61, …}}],
 "items": [
   {"turn_id": "T8", "item": {"id": 40, "kind": "tool", "seq": 55, "last_seq": 59,
     "tool": {"tool_use_id": "tu1", "tool_name": "Task", "status": "interrupted", …}}},
   {"parent": 40, "item": {"id": 42, "kind": "tool", "seq": 58, "last_seq": 59,
     "tool": {"tool_use_id": "tu2", "parent_tool_use_id": "tu1", "status": "interrupted", …}}}
 ],
 "streams_ended": {"thinking": true, "tools": ["tu2"]}}
```

- `turns` are the turns the record started or ended, or had a message
  discarded in, each whole (`{turn, discarded?}`, as a stretch carries them).
  They come before the items, so an item names a turn the client has.
- `items` are the items it changed, each **upserted**: complete as it stands
  now, replacing the client's copy — with one exception, a `tool` item's
  `children`, which are never sent in an update. Every nested item is an item
  of its own: a subagent's call returning sends that call, and the runs it is
  nested in again (their `last_seq` moved), never the whole run. That keeps a
  long subagent run at the cost of what changed rather than its whole tree on
  every record. An item that changed without any record naming it is sent all
  the same: calls a turn's cut-off interrupted, requests a process's end
  expired, a call that ran inside a subagent call recorded after it, a
  message taken into the turn it opened.
- Where an item sits is beside it: `parent` is the id of the run it is nested
  in, absent at the top level, where `turn_id` is its turn (absent for none).
  An item's place within its level is its id. A new item is newer than every
  item the client has, so it goes at the end of its level; one the client has
  stays where it is unless `parent` or `turn_id` says it moved — a call
  recorded before its subagent call moves under it when that call arrives, and
  the message that opened a turn moves into it. Items come in an order that can
  be applied one at a time: a run before what is nested in it.
- `plan` is the session's plan, when the record changed it (`Page.plan`).
- `streams_ended` names the live streams the record settled; see below.
- An item with no `id` is in no history: the warning that stands in for a
  record that could not be written (`history_write_failed`). It is shown once
  and never updated, and a reload no longer has it.
- **Turn state, questions and permission requests come only this way.** A
  question asked, answered, withdrawn or reopened by a discard is an upsert of
  its `question` item; a permission request and its answer or expiry are an
  upsert of the `tool` item it holds back (status `awaiting_permission`, then
  `running`, `denied` or `expired`); a turn's start and end are its `turns`
  entry. Nothing is left for the client to work out from records.
- The sender of a message is sent the update that carries it like every other
  subscriber. It knows the item for its own by the `message_id` it minted and
  sent the message under, so its echo becomes that item whenever it arrives —
  before the send's reply, after it, or after a reply lost with the
  connection, on a resume. The reply to `chat.message` is an empty object: it
  says the send is over, and nothing else.

**`chat.delta`** extends a live stream — what is being generated and is in no
record yet:

```json
{"id": "client-1", "thinking": {"content": "Let me look at "}}
{"id": "client-1", "tool": {"tool_use_id": "tu3", "activity": "Running tests", "output": "ok 12\n"}}
```

- `thinking` is the main agent's thinking under way: `content` and
  `full_reasoning` are appended to what the client has. Never a subagent's.
- `tool` is a call in flight, named by `tool_use_id` — the `tool` item it
  belongs to: `output` is appended; `activity` and `subagent_progress` are
  latest values, each replacing the last when present.
- `replace: true` says the fields are the whole stream so far rather than the
  next piece. A subscriber that fell behind has deltas turned away first
  ([subscription-system.md](code/subscription-system.md#chat-delivery)); the
  next one it is sent of that stream is the whole of it, so a stream it holds
  never has a hole. A call's kept output is bounded (1 MiB, its tail —
  `output_truncated`); the whole output arrives with its result.
- A stream ends with the update that settles it, which says so in
  `streams_ended`: the thinking stream with the main agent's next item of its
  own (the `thinking` item that records it, or text written without one) or a
  change of turn; a call's when its item is no longer in flight (anything but
  `running`, `background` and `awaiting_permission`), or when a turn ends and
  the call is not in the background — which also ends a stream naming a call
  no item is for. The client drops its copy; the item has all of it.

**`chat.resync`** ends the subscription: something could not be told — an
update did not fit a subscriber that fell too far behind, or the history was
replaced under it so no update can describe the change. The client subscribes
afresh ([subscription-system.md](code/subscription-system.md#chat-delivery)).

**Ordering and consistency.**

- Updates are in seq order, one per record that changed anything, and each is
  the state as of its `through_seq`: a session's records are written,
  folded and handed to the watcher one at a time (`chatstream.Sequencer`), so
  the next record is not written before this one's update is taken. Deltas sit
  among them in the order the agent produced them.
- Subscribing registers the subscriber and snapshots `streams` in one step
  between two notifications, then cuts the page (or the resumed update, below).
  So the deltas a subscriber is sent continue `streams` with nothing missed and
  nothing repeated, and every update after the snapshot reaches it. An update
  can also be in the page — its record was written between the registration
  and the cut: if its `through_seq` is not past the page's, skip its `turns`
  and `items`, which the page already holds as of a moment no older, but apply
  its `streams_ended`, which the snapshot taken before it does not know of.
- A client that reconnects asks to resume the copy it holds: `resume` names
  the server instance it read the copy from (`server_instance` of that
  connection's `auth`) and the `through_seq` of the last page or update it
  applied. From the same instance, the reply is `delivery: "resume"` with an
  `update` — every turn and item the records after `after_seq` changed, as each
  stands now, applied as a `chat.update` is — and the client keeps everything
  else it holds, the older pages it had scrolled back through included.
  `streams` replace the ones it held. Seqs from another instance may name other
  records (a power loss can drop a tail, and the restarted server numbers the
  next records the same), so that copy is answered with `delivery:
  "snapshot"`, the newest page, which replaces it; so is a seq past the
  history, or more than `projection.MaxResumeGap` (500) records behind it — a
  page is cheaper then. A resume is never refused. A client given
  `chat.resync` subscribes for a snapshot: the hole it reports is one its copy
  cannot vouch past.


### Reading a page on the client

A page is a slice of the conversation, so the client reads it as it comes and
repairs nothing. It holds the items as the server stated them (`ChatItems`,
[`web/src/lib/chatItems.ts`](../web/src/lib/chatItems.ts)) and draws bubbles and
rows from them (`buildTranscript`,
[`web/src/lib/transcript.ts`](../web/src/lib/transcript.ts)); how, and why, is
[code/frontend-state.md](code/frontend-state.md#the-transcript). The list
component knows neither: it is handed messages.

- **Subscribing installs the newest page** and the streams it came with. A
  reconnect re-subscribes asking to resume, and a resumed answer is applied as
  an update, keeping the older pages scrolled in so far ([live
  updates](#live-updates)); a snapshot — the answer to a `chat.resync`, or to a
  copy the server cannot continue — installs a fresh page in its place,
  dropping them.
- **An older page goes in front.** Its items are complete, so nothing on it
  waits for a newer page to settle it, and nothing on the loaded pages is
  touched — except that a page's turns can be newer than what the client was
  told of them, and a turn it holds with an ending replaces one held without.
- **A turn cut by a page boundary is one bubble.** The page above holds the
  front of the turn (the stretch below it is `continued`), and its items go into
  the bubble already on screen, which is keyed by its turn and so stays the same
  node: the reader is held across a page by that row ([below](#reading-a-page-on-the-client)).
  Until that page joins it, the bubble's start is not loaded, and the client
  reads so from `continued` rather than from the bubble's position: when the
  oldest loaded page's first stretch is `continued`, `ChatItems.continuedFrom`
  holds that stretch's first item, and the transcript marks the bubble the
  stretch opens with `startNotLoaded` unless something loaded opened it, so
  its work figures are not counted on half the turn
  ([tool-call-ui.md](tool-call-ui.md#where-the-duration-comes-from)).
- **Updates keep it current** ([Live updates](#live-updates)): an update a page
  already reached is skipped, and an upsert for an item on a page not loaded —
  older than the oldest loaded item — is dropped, since that page will bring the
  item as it then stands. The one exception is a page already on its way: the
  server cuts it and sends the subscription's updates independently, so an
  update can arrive before a page cut ahead of its record. While an older page
  is being fetched the client keeps what it drops (`ChatItems.missedOlder`), and
  once the page lands applies those newer than its `through_seq`.

A subagent's work is nested in its call on the page, whatever page the records
it was folded from sat on, so nothing is re-anchored at a seam; a child whose
call is not in the history at all — a fork cut it off — sits flat where it is
([code/frontend-state.md](code/frontend-state.md#a-subagents-children)).

Reconnecting re-subscribes and asks to resume ([live updates](#live-updates)):
from the same server instance, the pages already scrolled in stay, with the
cursor, and what was missed arrives as one update. Only a snapshot — another
instance, a gap too large, or a resync — lands back on the newest page, and
then pages already scrolled in are dropped rather than stitched back together:
their seqs may name other records now, and the cursor chain would have to be
replayed from the bottom anyway.

**A page is held by its seam, not by the anchor.** The seam is the bottom edge
of the first loaded row (`Seam` in `web/src/components/Chat/scrollAnchor.ts`). A
page only ever adds content above that edge — rows before the first one, or the
older half of its turn added into it from the top, the row keyed by its turn so
that it is the same node afterwards
([code/frontend-state.md](code/frontend-state.md#bubbles)).
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
the page left alone, and inside a row a page added to that may be none of them:
the text at the seam grows from the top of its own part, and the row's parts are
rebuilt, so the element the reader was anchored on can have grown above its own
top edge or left the DOM. That is how the anchor used to lose the reader there:
the anchored part was remounted, a fresh anchor was taken at the top of the view,
the view stayed at 0 and the next page was asked for at once.

The seam is recorded every time the view is placed or the reader scrolls, not
when a page arrives: by the time the commit that lands a page is seen, the page
is already laid out above the edge. Recording it on the reader's scroll matters
for one more reason. Layout can change and the reader scroll over it before a
resize observation reaches the list; from then on that layout is where they are,
and a page landing must not count the growth a second time.

Because nothing on the anchor has to survive a page, the first row and its first
part are ordinary candidates, and a reader inside the row a page added to is held as
finely as anywhere else. If the seam's row is itself gone after the page, the
track is left as it is for that commit and the next is held by whatever the view
now shows — the same answer as an anchor with nothing left
([below](#where-the-view-sits)).

A page count that went *down* is not a page landing, and the transcript reads the
tail again when it sees one. Paging starts over exactly one way — a re-subscribe
answered with a snapshot lands back on the newest page — and the rows an anchor names
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
page added — an empty one, or one whose items all drew nothing, simply
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
attached again when the scroll container mounts. A newest page that draws no
rows mounts none: the list shows its empty state, with no reserve and nothing
to ask from, until the first live message arrives. What it reports is acted on as
given: a delivered entry was computed at the most recent layout, which is one
this commit's own writes have already gone into.

Whatever has been paged in stays rendered: `MessageList` does not virtualize
([why not](#roads-not-taken)), and a collapsible body it has opened once stays
mounted so that reopening is free (`web/src/components/ui/CollapsibleBody.tsx`). Scrolling back therefore
grows the DOM for as long as the session stays open. That is the trade the
cursor makes affordable — growth happens one page at a time and only as the
user reads back towards it, where replaying the whole transcript on open imposed it on
every session — and a re-subscribe answered with a snapshot starts over from
the newest page.

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

The hook knows nothing of messages: it is handed what the end shows (a
signature compared by identity, which the dot below is read from) and, once per
commit, whether that commit reads the tail. The chat's answers to both —
`useMessagesTail` beside it — are what this section describes. A subagent's
transcript level is its other caller, on the level's parts, with rules of its
own on top ([subagent-transcript-ui.md](subagent-transcript-ui.md#following-the-live-tail)).

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
snapshot replacing the transcript all read the tail (a resumed reconnect
replaces nothing, and what it brings lands like any update). "Sent" is a row the user
typed among the rows added after the previous newest one — not necessarily the
newest itself, since a send to an idle agent lands with its reply's placeholder
below it. A count cannot say it, because a page landing above grows the list
without adding anything at its end, and it routinely lands under a transcript
whose newest row is one the reader typed. "Replaced" is the page count dropping,
or — when the page count has not changed — none of the previous rows
surviving, which is a different transcript: a re-subscribe of the same one keeps
its rows' ids. The
scroll-to-bottom button — shown only while reading somewhere — reads the tail, and
a jump — to a pending permission request, or from the turn's changes to a tool
row ([tool-call-ui.md](tool-call-ui.md#from-a-file-to-the-calls-that-changed-it))
— anchors on what it went to — on the card or row itself, with the candidates
around it as the path above it, since it need not be a candidate.

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
applied. Today that is the pending permission card's answer row. The marks
register themselves (`keepClearProps` is a ref, so it goes on an element with no
ref of its own) rather than being looked up: the check runs after every streamed
record while the view follows the tail, and a selector over the whole transcript
cost 10–30 ms there in a 300-turn session. Distance from
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

Session metadata and chat history are stored under the session data directory. History is JSON Lines of records (`agent.Record`) appended on each event. Both agents record where their side of the conversation lives, and reopen it on the next launch. Claude keeps its provider-side session ID in `claude_resume.json` as soon as the CLI reports it, and falls back through a recovery ladder (plain resume → fork → new session) when a launch turns out to be unresumable, so a session cannot be permanently stuck by a first turn that failed ([code/agent-integration.md](code/agent-integration.md#session-recovery-ladder)). Codex keeps a thread id in `codex_resume.json` and reopens the thread from the rollout file the CLI wrote to disk; when that file is gone the session starts a new thread and says so ([code/agent-integration.md](code/agent-integration.md#thread-recovery)). Pockode's own transcript survives either way; what a resume decides is whether the *agent* still has the context.

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
| `session_view.list` | `worktree`, `exclude_work_sessions?`, `exclude_permission_reviewer_sessions?`, `cursor?`, `limit?` | `sessions`, `next_cursor?`, `has_more` |
| `session_view.get` | `worktree`, `session_id` | `session` |
| `session_view.history` | `worktree`, `session_id`, `before_seq?`, `limit?` | `turns`, `has_more`, `next_before_seq?`, `through_seq?`, `plan?`, `server_time` |
| `session_view.attachment` | `worktree`, `session_id`, `id` | `file` |
| `session_view.html_page` | `worktree`, `session_id`, `id` | `page` |
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
