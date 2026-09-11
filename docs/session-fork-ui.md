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

**A fork keeps everything up to and including the anchor message. Nothing after
the anchor enters the new session.**

One rule, no per-role variation. Anchoring on a user message therefore produces
a new session whose transcript ends with a message the agent has not answered —
that is the "ask it again, differently" case, and the user simply types the new
instruction. Anchoring on an assistant message produces "go back to the last
good answer and take the other road".

The original session is left completely untouched. It gains no marker, no
message, no status: its transcript is history, and history does not change
because something happened after it (see AGENTS.md, *Events are events, state is
state*). What the fork produced is recorded on the **child**, which is where it
is a live fact.

## Entry point

Every forkable message carries a `…` (`MoreHorizontal`) button in a thin action
row **under** the bubble, aligned to the bubble's own side — right for user
messages, left for assistant messages. It uses the app's existing inline icon
action — 36px, borderless, muted until hovered — so it reads as an affordance
and not as content. That class is `Git/iconButtonClass`, which is not a Git
fact; **move it to `common/iconButtonClass.ts`** and let both use it. (Not
`ui/ContentView`'s `actionIconButtonClass`: it carries a border and a filled
background, which is the right weight for a toolbar and far too loud repeated
under forty bubbles.)

Why not a long-press on the bubble: chat bubbles are the one place in this app
where users select and copy text, and long-press is how a phone starts a
selection. Why not tapping the bubble: bubbles already contain links, code
blocks and expandable tool calls, so the bubble itself has no free tap.

Tapping `…` opens `MessageMenu`, a `Sheet` titled with a one-line, truncated
preview of the message, holding one row today:

```
Fork from here            (GitBranch)
```

A sheet with a single row rather than a bare "fork" icon on every bubble: the
`…` → sheet shape is already the app's answer to "everything this row can do
beyond the one thing tapping it does" (`Files/FileEntryMenu`), and a branch icon
sitting on all forty bubbles of a transcript reads as decoration. Tapping the
row swaps the menu sheet for `ForkSessionSheet` in one commit — the same
self-replacing sheet pattern `Git/BranchSheet` uses for New branch.

### Where the `…` does not appear

- Work cards (`role: "work"`), step dividers (`role: "step_divider"`), and
  system-origin user messages (`source === "system"`, which already render as a
  collapsed banner rather than a bubble). None of these are conversation turns;
  they are Pockode's own annotations, and they have no bubble to hang an action
  row under.
- A message still `sending` or `streaming`, and any message holding a pending
  permission request or question. There is no settled transcript to cut at.
- A session with no messages. Nothing to fork.
- A message this tab sent itself, until the history is reloaded. The server
  leaves the sender out of its own broadcast, so the optimistic echo never
  receives a `seq` and cannot be named — and the client must not number it
  itself (see *Data contract*). Small in practice: the reply that follows it is
  addressable, and forking there keeps the same conversation.

A running turn does **not** disable anything above it. Forking an older, settled
message is well defined while the agent writes — everything the fork keeps is
already final, and everything still arriving falls after the anchor and is
dropped anyway. So the `…` neither blinks out for the length of every turn nor
opens onto a refusal; only the unsettled message itself is unforkable, which the
list above already covers.

## The fork sheet

`ForkSessionSheet`, a `Sheet` titled **Fork session**:

1. **Anchor preview** — the anchor message quoted read-only, clamped to three
   lines, prefixed by its role — `You`, or the agent's label from
   `AGENT_TYPE_INFO` (`Claude` / `Codex`). The user picked it from a scrolling
   transcript on a phone; showing it back is how they confirm they hit the
   right one.
2. **What is cut**, one line, with the real count — messages as the user sees
   them, counted over the whole transcript and not the 50-message window
   `MessageList` happens to have rendered:
   *"The new session keeps the conversation up to this message. The 28 messages
   after it stay in this session."*
   Singular form for one. This sentence is the whole mental model, so it is
   plain prose and not a diagram.
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
  is no fork to have memory in: the menu row is disabled and the backend refuses
  the request (*Blocked and failed* below). Codex is this case — a thread lives in
  the memory of the process that created it
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
storing the CLI's message ids, and one taken at a point the agent has not spoken
before — the user's own opening message, say, however long the conversation goes
on afterwards — which has no memory to carry in any case. Both get the same warning as any other
fork that could not carry memory.

**The fork sheet promises nothing about memory, and that is deliberate.** An agent
that cannot follow a fork never gets that far — the row is disabled before the
sheet opens. For one that can, a fork can still come back with nothing for
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

Nothing here fails silently, and no action that could have applied is hidden — a
hidden control teaches the user nothing (AGENTS.md, *Error handling*). That is
not in tension with *Where the `…` does not appear*: a work card is not a
conversation turn and a half-written message is not yet one, so there is nothing
there to refuse. Below are the cases where the user has asked for a fork of a
real message and cannot have it.

**The agent cannot fork at all** — the frontend is sent `fork_support: "none"` for
it, the server's answer for an agent that implements no `agent.SessionForker`;
Codex is that agent. The menu row renders disabled at `text-th-text-muted` with
the reason inline: *"<Agent> cannot reopen an earlier conversation, so its
sessions cannot be forked."* The wording puts it on the agent's missing ability,
not on Pockode having failed, so the user looks for another way to get what they
wanted instead of retrying. `session.fork` refuses the same case on the backend
(`ErrForkUnsupported`): blocking it here is the experience, refusing it there is
the contract.

**The request fails.** The sheet stays open and becomes dismissible again, the
server's message renders above the footer in `text-th-error`, and `Fork` returns
to its idle state. The app never navigates on failure — landing the user in a
session that may not exist is worse than the error. Retrying is pressing `Fork`
again.

## Components

New, all in `web/src/components/Chat/` unless noted:

| File | Role |
| --- | --- |
| `MessageActions.tsx` | The action row under a bubble; renders the `…`. Props: `{ side: "user" \| "assistant"; onOpenMenu: () => void }` |
| `MessageMenu.tsx` | `Sheet` of menu rows for one message. Props: `{ message, forkBlockedReason?, onFork, onClose }` |
| `ForkSessionSheet.tsx` | The confirm sheet above. Props: `{ anchor, droppedCount, agentType, defaultTitle, isForking, error, onFork, onClose }` |
| `ForkOriginBanner.tsx` | The lineage row at the top of `MessageList` |
| `common/MenuRow.tsx` | `MenuRow` + `rowClass`, **extracted from `Files/FileEntryMenu.tsx`**, which switches to the shared one. Two sheets of menu rows is where that stops being one component's private detail |
| `common/iconButtonClass.ts` | **Moved from `Git/`** unchanged; Git's call sites keep using it through the new path |

Changed:

- `MessageItem.tsx` — renders `MessageActions` for forkable messages; new
  optional prop `onOpenMessageMenu?: (messageId: string) => void`. Stable
  callback, since the component is `memo`.
- `MessageList.tsx` — the origin banner, and threading `onOpenMessageMenu`.
- `ChatPanel.tsx` — owns which message the menu is open for, owns the fork
  mutation and its in-flight/error state, and renders `MessageMenu` /
  `ForkSessionSheet`. The sheets are portals and the RPC is a session-level
  concern; neither belongs inside a message.
- `Session/SessionItem.tsx` — the `GitBranch` glyph in `leftSlot`.

Outside the component tree, because none of it is about rendering: the anchor and
what forking there costs (`utils/forkAnchor.ts`), the `(fork N)` title
(`utils/forkTitle.ts`), the disabled row's reason (`forkBlockedReason` in
`lib/agentType.ts`), the request with its in-flight and error state
(`hooks/useForkSession.ts`), and the capability — `lib/rpc/agent.ts` for the
call, `hooks/useForkSupport.ts` for the wait and the retry. The three pure ones
are unit-tested on their own; the hooks are covered through `ChatPanel`, which is
the only thing that mounts them.

## Data contract

Three things the UI needs. All have since landed on the backend; where what
shipped differs from what this section asked for, the note below the code block
says so, and the backend is the truth.

**1. A stable anchor.** Message ids are client-generated UUIDs
(`messageReducer`, `generateUUID`) that change on every reload, and one message
is folded from *several* history records, so neither a message id nor a message
index can name a cut point. Each history record needs a server-assigned,
monotonic **`seq`**, present both on `EventRecord` in stored history and on the
live event notifications the client subscribes to. A message then carries
`anchorSeq` — the `seq` of the last record folded into it — computed identically
for replayed and live messages, and "everything up to and including this
message" is `seq <= anchorSeq`. Server-side this resolves to the record index
`agent.TruncateHistory` already takes as `keepThrough`.

**The client must not derive that index by counting records itself** — the
counter drifts, silently, and the fork then cuts where nobody chose. Why, and
why the seqs a client holds are sparse without being wrong, is in
[code/agent-integration.md](code/agent-integration.md#history-storage); the rule
here is simply that a `seq` is read and quoted back, never computed.

**2. The RPC and the lineage fields.**

```
session.fork  { session_id, anchor_seq, title }  ->  SessionListItem
```

`SessionListItem` gains `forked_from?: { session_id: string }`.

Two corrections to what this section originally proposed, both settled on the
backend side and implemented that way. The result is returned bare rather than
wrapped in `{ session: ... }`, matching `session.create`. And `forked_from`
carries no denormalized title: a copy of the parent's name starts lying the
moment the parent is renamed, and the client is holding the session list
anyway — a parent it cannot find there has been deleted, which is the case this
document already specifies wording for.

The new session inherits the parent's `agent_type`, `mode` and worktree; a fork
that lands in a different worktree or under a different agent is a different
session, not a fork. It is born `activated: true` — it has a transcript — which
by the existing rule locks its agent selector, and that is the behaviour we
want: the inherited transcript was produced by that agent. `unread` and
`needs_input` start false.

A fork of a session that belongs to a work is **not** linked to that work. A
work owns one session, and a second one claiming the same work would make
`LinkedWorkButton`'s lookup ambiguous. The fork is an ordinary session.

**3. Who can be forked at all.** The menu has to know before it opens whether
this session's agent can follow a fork, and it must not know it by name:

```
agent.list  {}  ->  { agents: [{ type, fork_support }] }
```

One app-scoped call, answered from the server's own registry. The UI keeps no
table of its own — a second copy of this fact would disagree the day an agent
learns something new — and it is not a subscription: the answers come from the
implementations compiled into the server and cannot change while it runs. Until
the answer arrives, forking is offered; the reasoning for that default and for
retrying it after a reconnect is with the hook.

Accessibility: `Sheet` moves no focus of its own, anywhere in this app, so
opening either sheet by keyboard leaves focus on the `…` behind it. That gap is
inherited here rather than patched in one feature — same position
`Files/FileEntryMenu` already takes.

## Considered and not done

- **A "first instruction" field in the fork sheet**, sent automatically into the
  new session. It would turn fork-and-redirect into one tap, which is a real
  mobile win, but it is a second feature wearing the first one's clothes, and it
  makes the sheet's failure modes compound (forked but not sent?). The new
  session's input bar is one tap away.
- **`Copy text` in the message menu.** Genuinely useful on a phone, and the menu
  exists to hold it — but it is not this feature, and shipping the menu with one
  row is not a cost.
- **A marker on the parent.** Rejected on the grounds in *The rule*.
