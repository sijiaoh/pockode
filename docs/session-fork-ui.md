# Session Fork UI

How a user branches a new session off an existing one from a chosen message, in
`web/src/components/Chat/` and `web/src/components/Session/`: entry points,
interaction flow, copy, component boundaries, and the contract this UI holds the
backend to. It began as the design handed to implementation and now describes
what is there.

Related: [agent-chat.md](agent-chat.md) for how a session talks to an agent,
[code/agent-integration.md](code/agent-integration.md#session-forking) for what a
fork means on the server and to the agent, [sidebar-ui.md](sidebar-ui.md) for the
list this feature adds a marker to.

## The rule

**A fork returns to the moment before the anchor message happened.** Nothing
from that moment on enters the new session.

One rule, but it lands on either side of the anchor, because *before it
happened* depends on who was speaking:

- **An assistant anchor is kept.** The agent had finished saying it, so that
  moment is after the message. This is "go back to the last good answer and take
  the other road".
- **A user anchor is not.** They had not said it yet, so the new session never
  shows it. This is "ask it again, differently" — and the words are not lost;
  they reappear as a draft in the new session's input box (*The dropped prompt*).

The literal one-sided reading — *keep up to and including the anchor* — is what
shipped first, and it made the transcript lie. Pockode has no CLI message id for
the prompts it sends, so a fork anchored on a user message could never resume
the agent *at* that message; it resumed at the agent's previous one
([code/agent-integration.md](code/agent-integration.md#forking)). The new session
opened on a last message its own agent had never been given. Cutting that message
away is what makes the transcript show what the agent actually carries — the
display and the context now end in the same place. It also matches what users
arrive expecting: Claude Code's `/rewind` drops the chosen prompt out of the
conversation and puts it back in the input box.

Which side the cut falls on is **the server's** decision, made in exactly one
place (`chat.Client.Fork`). The client sends back the seq of the message the user
touched and does no arithmetic on it (*Data contract*).

A user anchor with nothing before it — the session's opening prompt — is
therefore not a fork at all: there would be no conversation to keep. The server
refuses it (`ErrForkAnchorNoHistory`) and the UI says so before the user asks
(*Blocked and failed*).

The original session is left completely untouched. It gains no marker, no
message, no status: its transcript is history, and history does not change
because something happened after it (see AGENTS.md, *Events are events, state is
state*). What the fork produced is recorded on the **child**, which is where it
is a live fact.

## Entry point

Every message that is a conversation turn carries a thin action row **under**
the bubble, aligned to the bubble's own side — right for user messages, left for
assistant messages. Fork stands on that row directly, as a `GitBranch` icon; a
row with no action to hold is not drawn at all. One fork concept gets one glyph:
the origin banner and the sidebar marker already use `GitBranch`, so the row
introduces no second one. The icon uses the app's existing inline icon action —
36px of visual weight, borderless, muted until hovered, grown to a 44px hit area
where a finger may land
([responsive-ui.md](responsive-ui.md#hit-areas-and-spacing)) — so it reads as an
affordance and not as content. That class is `ui/iconButtonClass`, already
shared by the Git and Files panels; the chat row is a third caller, not a reason
to move it. (Not `ui/ContentView`'s `actionIconButtonClass`: it carries a border
and a filled background, which is the right weight for a toolbar and far too
loud repeated under forty bubbles.)

Why not a long-press on the bubble: chat bubbles are the one place in this app
where users select and copy text, and long-press is how a phone starts a
selection. Why not tapping the bubble: bubbles already contain links, code
blocks and expandable tool calls, so the bubble itself has no free tap.

Standing on the row rather than behind a `…` that opens a single-row sheet,
which is what shipped first. Fork is a primary action and this app's main
pointer is a thumb, so the first rung of
[responsive-ui.md](responsive-ui.md#where-a-p1-goes-when-there-is-no-hover) —
always visible — is the answer; the sheet charged two taps to reach the only
thing it held. The argument that built the `…` ("a branch glyph under forty
bubbles reads as decoration") is not wrong, and it survives — but as a limit on
*how many* icons the row may carry and on *which sessions* get one at all, not
as a reason to hide the first one.

Nor is the icon revealed on hover, which
[responsive-ui.md](responsive-ui.md#the-one-authorized-form) would have allowed.
A control revealed that way is already always visible to a thumb, so the only
thing the form would buy is a quieter desktop — paid for by fork being easy to
find on one pointer and invisible on the other, which is exactly the split the
row was changed to close.

Rules for the row, settled once so it is not redesigned per icon:

- **Order is append-only.** A new action goes last; existing ones never move.
  What that protects is muscle memory, which is why no second rule is allowed on
  top of it — "most used first" and "destructive last" both require reordering,
  and two rules that contradict each other are no rule.
- **Both sides read left to right, not mirrored.** Mirroring for the user side
  would put the same action in a different relative place depending on who
  spoke, and scanning costs more than alignment saves.
- **Three standing icons is the ceiling.** Past that the first two stay and the
  rest fold behind a `…` into an overflow sheet — rung 2, and the deleted
  `MessageMenu` can come back out of git history to be it, this time as "what
  did not fit" rather than "everything this message can do". The ceiling is
  visual noise, not width: this row has no title whose truncation room icons
  could eat, which is the criterion rung 2 is actually written against.

### Which messages get the row, and when fork is on it

Two separate questions, and they must stay separate. The row belongs to every
per-message action, so a reason **fork in particular** does not apply must not
take the row — and with it every future action — away. The split lives in two
files that say which is which: `utils/messageActions.ts` answers the first,
`utils/forkAnchor.ts` the second.

**1. Does this message have an action row?** (`hasMessageActions`)

- Work cards (`role: "work"`), step dividers (`role: "step_divider"`), and
  system-origin user messages (`source === "system"`, which already render as a
  collapsed banner rather than a bubble) get none. They are not conversation
  turns; they are Pockode's own annotations, and they have no bubble to hang a
  row under.
- A message still `sending` or `streaming` gets none either — it is not yet a
  turn, and a row appearing mid-word would make the line twitch as the agent
  types.

**2. Can fork run on this message?** (`isForkableMessage` +
`resolveForkAnchor`)

- A message no record names cannot be pointed at, and the client must not
  number it itself (*Data contract*). Two ways to get there, both rare: the
  server could not persist the record, or it is too old to answer
  `chat.message` with a seq at all — for such a server, every message this tab
  sends stays unaddressable until a reload.
- A message holding a pending permission request or question is not a settled
  transcript to cut at.
- A user message that opens the transcript has nothing behind it to keep
  (*The rule*). This one needs the message's *position*, which is why it is
  `resolveForkAnchor`'s answer and not `isForkableMessage`'s.

Neither of the first two is a verdict on the message itself, so they leave the
icon in place and quiet rather than removing it (*Blocked and failed*). Neither
is on a clock either — an answer settles the request, a reload names what the
old server would not — so the label promises no more than that this is not how
the message will stay. It is stretched furthest by a record that failed to
persist, which this session will never name: that message does not survive a
reload either, so the label outlives its subject rather than lying to anyone
who can still act on it. Were the two questions still one, as they were while
`isForkableMessage` gated the row itself, a missing `seq` would silently cost
the message every other action it will ever be given.

**A message the user just sent is not in that set, and closing that hole is why
`chat.message` has a reply at all.** The server leaves a sender out of the
broadcast carrying every other record's `seq` — it has already echoed the message
into its own transcript — so the reply is the one place it can learn where its
own message landed (`rpc.MessageResult`). Without it every prompt typed since the
page loaded wore a greyed-out fork icon until a reload, which is precisely the
message this feature exists to fork from, at precisely the moment the user wants
to: just after reading an answer they did not like. Rewording the label would
have described that state more honestly without making it any less useless.

A running turn does **not** disable anything above it. Forking an older, settled
message is well defined while the agent writes — everything the fork keeps is
already final, and everything still arriving falls after the anchor and is
dropped anyway. So the icon neither blinks out for the length of every turn nor
opens onto a refusal; only the unsettled message itself is unforkable.

## The fork sheet

`ForkSessionSheet`, a `Sheet` titled **Fork session**:

1. **Anchor preview** — the anchor message quoted read-only, clamped to three
   lines, prefixed by its role — `You`, or the agent's label from
   `AGENT_TYPE_INFO` (`Claude` / `Codex`). The user picked it from a scrolling
   transcript on a phone; showing it back is how they confirm they hit the
   right one. The preview does not say whether the quoted message is the last
   one kept or the first one left behind; the sentence under it does.
2. **What is cut**, one line, with the real count — messages as the user sees
   them, counted over the whole transcript and not the 50-message window
   `MessageList` happens to have rendered. Two sentences, because *The rule*
   lands on two sides and "up to this message" would be a lie on one of them:
   - assistant anchor: *"The new session keeps the conversation up to this
     message. The 28 messages after it stay in this session."*
   - user anchor: *"The new session keeps the conversation up to just before
     this message. This message and the 28 after it stay in this session."*

   Singular forms for one, and the user shape has no zero case — the anchor
   itself is always one of the messages staying behind. This sentence is the
   whole mental model, so it is plain prose and not a diagram.
3. **Title** — a single-line input, pre-filled (see *Naming*), editable.

The sheet says nothing about whether the agent will remember the conversation —
see *What the agent remembers* below for why there is nothing left for it to
predict.

Footer: `Cancel` and a primary `Fork`.

In flight, `Fork` becomes `Forking…` and disables, and the sheet is passed
`dismissible={false}` — which is exactly what that prop is for: over a slow
relay link the user must not be able to dismiss the sheet and be left unsure
whether a session was created.

## What the agent remembers

A fork copies Pockode's transcript. Whether the **agent** arrives in the new
session still remembering that transcript is a separate question, and the answer
depends on what its CLI can reopen.

The question is asked of the agent's declared capability, never of its name. Each
agent declares for itself — by implementing `agent.SessionForker` or not — and the
server sends the resulting table to the frontend (`agent.list`), so the UI asks
*can this agent follow a fork* rather than *is this Codex*
([code/agent-integration.md](code/agent-integration.md#session-forking)).

- **`"none"`** — the agent cannot reopen an earlier conversation at all, so there
  is no fork to have memory in: the session gets no fork icon at all and the
  backend refuses the request (*Blocked and failed* below). Codex is this case —
  a thread lives in the memory of the process that created it
  ([code/agent-integration.md](code/agent-integration.md#no-forking)).
- **`"any_message"`** — the agent can reopen a conversation at a chosen message in
  it, so a fork can carry memory wherever the anchor sits, and a live source
  process does not matter: the point is pinned, so whatever the source adds falls
  past it. Claude is this case (`--resume-session-at`).

Pinning the resume point is what makes the feature work, and it is the only thing
that does: a fork whose kept records name no point carries nothing at all. There
is no fallback that replays the source's conversation whole, because the agent
reopens that conversation only when the user first types into the fork — which
can be long afterwards, and after the user has gone back to talking to the
source, so an uncut replay would deliver the very turns the fork was taken to
leave behind ([code/agent-integration.md](code/agent-integration.md#forking)).
Two kinds of fork name no point: one taken in a session that predates Pockode
storing the CLI's message ids, and one taken in a session the agent never spoke
in at all, which has no memory to carry in any case. Both get the same warning as
any other fork that could not carry memory.

**The fork sheet promises nothing about memory, and that is deliberate.** An agent
that cannot follow a fork never gets that far — the icon is never drawn, so the
sheet never opens. For one that can, a fork can still come back with nothing for
server-side facts no client can see: a source that never ran that agent, or whose
provider conversation the agent already gave up on. The UI does not guess at
those. The backend states the fact where it cannot be missed instead — a history
record in the forked transcript (`chat.Client.Fork`, written on the `carried ==
false` answer described in `server/agent/fork.go`, `SessionForker`), rendered
through the existing `WarningItem`, the same shape Codex's restart warning uses:

> **<Agent> will not remember this conversation.** The new session keeps the
> transcript, but the agent starts fresh — the earlier conversation could not be
> reopened. Tell it what you need in your first message.

One fact, one wording, one place — do not let a second appear.

## Naming

Pre-filled with the parent's title plus a ` (fork)` suffix, stripping any
`(fork)` / `(fork N)` the parent already carries so forks of forks do not stack
suffixes. The number is the lowest one not already taken by a session in this
worktree — `(fork)`, then `(fork 2)`, `(fork 3)` — which the client computes off
the session list it already holds, so forking the same conversation twice does
not produce two rows with one identical name. Dumb, deterministic, and it keeps
the lineage legible in a sidebar sorted by recency, where the parent and child
otherwise sit next to each other.

Not derived from the anchor message's text (the way a first message titles a
`New Chat`): a fork's subject is the parent's subject, and losing that in the
name costs more than a sharper title gains. The field is editable anyway.

## After forking

The app **navigates to the new session** and the sheet closes. On a phone, the
user just made a thing; leaving them in the parent to go hunt for it in the
sidebar is the wrong end of the trade. This reuses the navigation `AppShell`
already performs after `createSession`.

There is no toast — the app has no toast system, and does not need one here. The
confirmation is that the user is now looking at the new session, scrolled to the
end of the copied transcript, under a banner that says where it came from. When
the agent will not remember the conversation, the warning record the backend
appends is the last thing in that transcript, so it lands directly above the
input bar the user is about to type into — which is exactly where it is worth
reading.

## The dropped prompt

A fork anchored on the user's own message drops that message (*The rule*), and
the words come back as a **draft in the new session's input box**. Without it the
user would land in a fresh session facing an empty box, having to go back to the
parent to copy what they had just written.

Three things to be exact about:

- **It is a draft, not a message.** It is unsent, it is not in the transcript,
  and the server does not know it exists. It is written to `lib/inputStore`, the
  per-session store that already holds "what this session has typed but not
  sent" — no new state was introduced for this, and no history record was
  touched (AGENTS.md, *Events are events, state is state*). The store now has a
  second writer; it still has exactly one reader, `InputBar`.
- **It does not happen on an assistant anchor.** That message is kept by the
  fork, so there is nothing to hand back.
- **It does not focus the input on a coarse pointer.** `InputBar` focuses on a
  session change only for a fine pointer, deliberately: a software keyboard
  springing up would cover the conversation the user just opened. Restoring a
  draft is not a reason to overturn that — the text is sitting there, and one tap
  reaches it, which is cheaper than a keyboard in the face after every fork. The
  caret needs no help either way: setting a textarea's value leaves it after the
  text, ready to edit or send.

## Lineage

Shown in exactly two places, both on the child.

**Top of the child's transcript** — `ForkOriginBanner`, the first item in
`MessageList`, in the low-contrast hairline style of `StepDividerItem` and
`SystemMessageItem`, with a `GitBranch` icon:

```
Forked from "Refactor the session store"
```

Tapping it navigates to the parent session. If the parent has been deleted, the
same row renders as plain text, not a button: *"Forked from a deleted session"*.

The transcript's top, not the chat header: the header belongs to the project
title (`MainContainer title={projectTitle}`), and more to the point, "this
conversation begins as a copy of another one" is a fact about where the
transcript starts — the top of the transcript is literally where it belongs.

`MessageList` pages history 50 messages at a time from the bottom, so the banner
renders **only when the top of history is actually on screen** (`startIndex ===
0`). A banner pinned above a window into the middle of a transcript would claim
a position it does not have.

**The sidebar row** — a small `GitBranch` glyph in `SidebarListItem`'s existing
`leftSlot`, with the row's accessible name extended to
`"<title>, forked from <parent title>"`.

No nesting, no indentation, no parent/child grouping in the list. The session
list is sorted by recency and scanned top-down; a tree fights that sort, and it
has to answer for forks of forks and for parents that have been deleted. A glyph
answers the only question the list is asked — *"why are there two of these?"*

## Blocked and failed

Nothing here fails silently, and no action that **could have applied** is hidden
— a hidden control teaches the user nothing (AGENTS.md, *Error handling*). That
rule is about actions that apply to this message and cannot run right now; it
says nothing about an action that was never on offer in the first place, which is
the distinction the two cases below turn on.

**The agent cannot fork at all** — the frontend is sent `fork_support: "none"` for
it, the server's answer for an agent that implements no `agent.SessionForker`;
Codex is that agent. **The whole session renders no fork icon** — and since fork
is the row's only occupant today, no action row either. Not a disabled icon: a
branch glyph hanging under all forty bubbles of a Codex transcript, grey
and permanently unpressable, is exactly the decoration this document argued
against — in its worst form, since it is noise that never becomes usable. Fork is
not an action being refused in these sessions; it is a feature that has never
applied to them. `session.fork` refuses the same case on the backend
(`ErrForkUnsupported`): hiding it here is the experience, refusing it there is
the contract.

The cost of that choice, recorded because it is deliberate: the sentence *"Codex
cannot reopen an earlier conversation, so its sessions cannot be forked"* now has
nowhere in the frontend to be said, and the helper that produced it
(`forkBlockedReason` in `lib/agentType.ts`) is gone. A branch icon under every
bubble was the wrong place to say it. If it is worth saying, the place is
somewhere session-scoped — settings, or the engine selector — said once.

**Fork applies to this message but cannot run on it** — the icon stays exactly
where it is and goes quiet (`disabled`, `iconButtonClass(true)`). A control that
vanishes from under the user's thumb is worse than one that says no. There are
two of these, and they must not share a sentence, because one of them is waiting
for something and the other is not:

| | Reason | `aria-label` |
| --- | --- | --- |
| **Not yet** | A pending permission request or question, or the rare message no record names | *"Fork from here, not available yet"* |
| **Permanent** | A user message that opens the session: nothing before it to keep | *"Fork from here, nothing before this message to keep"* |

The permanent reason is asked **first** (`forkBlockedReason` in
`MessageItem.tsx`). The two can land on the same message — an opening prompt
whose record failed to persist is both — and "yet" would there be promising a
wait that never ends.

Neither opens a sheet, and `ForkSessionSheet` has no blocked variant: the first
is not the message's permanent state, which does not earn that machinery, and
the second is fully stated by its label. The reason rides the label rather than
a `title`, because a tooltip never fires on a touch device — anything living
only there is out of a finger's reach ([responsive-ui.md](responsive-ui.md)).

"Nothing before this message to keep" is stated in three layers, on purpose:
`chat.Client.Fork` refuses it (correctness), `resolveForkAnchor` returns no
anchor (so the sheet cannot open onto a request that must fail), and the icon
carries the label (so the user is told without pressing). Three copies of one
rule is a maintenance debt worth naming — change one and check the other two.

**The request fails.** The sheet stays open and becomes dismissible again, the
server's message renders above the footer in `text-th-error`, and `Fork` returns
to its idle state. The app never navigates on failure — landing the user in a
session that may not exist is worse than the error. Retrying is pressing `Fork`
again.

## Components

New, all in `web/src/components/Chat/` unless noted:

| File | Role |
| --- | --- |
| `MessageActions.tsx` | The action row under a bubble. Props: `{ side: "user" \| "assistant"; onFork?: () => void; forkBlocked?: "not-yet" \| "nothing-before" }`. No `onFork` means fork is not on offer in this session at all — see `ChatPanel` below for the two reasons — and with no action left to draw the row renders nothing, an empty row being a line of padding with nothing in it |
| `ForkSessionSheet.tsx` | The confirm sheet above. Props: `{ anchor, droppedCount, agentType, defaultTitle, isForking, error, onFork, onClose }` |
| `ForkOriginBanner.tsx` | The lineage row at the top of `MessageList` |
| `ui/iconButtonClass.ts` | Reused as-is; the chat row is its third caller after the Git and Files panels |

`MessageMenu.tsx` was the `…` sheet and is **deleted** with it. `common/MenuRow`
stays — `Files/FileEntryMenu` is still built out of it — but it is once again one
menu's component rather than a shared one, and `menuRowClass` is no longer
exported: the disabled row that needed the bare class went with the menu.

Changed:

- `MessageItem.tsx` — renders `MessageActions` for every conversation turn, and
  decides fork's blocked reason. New optional props `onForkMessage?: (messageId:
  string) => void` (stable, since the component is `memo`) and `isFirst?:
  boolean` — first in the *whole* transcript, not in the rendered window, since
  that is what decides whether a fork here has anything behind it to keep.
- `MessageList.tsx` — the origin banner, and threading `onForkMessage` and
  `isFirst`.
- `ChatPanel.tsx` — owns which message a fork is being confirmed for, owns the
  fork mutation and its in-flight/error state, renders `ForkSessionSheet`, and
  writes the dropped prompt into the draft store before navigating. The sheet is
  a portal and the RPC is a session-level concern; neither belongs inside a
  message. It is also where `onForkMessage` is withheld — from a host that
  cannot navigate, or an agent that cannot be forked — because both facts are
  session-wide, and a second copy of that policy inside `MessageActions` would
  one day disagree with this one.
- `Session/SessionItem.tsx` — the `GitBranch` glyph in `leftSlot`.

Outside the component tree, because none of it is about rendering: which messages
get an action row at all (`utils/messageActions.ts` — deliberately not in
`forkAnchor.ts`, whose name would start lying the moment a second action lands),
the anchor and what forking there costs (`utils/forkAnchor.ts`), the `(fork N)`
title (`utils/forkTitle.ts`), the request with its in-flight and error state
(`hooks/useForkSession.ts`), and the capability — `lib/rpc/agent.ts` for the
call, `hooks/useForkSupport.ts` for the wait and the retry. The pure ones are
unit-tested on their own; the hooks are covered through `ChatPanel`, which is the
only thing that mounts them.

## Data contract

Three things the UI needs. All have since landed on the backend; where what
shipped differs from what this section asked for, the note below the code block
says so, and the backend is the truth.

**1. A stable anchor.** Message ids are client-generated UUIDs
(`messageReducer`, `generateUUID`) that change on every reload, and one message
is folded from *several* history records, so neither a message id nor a message
index can name a cut point. Each history record needs a server-assigned,
monotonic **`seq`**, reaching the client by all three routes a record can
arrive on: `EventRecord` in stored history, the live event notification, and —
for the one message a sender is excluded from being told about, its own — the
reply to `chat.message` (`rpc.MessageResult`). A message then carries
`anchorSeq` — the `seq` of the last record folded into it — computed identically
whichever route delivered it, so what a client can fork from does not depend on
how it came to be looking at the message. The client quotes that number back
untouched; the server turns it into the record index `agent.TruncateHistory`
takes as `keepThrough`, and it is the server that decides whether the anchor's
own record is included (assistant) or stepped back past (user, per *The rule*).

**The client must not derive that index by counting records itself, nor do
arithmetic on a seq it was given** — the counter drifts, silently, and the fork
then cuts where nobody chose. Stepping back past a user anchor looks like it
could be done in the sheet, where the message roles are right there; it is not,
because a seq is an address and the record before a message is not "its seq
minus one". Why, and why the seqs a client holds are sparse without being
wrong, is in
[code/agent-integration.md](code/agent-integration.md#history-storage); the rule
here is simply that a `seq` is read and quoted back, never computed.

**2. The RPC and the lineage fields.**

```
session.fork  { session_id, anchor_seq, title }  ->  SessionListItem
```

`anchor_seq` is a wire field whose *meaning* changed when *The rule* did: it
names the message the user picked, not the last record kept. The two halves
should ship together, and one direction is worse than the other. A client older
than the server is survivable: it sends the same seq, the server cuts correctly,
and only its own sentence about how many messages stay behind is off by one —
while the new refusal reaches the user through the error path it already
renders. A client *newer* than the server is the real mismatch: it promises the
anchor is dropped and an old server keeps it, with nothing on the wire to reveal
the disagreement. There is no graceful degradation for that one, only deployment
order.

`SessionListItem` gains `forked_from?: { session_id: string }`.

Two corrections to what this section originally proposed, both settled on the
backend side and implemented that way. The result is returned bare rather than
wrapped in `{ session: ... }`, matching `session.create`. And `forked_from`
carries no denormalized title: a copy of the parent's name starts lying the
moment the parent is renamed, and the client is holding the session list
anyway — a parent it cannot find there has been deleted, which is the case this
document already specifies wording for.

The new session inherits the parent's whole engine choice — `agent_type`,
`mode`, `model` and `effort` — and its worktree; a fork that lands in a different
worktree, or answers on a different agent or model, is a different session, not a
fork. It is born `activated: true` — it has a transcript — which by the existing
rule locks the agent half of its engine selector, and that is the behaviour we
want: the inherited transcript was produced by that agent. Model and effort stay
changeable, as on any activated session. `unread` and `needs_input` start false.

A fork of a session that belongs to a work is **not** linked to that work. A
work owns one session, and a second one claiming the same work would make
`LinkedWorkButton`'s lookup ambiguous. The fork is an ordinary session.

**3. Who can be forked at all.** The transcript has to know, before it draws a
single action row, whether this session's agent can follow a fork — and it must
not know it by name:

```
agent.list  {}  ->  { agents: [{ type, fork_support }] }
```

One app-scoped call, answered from the server's own registry. The UI keeps no
table of its own — a second copy of this fact would disagree the day an agent
learns something new — and it is not a subscription: the answers come from the
implementations compiled into the server and cannot change while it runs. Until
the answer arrives, forking is offered; the reasoning for that default and for
retrying it after a reconnect is with the hook. Standing icons make that default
visible — in a session that turns out to answer `"none"`, the icons appear and
then go away once. Accepted, and not patched over with a second default inside
the component, which would be a copy of the hook's policy waiting to disagree
with it.

Accessibility: `Sheet` moves no focus of its own, anywhere in this app, so
opening the fork sheet by keyboard leaves focus on the icon behind it. That gap
is inherited here rather than patched in one feature — same position
`Files/FileEntryMenu` already takes.

## Considered and not done

- **A "first instruction" field in the fork sheet**, sent automatically into the
  new session. It would turn fork-and-redirect into one tap, which is a real
  mobile win, but it is a second feature wearing the first one's clothes, and it
  makes the sheet's failure modes compound (forked but not sent?). The new
  session's input bar is one tap away — and on the case this would have helped
  most, forking off one's own prompt, the text is already sitting in it
  (*The dropped prompt*).
- **`Copy text` on the action row.** Genuinely useful on a phone, and the row is
  built to take it — the *Which messages get the row* split exists precisely so
  that the second action does not inherit fork's reasons for being unavailable.
  It is still not this feature. No placeholder was left for it either; the row is
  the placeholder.
- **A marker on the parent.** Rejected on the grounds in *The rule*.
