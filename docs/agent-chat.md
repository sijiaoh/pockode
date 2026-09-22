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
| Chat client | `server/chat/client.go` | Session coordination, message persistence, event broadcast; `SendMessageExcluding` (user) and `SendSystemMessage` (system automation) share one persist+broadcast path |
| Agent interface | `server/agent/agent.go` | `Session` and `AgentEvent` interfaces |
| Claude impl | `server/agent/claude/claude.go` | Claude CLI subprocess, stream-json parsing, MCP server config |
| Process manager | `server/process/manager.go` | Process lifecycle, event stream, lease reaper |
| Frontend panel | `web/src/components/Chat/ChatPanel.tsx` | Message list, input bar, engine (agent + model + effort) and mode selectors, and the session info button — the action bar's third control, whose panel holds what this session has spent ([usage-display-ui.md](usage-display-ui.md)) |
| Transcript | `web/src/components/Chat/MessageList.tsx` | Rendering the loaded messages, and every scroll decision made over them: [following the tail](#following-the-tail), the sentinel and anchor behind [history paging](#history-paging), and the jump to a pending permission request ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)) |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission handling, and the session's unanswered questions |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage` (which carries `answering` when it is an answer, [answering-ui.md §3](answering-ui.md#3-the-answer-panel)), `interrupt`, `permissionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC
2. ChatClient persists message to session history, forwards to `Process.SendMessage()` — unless the turn is holding a permission request open, the one state a message cannot be delivered in, which is refused as `InvalidParams` with nothing written ([lifecycle.md](lifecycle.md#session-one-reducer)). A turn merely *running* is not refused; the message steers it.
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, Done, etc.)
5. Events are broadcast to all WebSocket subscribers and persisted to session history
6. On `Done` event, process transitions to `idle`

Besides user-typed messages, the Work system pushes automatic prompts to the same session via `Client.SendSystemMessage`; these are tagged `origin: "system"` with a `meta` summary naming the work, so the frontend can render each as a one-line work event where it happened instead of as a user bubble. See [agent-event.md](agent-event.md#message-origin-user-vs-system) and [code/work-system.md](code/work-system.md#work-messages-in-chat).

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

A question does not block the agent, and its card is pushed out of view — often out of the loaded pages entirely — by whatever the agent streams next. So answering does not happen on the card: the unanswered questions are session state, answered in a drawer that puts itself up on the bottom edge of the transcript — leaving the conversation above it readable — and reached again, once it is closed, from a strip above the composer. That whole surface is [answering-ui.md](answering-ui.md); the card in the stream is only the record of what was asked.

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
keep a spinner running in the middle of the transcript — and with nothing left
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
mid-answer and the page above opens on content that no `message` event preceded;
the reducer produces a leading assistant message in that one case only, which is
what makes joining the two halves safe. Text at the seam goes through the same
rule streaming uses, so a sentence — or a fenced code block — cut in two comes
back as one part.

A turn is the *only* thing a boundary can split. Nothing else in the transcript
spans more than one record: a subagent Task is one tool-call part where its call
landed ([code/frontend-state.md](code/frontend-state.md#tool-runs)) and a work
event is one message where it happened
([code/work-system.md](code/work-system.md#rendering-in-the-transcript)), so
neither can arrive as two halves needing to be folded back together. That is not
an accident of how they happen to be rendered, it is a reason for rendering them
that way: anything aggregated across records has to be found and re-anchored at
every seam, and an event left where it landed never does.

Reconnecting re-subscribes and so lands back on the newest page: pages already
scrolled in are dropped rather than stitched back together, since the cursor
chain would have to be replayed from the bottom anyway.

Scroll position is held by pinning to a message, not by comparing scroll heights
before and after — the agent can go on writing at the bottom while the page is in
flight, and that growth is indistinguishable from the growth above that has to be
compensated for.

The message pinned to is the *second* one loaded, not the first. The first is the
one a seam can merge the incoming page into, and the merge keeps its identity,
the bubble being keyed on it
([code/frontend-state.md](code/frontend-state.md#turn-boundaries-and-late-events)).
Holding its top edge still therefore holds nothing still: the older half grows
*inside* it and carries everything the reader was looking at down the screen,
which is the jump the pin exists to prevent. Only that one message can be merged
into, so the one below it is a fixed point, and pinning it holds the first one's
own content still as well — the older half having gone in above it. A transcript
of a single message has no row below it and is pinned to that one; it is also far
shorter than the viewport, so there is no view position there for a merge to
lose.

The pin is taken again on every scroll until the page lands, rather than once
when it was asked for. A flick that brings the sentinel into view goes on
travelling after the request leaves, and restoring to where that flick started is
a yank backwards over content the reader has already gone past. The row's
position is re-read along with the view's: a late event can still grow a message
above it while the page is on its way, and a fresh view offset paired with a
stale row position charges the restore for that growth twice.

A page count that went *down* is not a page landing. Paging also starts over —
a reconnect re-subscribes and so lands back on the newest page — and the view the
pin was measured against is gone by then, so the page still in flight is dropped
rather than restored against whatever replaced it. Re-subscribing clears "a page
is loading" with it, the request it discards having learnt by the time it returns
that it no longer speaks for this transcript and so cleaning up nothing: a flag
left standing there would leave the transcript refusing to page for good, since
refusing while a page is on its way is exactly how it stays down to one.

Losing the pinned message is said out loud and falls back to the height
difference. That fallback is the measurement just ruled out, and it is wrong in
exactly the way described above: anything the agent wrote at the bottom while
the page was in flight is counted as growth above. It is taken anyway because
the alternative is restoring nothing, which leaves the view against the sentinel
— the one state that asks for page after page — and because a view moved too far
is a view the reader can see has moved.

The restore is not a single measurement. It is computed the moment the page is
committed, and what it measures is not final: syntax highlighting, a diagram and
an image each settle a few frames later, and each of them changes a height it was
computed from — which is the exception and not the rule
([why](#content-height-on-the-first-frame)). So the anchor is kept for a short
window after the page lands and the correction is repeated as the new content
settles, until the window closes or the view is deliberately taken elsewhere —
by the user scrolling, or by one of the scrolls started in code that carry an
intent of their own (the scroll-to-bottom button, a jump to a pending permission
request, the pin after a message is sent). From that point the view belongs to whatever
took it there, and a correction would pull it back off.

**Nothing asks for the next page until the one that landed has moved the view.**
Re-observing the sentinel on every page — which is what used to happen — is a
loop rather than a rule: a fresh observer reports a sentinel still on screen
immediately, and a page that failed to move the view leaves it exactly there, so
one page that restores short becomes an unbounded run of them. The sentinel is
therefore re-observed when the restore window closes, and only if the view
actually ended up further down than it started. A page too short to fill the
viewport still leaves the sentinel in view and so still leads to the next one —
one page per settled restore. A page that moved nothing, including an empty one
whose records all rendered to nothing, stops paging where it is and says so; the
reader's next gesture starts it again, one page at a time.

Each arming buys one request, and the observer is dropped as it fires. Left
watching, it reports every later crossing of the top edge as well — and the
corrections a settling page makes carry the sentinel back over that edge again
and again, so the loop returns in a second form, each correction asking for a
page nothing judged the need for.

Dropping it is safe rather than final because the request behind it is refused
outright while a page is in flight or still settling, and each of those states
ends by arming again or by stalling — a stall the reader's next gesture lifts.
The refusal is also what keeps the pin single: a page on its way owns it, and
re-pinning under that page would have it restored against a view measured after
it was asked for. A page that *fails* gives the pin up instead, never landing to
be restored against, so "a pin is held" and "a page is on its way" stay the same
fact — which is the fact the scroll handler above re-measures on.

The sentinel row keeps one height whether or not a page is loading, the spinner
appearing inside space already reserved for it. The row sits above everything the
reader is looking at, so growing it pushes the whole transcript down — a jump at
the moment paging *starts*, which no restore covers, because no page has landed
to be restored.

"The view moved" is the wrong question in one state, and it is the state every
short conversation starts in: until the transcript is taller than the viewport
there is nothing to scroll (the content box is `min-h-full`), so no page can
move the view however well it restored. There the rule asks instead whether the
page put any rows above the pinned one — which an empty page still does not — so
the filling that gets a short history onto the screen goes on working.

A page that fails replaces the sentinel with the reason and a Retry button, so
nothing is left to ask for the next page until the user presses it. Saying nothing would
read as *this is where the conversation starts* — the one conclusion a failure
must not let the user draw — and retrying on a sentinel that has not moved would
loop out of sight. "Beginning of conversation" is therefore said only on the
server's word that nothing older exists, and only to a user who has actually
scrolled back far enough to wonder.

Whatever has been paged in stays rendered: `MessageList` does not virtualize
([why not](#roads-not-taken)), and a collapsible body it has opened once stays
mounted so that reopening is free (`web/src/components/ui/CollapsibleBody.tsx`). Scrolling back therefore
grows the DOM for as long as the session stays open. That is the trade the
cursor makes affordable — growth happens one page at a time and only because the
user asked for it, where replaying the whole transcript on open imposed it on
every session — and a reconnect starts over from the newest page.

## Following the Tail

While an agent writes, the transcript has to stay pinned to its end without ever
taking the view away from a user who has gone looking for something further up.
What `MessageList` keeps is therefore an *intent* — whether the tail is what is
being read — and not a sample of where the view currently sits. The two are not
interchangeable: a programmatic smooth scroll dispatches the same scroll events
as a drag does, and every frame of one reads as "not at bottom", so a position
sample is torn down by the very scrolls that are trying to reach the tail. That
is why the scroll-to-bottom button used to be able to stop short and leave
following switched off behind it.

Only the user's own scrolling moves the intent, which is why the gestures that
scroll the container are listened to alongside the scroll events they cause: a
scroll event says where the view went, and the gesture says whose doing it was.
Every scroll started in code — the button, the jump to a pending permission
request, the pin after a message is sent — declares its own intent at the point
it is started, and is not allowed to have it overwritten by wherever it lands. A
jump to a request near the end of the transcript is the case that makes this
concrete: it comes to rest at the tail, and reading that arrival as the user
asking to follow again would let the next reflow drag the card they just asked
to see straight back off the screen.

Re-pinning is driven by a `ResizeObserver` watching **both** boxes. The content
growing is the obvious half; the container shrinking is the half that is easy to
miss and just as common, because the input box grows as it is typed into, an
error bar can appear above it, and the software keyboard takes half the screen —
none of which change the content's height while all of them push the tail out of
view.

The answer panel is the one thing that takes the tail away without either box
changing: it is a drawer *over* the bottom of the container rather than a box
above or below it, so neither observation sees it. `MessageList` is told instead
— `bottomInset`, the panel's own reported height — and pads its scroller by that
much, lifts the scroll-to-bottom button by it, and re-pins in a layout effect
when it changes, so the correction lands in the same paint as the padding that
needs it ([answering-ui.md §3](answering-ui.md#3-the-answer-panel)).

The browser's own scroll anchoring is turned off on the container. The anchoring
here is written by hand, for paging as much as for the tail, and leaving the
browser's on means a second writer of `scrollTop` that cannot be coordinated
with. Safari does not implement scroll anchoring at all, so leaving it on would
not even produce the same disagreement on each platform.

Pinning after the user sends a message is done in a layout effect rather than
from the `ResizeObserver`, even though the observer would eventually see the
same growth. The observer runs after paint and after anything else that has
moved the view in between, so the intent it reads is no longer the one the send
happened under; the layout effect reads it in the commit that added the message
and before the frame is shown (`adb5a81`). The first screen of a session is
pinned the same way and for a related reason — `MessageList` is keyed by the
session id, so a switch mounts a fresh scroll container sitting at the top of
the page it was given, and a pin taken after paint would flash the oldest
messages of the new session before jumping to its end.

A page landing on top is the one render that grows the transcript without adding
anything at its end, and the tail must not be followed to it. The restore effect
therefore runs *before* the follow effect and hands it the new message count on
the way past, so the follow effect finds no growth of its own to react to and
leaves the view where the restore just put it. That handover is nothing but the
order the two effects are declared in, which is why they cannot be reordered.

## Content Height on the First Frame

Both readers of height above measure on the frame their content commits: the
tail gate asks how far the view is from the end, the page restore asks how much
taller the transcript got above the anchor. Anything that learns its real size a
few frames later makes both of them answer a question about a layout that no
longer exists — and the failures that come out of that are the ones this
document keeps coming back to, a view that stops following after a long answer
and a page that restores short and asks for another.

The expensive case turned out not to be asynchronous rendering at all, but a
stylesheet. `react-shiki` hands back shiki's own `<pre>`, which ends up nested
inside `.code-block` and therefore inside `.prose`, where `@tailwindcss/typography`
gives every `pre` a `1.667em` margin; `.code-block`'s own reset only ever
covered the outer box. Every code block in the transcript grew by roughly 40px
the instant it was highlighted — against an at-bottom threshold of 50px, one
block put the view on the line and two took following off, and the same amount
was missing from every message a page restore measured. The rule that resets the
inner `pre` sits next to the `overflow` it lost in the same refactor
(`32e9811`), and the height now simply never changes.

What genuinely cannot be known early — the lazy chunk behind a mermaid diagram,
an image's intrinsic size — is given a reserved box instead
(`--async-media-height` in `web/src/index.css`), so the waiting state and the
settled state are the same height and the measurement taken between them is
still true. A reservation is a guess, and it is paid for in whitespace around
images smaller than the frame; what it buys is a transcript whose measurements
do not have to be taken twice. Where the reservation cannot be exact — a diagram
is whatever size it is — the restore window a page lands into absorbs the
difference. It exists because this could not be made true of everything.

An attachment in a tool result's strip needs no reservation of this kind,
because its shape is known before its bytes are: the block carries the
dimensions the server read out of the content's own header ([why they
travel](code/agent-integration.md#what-is-kept-and-what-is-only-described)), and
the placeholder and the loaded image are given the same box from them — a fixed
height and that aspect ratio, with a default shape for content that reported
none. So content fetched late, which it is (the read starts when the thumbnail
scrolls into view), lands in space that was already the right size.

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

**CSS `overflow-anchor` as the anchoring mechanism.** Safari does not implement
it, so on the platform this product is built for first it does nothing at all; a
hand-written anchor is required either way, which leaves the browser's version
as a second writer of `scrollTop` rather than a feature
([turned off](#following-the-tail)).

**A ready-made follow library** (`use-stick-to-bottom` and its kind). What such
a library does is what is described here — a `ResizeObserver`, an explicit
intent, correction repeated until the content settles — but only for the tail.
Reverse-infinite anchoring would still be written by hand, and the two halves
would then have to agree about who writes `scrollTop` and when. A dependency
that covers half of one problem and adds a coordination problem is not a saving.

## Known Gaps and What They Were Traded For

- **Find-in-page does not release following.** Only gestures on the container
  do, so a browser find (Ctrl+F) jumping to a match — driven by the user but
  arriving without a gesture — leaves the intent on, and the next streamed
  output pulls the view back to the tail. The alternative is to mark
  programmatic scrolls instead of user ones, which requires knowing when a
  smooth scroll has finished: `scrollend` is absent before Safari 18.2 and a
  timer heuristic is unreliable on the path every user takes. The failure was
  put on the narrow path rather than the everyday one, and one wheel notch or a
  press of the scroll-to-bottom button undoes it.
- **A mermaid diagram still jumps once**, from its reserved box to whatever size
  it renders at. Removing that jump would mean scaling every diagram into a
  fixed frame, which spends the readability of large diagrams — the thing they
  are there for — on a scroll-position detail. The restore window absorbs it
  instead.
- **The restore window is 500ms** (`RESTORE_SETTLE_MS`). It is a guess at how
  long a page's content takes to settle, and on a slow connection a mermaid
  chunk can land after it, leaving the view drifted by one diagram; it can no
  longer start another page, so the cost is a drift and not a run of requests.
  Raising it is safe in that direction and costs the other one: the window takes
  priority over following the tail, because a reader who just pulled in history
  is reading the history, so a longer window is a longer period in which output
  streaming at the bottom is not followed.
- **A stalled page says so in the console and nowhere in the UI.** The state is
  only reachable through an empty page or an anchor that went missing, neither
  of which should happen, and the recovery is exactly what the reader is already
  doing: the next scroll up asks for the next page. A button for a state that
  should not occur buys a hypothetical with real interface complexity; the
  warning is there for the developer who does reach it.
- **A page that fails moves the view once.** The sentinel row is held at one
  height so the spinner cannot push the transcript down, but the row a failure
  replaces it with carries the reason and a Retry button and is genuinely
  taller. Reserving that much space for a failure that normally never comes
  would put a gap above every conversation, and the jump lands on a reader who
  is being told, in that same row, what just happened.
- **A tap inside the list during a restore window counts as a gesture.**
  `pointerdown` cannot know in advance whether it will lead to a scroll, so the
  correction is cancelled and paging waits to be asked again. The cost is at
  most one page of automatic filling; the alternative is pairing each gesture
  with the scroll it causes, which iOS momentum — still scrolling long after the
  last `touchmove` — makes unreliable.

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
