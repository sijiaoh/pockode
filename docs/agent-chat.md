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
| Transcript | `web/src/components/Chat/MessageList.tsx` | Rendering the loaded messages, and every scroll decision made over them: [where the view sits](#where-the-view-sits) (with `useTranscriptScroll.ts` and `scrollAnchor.ts` beside it), the sentinel behind [history paging](#history-paging), and the jump to a pending permission request ([lifecycle-ui.md §2.2](lifecycle-ui.md#22-chat-the-attention-strip)) |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission handling, and the session's unanswered questions |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage` (which carries `answering` when it is an answer, [answering-ui.md §3](answering-ui.md#3-the-answer-panel)), `interrupt`, `permissionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC
2. ChatClient persists message to session history, forwards to `Process.SendMessage()` — unless the turn is holding a permission request open, the one state a message cannot be delivered in, which is refused as `InvalidParams` with nothing written ([lifecycle.md](lifecycle.md#session-one-reducer)). A turn merely *running* is not refused; the message steers it, and the answer to it begins where the agent reads it rather than where the turn ends — for an agent that cannot report that moment itself, this is also where the read point record is written ([agent-event.md](agent-event.md#the-read-point-message_ingested)).
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, Done, etc.)
5. Events are broadcast to all WebSocket subscribers and persisted to session history
6. On `Done` event, process transitions to `idle`

Besides user-typed messages, the Work system pushes automatic prompts to the same session via `Client.SendSystemMessage`; these are tagged `origin: "system"` with a `meta` summary naming the work, so the frontend can render each as a one-line work event where it happened instead of as a user bubble. See [agent-event.md](agent-event.md#message-origin-user-vs-system) and [code/work-system.md](code/work-system.md#work-messages-in-chat).

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

A question does not block the agent, and its card is pushed out of view — often out of the loaded pages entirely — by whatever the agent streams next. So answering does not happen on the card: the unanswered questions are session state, answered in a card that puts itself up over the transcript — dimming that rectangle alone, and leaving the header, the strip and the composer lit and usable — and reached again, once it is closed, from a strip above the composer. That whole surface is [answering-ui.md](answering-ui.md); the card in the stream is only the record of what was asked.

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
mid-answer and the page above opens on content that no `message` event preceded,
and the two halves are joined. Text at the seam goes through the same rule
streaming uses, so a sentence — or a fenced code block — cut in two comes back as
one part.

The reducer produces a leading assistant message in one other case, and it is the
one case that must *not* be joined: a page beginning at a read point, where the
agent picked up a message recorded in that page and what follows answers it
rather than continuing the reply below
([code/agent-integration.md](code/agent-integration.md#the-read-point)). That
bubble says so on itself, so the seam can tell the two apart; joining it would
put the later message's answer back in the earlier message's bubble, once per
boundary that lands there.

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

Scroll position is held by holding one element still, not by comparing scroll
heights before and after — the agent can go on writing at the bottom while the
page is in flight, and that growth is indistinguishable from the growth above
that has to be compensated for. Beyond that, a page landing on top needs no rule
of its own: it moved the element the reader is looking at, and putting that
element back is what the transcript does after every commit
([where the view sits](#where-the-view-sits)).

One fact about the seam belongs here rather than there. The first loaded row and
its first part are never anchored to, because the first row is the one an
incoming page can be merged into and the merge keeps its identity
([code/frontend-state.md](code/frontend-state.md#turn-boundaries-and-late-events)).
The older half grows *inside* it, so holding its top edge still holds nothing
still: it carries everything the reader was looking at down the screen, which is
the jump the anchor exists to prevent. Every candidate below it moves with that
growth instead, which is what makes it measurable.

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
under the same ids and the anchor holds, and where it does not, a lost anchor is
replaced where the view already is.

**Asking for a page is a state, not an event.** While the top of history is on
screen, nothing is in flight and nothing has failed, the next page is asked for.
Two things notice that state and they answer different halves of it. The
`IntersectionObserver` on the sentinel is the only one that can see the reader
*arrive* there: scrolling commits nothing, so there is no frame in which the list
could have measured it. The measurement taken after every commit — once the
invariant has placed the view — is the only one that can see a page land without
carrying the sentinel out of view, which is every page in a transcript still
shorter than the viewport. An observer reports a *crossing*; nothing crossed, so
nothing is reported, and a short conversation would stop filling after one page.

Being asked twice is therefore ordinary, and harmless. A request made while one
is in flight is refused outright, and every request that does go out moves the
cursor further back, so the rule settles at `has_more` being false however many
times it is put. Nothing judges how much a page added — an empty one, or one
whose records all rendered to nothing, simply leads to the next — which is what
removed the last reason to ask whether "the view moved", and with it the stall
that question used to leave behind. The one state not answered from is a
container of zero height: it has not been laid out yet, and treating that as
"nothing is on screen" would ask for history nobody has come near.

The observer is never rebuilt per page. A fresh observer reports a target already
on screen immediately, so rebuilding it is a loop rather than a rule: one page
that leaves the sentinel where it was becomes an unbounded run of them. It lives
exactly as long as the sentinel node does, and what it reports is acted on as
given — a delivered entry was computed at the most recent layout, which is one
this commit's own write to `scrollTop` has already gone into.

The sentinel row keeps one height whether or not a page is loading, the spinner
appearing inside space already reserved for it. The row sits above everything the
reader is looking at, so growing it moves them. The anchor would put them back,
but putting them back is a write to `scrollTop`, and what brought the sentinel
into view was a flick whose momentum that write cancels — so the height is fixed
to save the write ([the gap that remains](#known-gaps-and-what-they-were-traded-for)).

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

## Where the View Sits

**Two states, and one action.**

| State | Invariant |
|---|---|
| reading the tail | the view is pinned to the end |
| reading somewhere | the anchored element stays the same distance below the container's top edge |

The action is "apply the invariant of the state you are in"
(`web/src/components/Chat/useTranscriptScroll.ts`), and it runs at exactly two
moments: after every commit of `MessageList`, before paint, and on every callback
of a `ResizeObserver` watching both boxes. A page landing, a diagram settling, a
card expanding, the keyboard opening, the container growing back as an overlay
closes — none of them is a case here, each being one of those two moments already.
Nothing is on a timer.

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
that moves nothing still costs something. "Already right" means within a pixel:
the two heights a scroll box is made of are integers while `scrollTop` is not.

**The anchor** is the last candidate element to start at or above the top edge of
the view, paired with how far below that edge it started. The candidates are
message rows *and* the top-level parts inside them
(`web/src/components/Chat/scrollAnchor.ts`): one assistant turn is a single row
and can be several screens tall, so anchoring on rows alone says nothing about
where inside one the reader is, and a tool result landing in that same bubble
above their eyes would push what they are reading down. Nothing inside a
collapsible body is a candidate — collapsed, it has no position at all — and
neither is the first row or its first part ([the paging
seam](#reading-a-page-on-the-client)). The anchor is taken again on every scroll
the reader causes, and one whose element has left the list is replaced by a fresh
anchor for wherever the view is now, never by a return to the tail.

**Only the reader's own scrolling changes the state**, and which scroll that was
is decided by direction rather than by listening for the gestures that caused it:

- Reading the tail, movement *upward* that does not come to rest near the end
  (50px) is the reader's, because our own writes here can only take the view
  down. A tap moves nothing and so never arrives at all; a browser find, which
  does move the view, is the reader.
- Reading somewhere, every scroll event is the reader's. Movement *downward* that
  reaches the end returns to the tail; anything else takes the anchor again. A
  restore of our own that lands here re-takes the same anchor in the same place,
  which costs nothing. The direction is required: a card collapsing *below* the
  reader clamps the view to the end, and without it that clamp would read as a
  return to the tail.

Sampling where the view happens to sit cannot tell those apart, and that is the
failure this replaced: a scroll event says where the view went one frame after it
went there, by which time the content has grown again, so a frame of our own
following read as the reader leaving.

**Explicit inputs** are the only other thing that moves the state. Opening a
session, the first message in an empty one, the reader sending a message and a
reconnect replacing the transcript all read the tail. "Sent" is the newest row's
id having changed to a row the user typed: a count cannot say it, because a page
landing above grows the list without adding anything at its end, and it routinely
lands under a transcript whose newest row is one the reader typed. The
scroll-to-bottom button — shown only while reading somewhere — reads the tail, and
a jump to a pending permission request anchors on the card.

Both move the view instantly, which is a decision and not an omission. Switching
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

The browser's own scroll anchoring is turned off on the container. The anchoring
here is written by hand, and leaving the browser's on means a second writer of
`scrollTop` that cannot be coordinated with. Safari does not implement scroll
anchoring at all, so leaving it on would not even produce the same disagreement
on each platform.

**An overlay covers the transcript rather than unmounting it**, so that the
reader gets back their place, the cards they had opened and the highlight ring —
none of which survive a remount, where the history would
([how, and why not `display: none`](answering-ui.md#it-is-modal-over-one-rectangle-and-nothing-else)).
The container is one height while covered and another when it comes back, which
is a resize, which is already the whole of the mechanism above.

## Content Height on the First Frame

A height that changes a few frames after the content commits no longer breaks
anything: the resize is the same event as everything else, and the invariant puts
the reader back. What it still costs is a write to `scrollTop` the reader can
feel — one more chance to cancel their momentum scrolling — and, in the tail
state, a threshold that has to be answered on the frame it is asked on: 50px
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
an image's intrinsic size — is given a reserved box instead
(`--async-media-height` in `web/src/index.css`). That reservation is no longer
part of any mechanism: it is there so the waiting state and the settled state are
roughly the same height and the transcript does not visibly jump between them. A
reservation is a guess, paid for in whitespace around images smaller than the
frame, and where it cannot be exact — a diagram is whatever size it turns out to
be — the difference is simply a resize like any other.

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
([turned off](#where-the-view-sits)).

**A ready-made follow library** (`use-stick-to-bottom` and its kind). What such
a library does is half of what is described here — a `ResizeObserver` and a held
intent — and it is the tail half only.
Reverse-infinite anchoring would still be written by hand, and the two halves
would then have to agree about who writes `scrollTop` and when. A dependency
that covers half of one problem and adds a coordination problem is not a saving.

## Known Gaps and What They Were Traded For

- **Growth above the anchor still cancels iOS momentum.** Holding an element
  still means writing `scrollTop`, and on iOS any write ends momentum scrolling —
  so a flick to the top of the transcript stops dead if the page it asked for
  lands while the finger is already off the screen. Nothing avoids the write
  without giving up the invariant it exists for; what can be done is to make
  fewer of them, which is why the sentinel row is a fixed height and why nothing
  in the transcript changes height after it commits if it can be helped
  ([above](#content-height-on-the-first-frame)).
- **A card expanded while reading the tail can be pushed out of view.** Opening a
  body adds height above the end, and re-pinning to the end carries the card that
  was just opened upward — off the top of the screen, if the body is tall enough.
  Holding the pressed header still instead would be a third state, "read the tail
  except over this element", for something the reader undoes with one scroll.
- **A mermaid diagram still jumps once**, from its reserved box to whatever size
  it renders at. Removing the jump would mean scaling every diagram into a fixed
  frame, which spends the readability of large diagrams — the thing they are
  there for — on a scroll-position detail. The invariant absorbs it: the reader
  keeps their place, the content below simply moves.
- **A page that fails moves the view once.** The sentinel row is held at one
  height so the spinner cannot push the transcript down, but the row a failure
  replaces it with carries the reason and a Retry button and is genuinely
  taller. Reserving that much space for a failure that normally never comes
  would put a gap above every conversation, and the jump lands on a reader who
  is being told, in that same row, what just happened.
- **The first layout of a session opens at the tail, whatever was asked for.** A
  conversation shorter than the viewport sits on its bottom edge, so a jump to a
  permission card in it cannot put the card at the top — there is nothing to
  scroll. Reloading the page on an overlay's URL comes back the same way: the
  transcript behind it is laid out for the first time and has no place to
  return the reader to yet. Both are the absence of a previous position rather
  than the loss of one.
- **An overlay does not stop paging.** `IntersectionObserver` is specified to
  ignore `visibility`, so a covered transcript whose sentinel is in view goes on
  asking for history — and the container growing by the height of the unmounted
  composer can bring the sentinel into view and buy one more page than the
  reader would have. It is harmless: it only happens to a reader already at the
  top of what is loaded, the cursor is finite and the run settles at `has_more`
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
