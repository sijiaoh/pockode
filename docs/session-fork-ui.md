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

Every row of a session that can fork reserves a **36px slot beside the bubble,
on the inside** — the side facing the middle of the conversation, so right of an
assistant bubble and left of a user one — 8px clear of it, 44px of the row's
width in all. In the slot stands a `MoreHorizontal` `…`; pressing it opens a
`Sheet` in which fork is a row.

The inside is where the slot goes because the outside is the avatar's, and
because the inside is space the message was leaving empty anyway. One sentence
covers both sides: **the trigger always hugs the bubble's edge that faces the
middle of the conversation.** The two sides are mirrored by that rule, which
cost something under a row of icons read left to right and costs nothing now — a
menu has one way in and no reading order to get backwards.

It hugs the bubble rather than aligning to a fixed vertical rule down the edge
of the row. Pinning it out there would buy a tidy column of dots, at the price
of a two-word user message whose `…` floats half a screen from anything it
belongs to. **Belonging beats alignment.**

Vertically it sits at the bubble's **end** (`self-end`). That is less a rule
laid over the row than one taken off it: both bubble rows are already
`items-end`, so that the avatar sits on the baseline, and the slot used to
override them with `self-start`. It is still written out rather than inherited,
because where the `…` sits is the slot's own rule, while the rows that host one
set their alignment for reasons of their own — an avatar to level, a full-bleed
line to start at the top. Inherited, the glyph would move the next time one of
those reasons changed, and the author would not know they had moved it. Written,
it is one line, readable and greppable.

A bubble can be several screens tall — a diff, a long tool call — and then the
`…` is off screen until the user scrolls to the message's end. That cost is the
mirror of the one top alignment paid, not a new one: pinned to the top, the
trigger asked the user to scroll back to a long message's *beginning*. What the
flip trades is which end the user is more often already at. When a turn has just
settled — the moment the glyph fades in, and the moment a fork is most often
wanted — the eye is at the bubble's **bottom**, where the writing just appeared;
only when scrolling back through old messages is the top the nearer edge. The
common path wins.

Belonging survives the move on the current numbers, and only on them. Bottom
alignment puts the `…` beside the seam with the next row, but the row spacing
`py-1.5 sm:py-2` (12–16px between neighbours) is wider than the in-row `gap-2`
(8px), so the glyph is still nearer the bubble it belongs to than the row below.
**Tighten the row spacing and this has to be checked again.**

The work event row (`items-start`) is the one place the slot no longer agrees
with the row around it, and there the difference is invisible: that slot is
always empty, since `hasMessageActions` is false for `source === "system"`. The
boundary worth recording is a future one — if such a row ever does draw a glyph,
`self-end` would put it at the bottom of a body that runs to 60vh and scrolls
inside itself, far from the collapsed header at the top. That row should then be
given an alignment decision of its own rather than inherit the bubble rows'.

`MoreHorizontal` rather than `GitBranch`: the file tree, the Git log and the
files panel already say *this thing has a menu* with these three dots, and chat
is the fourth caller of a mark a reader takes for chrome. Forty copies of a
*feature's* own glyph read as forty announcements of that feature — the
objection that built the first `…` menu, answered head-on here rather than
capped. `GitBranch` has not gone anywhere; it moved one layer in, onto the menu
row, so one fork concept still has exactly one glyph across the row, the origin
banner and the sidebar marker.

Width changes none of this. The slot's size, position and visibility are the
same on a phone and on a desktop; only the menu's shape varies, and `Sheet`
already decides that for every sheet in the app. No second threshold is written
here.

### The slot's weight, and what it costs the bubble

The trigger takes its box, focus ring and press feedback from
`ui/iconButtonClass({ grow: false })` — the app's inline icon action, the same
weight the Git and Files panels use. `grow: false` is the part worth recording:
the hit area is laid **over** the 36px box instead of growing it, because this
box's width is what the bubble is measured against and layout may not change
with the pointer ([responsive-ui.md](responsive-ui.md#which-technique-and-when)).
Growing it would also have spent 8px of width on a phone to save height on a
phone.

At rest the glyph is at **half opacity**, rising to full on hover, on
`focus-visible`, and for as long as its menu is open. The dimming is opacity
rather than a quieter colour token: `iconButtonClass` already writes
`text-th-text-secondary` into the same class list, so a `text-th-text-muted` at
the call site would be a same-specificity override whose winner is whichever
rule Tailwind happened to emit second — correct until an upgrade silently
reverses it.

Not `ui/ContentView`'s `actionIconButtonClass`, the other icon action in the
app: it carries a border and a filled background, which is the right weight in a
toolbar and far too loud repeated beside forty bubbles.

The glyph **fades in** when the message settles (`animate-message-menu-in`,
150ms, off under `prefers-reduced-motion`). An animation and not a transition,
because the glyph is mounted rather than restyled: a transition has no
before-value to move from, so writing one would have produced no animation at
all. Nothing else moves — the slot was already there while the message streamed,
and the fade happens at the bubble's end, exactly where the agent's last words
just landed.

**The trade, priced:** every message gives back the 36–44px of height a standing
action row spent, and every bubble is at most 44px narrower for it. Diffs, code
blocks and option cards inside a bubble get that much less width on a phone; all
of them already scroll sideways, and vertical space has no second source.

That maximum width is never computed anywhere. The slot is a `shrink-0` flex
item that is always present and the bubble is `min-w-0 max-w-full` beside it, so
flex hands over the difference on its own — which is why no file has to know how
wide the slot is.

### Which rows reserve a slot

Two levels, and they are what makes the slot steady:

- **Session level.** A slot exists only where per-message actions exist at all
  — where `ChatPanel` passed `onForkMessage` down, meaning the host can navigate
  and the agent's `fork_support` is not `"none"`. A session that can never fork
  should not pay 44px a row for a glyph that will never come.
- **Message level.** Inside such a session **every** row draws the slot: settled
  bubbles, streaming and sending ones, and the collapsed one-line Work events.
  Only what stands in the slot differs.
  - For bubbles the reason is constant geometry: a message going from streaming
    to settled does not move a pixel.
  - For event lines the reason is the opposite one — their state never changes —
    and it is the **content edge**. A full-bleed line with no slot runs 44px past
    the widest bubble and leaves the right edge of the transcript ragged.

Why not a long-press on the bubble: chat bubbles are the one place in this app
where users select and copy text, and long-press is how a phone starts a
selection. Why not tapping the bubble: bubbles already contain links, code
blocks and expandable tool calls, so the bubble itself has no free tap.

Nor is the glyph revealed on hover, which
[responsive-ui.md](responsive-ui.md#the-one-authorized-form) would have allowed.
The old reason stands — a control revealed that way is easy to find under one
pointer and invisible under the other — and there is now a harder one: the
slot's width is paid whether or not anything is drawn in it, so hiding the glyph
saves ink and not one pixel of layout.

### Why this is not the standing action row

A thin row of icons under every bubble is what shipped before this, and the
argument for it was that fork is a primary action, this app's main pointer is a
thumb, and therefore rung 1 of
[responsive-ui.md](responsive-ui.md#where-a-p1-goes-when-there-is-no-hover) —
always visible — settled the question; a `…` opening a single-row sheet charged
two taps and handed back one thing.

Where that argument gave way:

- **The cost was booked in the wrong place.** The `…` was charged a tap and the
  row was charged nothing. A row's real price is 36–44px of height per message,
  against the 12–16px that separates them — close to an extra bubble each, spent
  on the axis a phone has least of.
- **Rung 1 is about reach, and the slot still meets it.** Always drawn, 44px of
  target, never hover-gated. What moved behind a tap is the list of actions, not
  the way in.
- **The second tap now buys something.** It buys a whole sentence saying why
  fork cannot run here — which an icon could only murmur into `aria-label`,
  since a `title` never fires on a touch device. The layout that spent the
  vertical space was the one that could not speak.
- **The ceiling admitted it.** Three standing icons was the cap, but a row pays
  its full height for the *first* icon. A container whose rule bills for three
  and carries one is the wrong container.

Three decisions came through unchanged: long-press and tapping the bubble are
both taken (above), and **a running turn does not grey out the messages above
it** (*Which messages get a menu*).

What may be added to the menu later — two append-only groups, no mirroring, one
level deep, disable rather than remove — is written at the top of
`MessageMenu.tsx`, beside the list it governs. The row's three-icon ceiling is
gone with the row: noise no longer grows with the number of actions, because the
transcript shows one `…` however many rows stand behind it.

### Which messages get a menu, and when fork is on it

Two separate questions, and they must stay separate. The menu belongs to every
per-message action, so a reason **fork in particular** does not apply must not
take the menu — and with it every future action — away. The split lives in two
files that say which is which: `utils/messageActions.ts` answers the first,
`utils/forkAnchor.ts` the second.

**1. Is this message a turn with a menu at all?** (`hasMessageActions`)

- System-origin messages (`source === "system"`, the Work engine's prompts,
  which render as a collapsed one-line event rather than a bubble) get none.
  They are not conversation turns; they are Pockode's own annotations, and there
  is nothing a user does *to* one. They keep the empty slot all the same, for
  the edge it lines up (*Which rows reserve a slot*).
- A message still `sending` or `streaming` gets none either — it is not yet a
  turn. Here too the slot stays, which is what lets the glyph arrive when the
  turn ends without moving the bubble the agent has been writing into.

**2. Can fork run on this message?** (`forkUnavailableReason`,
`isForkableMessage`, `resolveForkAnchor`)

- A message no record names cannot be pointed at, and the client must not
  number it itself (`no-anchor-seq`, *Data contract*). Two ways to get there,
  both rare: the server could not persist the record, or it is too old to answer
  `chat.message` with a seq at all — for such a server, every message this tab
  sends stays unaddressable until a reload.
- A message holding a pending permission request or question is not a settled
  transcript to cut at (`pending-request`).
- A user message that opens the *session* has nothing behind it to keep
  (`nothing-before`, *The rule*). This one needs the message's *position*, which
  is why it is `resolveForkAnchor`'s answer and not `isForkableMessage`'s — and
  the position has to be read against the whole session, not against the pages
  loaded so far: while `hasMoreHistory` is true the topmost bubble on screen
  still has a conversation above it, so both `resolveForkAnchor` and
  `MessageItem`'s `isFirst` are given that flag rather than trusting index zero.

Neither of the first two is a verdict on the message itself, so they leave the
fork row in the menu and disable it rather than removing it (*Blocked and
failed*). They stay two reasons rather than one all the way to the words on that
row, because only one of them is the user's to clear: an answer settles the
request, while a missing seq is nothing the user can supply and, where the
record never persisted, nothing a reload brings back either — that message does
not survive one. A single sentence covering both could only promise that this is
not how the message will stay, which is no help to the user who could have acted
and a half-truth to the one who could not. Were the two questions still one, as
they were while `isForkableMessage` gated the entry point itself, a missing
`seq` would silently cost the message every other action it will ever be given.

**A message the user just sent is not in that set, and closing that hole is why
`chat.message` has a reply at all.** The server leaves a sender out of the
broadcast carrying every other record's `seq` — it has already echoed the message
into its own transcript — so the reply is the one place it can learn where its
own message landed (`rpc.MessageResult`). Without it every prompt typed since the
page loaded offered a fork row it could not run until a reload, which is
precisely the message this feature exists to fork from, at precisely the moment
the user wants to: just after reading an answer they did not like. Rewording the
sentence would have described that state more honestly without making it any
less useless.

A running turn does **not** disable anything above it. Forking an older, settled
message is well defined while the agent writes — everything the fork keeps is
already final, and everything still arriving falls after the anchor and is
dropped anyway. So an older message's `…` neither blinks out for the length of
every turn nor opens onto a refusal; only the unsettled message itself is
unforkable.

## The fork sheet

`ForkSessionSheet`, a `Sheet` titled **Fork session**. The menu closes as it
opens, so the two sheets **replace** one another rather than stacking: the
confirmation is what the user is looking at next, and the menu has nothing left
to say. (`useLockBodyScroll` counts its holders for exactly this handover.)

1. **Anchor preview** — the anchor message quoted read-only, clamped to three
   lines, prefixed by its role — `You`, or the agent's label from
   `AGENT_TYPE_INFO` (`Claude` / `Codex`). The user picked it from a scrolling
   transcript on a phone; showing it back is how they confirm they hit the
   right one. The preview does not say whether the quoted message is the last
   one kept or the first one left behind; the sentence under it does.
2. **What is cut**, one line, with the real count — messages as the user sees
   them. History pages in from the bottom, so everything after the cut point is
   loaded by definition and the count is exact however far back the user has
   scrolled. Two sentences, because *The rule* lands on two sides and "up to
   this message" would be a lie on one of them:
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
  is no fork to have memory in: the session shows no `…` at all and the
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
that cannot follow a fork never gets that far — there is no `…` to press, so
neither sheet ever opens. For one that can, a fork can still come back with
nothing, for server-side facts no client can see: a source that never ran that
agent, or whose provider conversation the agent already gave up on. The UI does
not guess at those. The backend states the fact where it cannot be missed
instead — a history record in the forked transcript (`chat.Client.Fork`, written
on the `carried == false` answer described in `server/agent/fork.go`,
`SessionForker`), rendered
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
`MessageList`, in the low-contrast hairline style of the collapsed work event
line (`WorkEventItem`), with a `GitBranch` icon:

```
Forked from "Refactor the session store"
```

Tapping it navigates to the parent session. If the parent has been deleted, the
same row renders as plain text, not a button: *"Forked from a deleted session"*.

The transcript's top, not the chat header: the header belongs to the project
title (`MainContainer title={projectTitle}`), and more to the point, "this
conversation begins as a copy of another one" is a fact about where the
transcript starts — the top of the transcript is literally where it belongs.

A session opens on the newest page of its history and pulls in earlier pages as
the user scrolls back, so the banner renders **only once the whole transcript is
loaded** (`hasMoreHistory === false`). A banner pinned above a window into the
middle of a transcript would claim a position it does not have. Where it does
render it stands in for the generic "Beginning of conversation" line
([agent-chat.md](agent-chat.md#reading-a-page-on-the-client)) — it says the same
thing and says more.

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
Codex is that agent. **The whole session renders no `…`** — and since fork is the
menu's only row today, no slot either: the bubbles get the 44px back
(*Which rows reserve a slot*). Not a menu holding a permanently dead row: a
Codex transcript whose every message opens onto the same refusal is noise that
never becomes usable. Fork is not an action being refused in these sessions; it
is a feature that has never applied to them. `session.fork` refuses the same
case on the backend (`ErrForkUnsupported`): hiding it here is the experience,
refusing it there is the contract.

The cost of that choice, recorded because it is deliberate: the sentence *"Codex
cannot reopen an earlier conversation, so its sessions cannot be forked"* now has
nowhere in the frontend to be said, and the helper that produced it
(`forkBlockedReason` in `lib/agentType.ts`) is gone. A per-message menu was the
wrong place to say it — it is a fact about the session, and it would have been
said forty times. If it is worth saying, the place is somewhere session-scoped —
settings, or the engine selector — said once.

**Fork applies to this message but cannot run on it** — the row stays exactly
where it is in the menu, dimmed, and says why in a second line under its label.
A control that vanishes from under the user's thumb is worse than one that says
no. This is the menu's largest single gain over the icon that preceded it: an
icon could carry the reason only in `aria-label`, which a screen reader reads
and nobody else does — and a `title` never fires on a touch device at all. There
are three of these, one per cause, and each is named after its cause rather than
after the state it leaves the row in: one code spanning two causes can only be
worded as the symptom they share, and a symptom is never the thing the user can
go and act on:

| | Reason | Second line |
| --- | --- | --- |
| **`nothing-before`** | A user message that opens the session: nothing before it to keep | *"Nothing before this message to keep."* |
| **`no-anchor-seq`** | The server never gave this message a seq, so it cannot be named as the cut point | *"This message has no saved position to fork from."* |
| **`pending-request`** | The message holds a permission request or question nobody has answered | *"Respond to the request in this message first."* |

The table's order is the order the reasons are asked in, and it carries as much
of the design as the names do. A message can be in more than one of these states
at once, and the rule for which one it is told is that **a reason the user's own
action can clear is asked after one it cannot**. An assistant message can hold
an unanswered request *and* have no seq; told to respond to the request first,
the user responds, comes back, and finds the row still dimmed — sent off to do
work that was never what stood in the way. The other order costs nothing:
`no-anchor-seq`'s sentence stays true while a request is pending, because it
only says this message has no address and promises nothing about the request.

The permanent reason is asked **first** (`forkBlockedReason` in
`MessageItem.tsx`); the other two are `forkUnavailableReason`'s
(`forkAnchor.ts`), which is asked of the message alone and so cannot see that it
opens the session. `nothing-before` and `no-anchor-seq` can land on the same
message — an opening prompt whose record failed to persist is both — and there,
naming the missing seq would point at a state whose clearing changes nothing:
nothing behind the opening message is ever coming back. `pending-request` cannot
collide with `nothing-before` at all: the requests are the agent's, and an
opening message is the user's.

A message that is not a conversation turn at all gets **no code**:
`forkBlockedReason` asks `hasMessageActions` before anything else and answers
`undefined` when it says no. That is this section's opening distinction drawn
inside a single message rather than across a session — a bubble still being
written and a Pockode event line are not being refused fork; it never applied to
them, and they carry no menu a sentence could sit in. The gate is written out
rather than left implicit: the single code this replaced was computed for these
messages too and nothing ever came of it, since a row with no menu shows no
sentence — harmless while a code named a symptom, and not once it names a
cause.

None of the three opens `ForkSessionSheet`, which has no blocked variant: each
is one sentence long and is fully said where it stands, and a sheet would charge
a tap and a dismissal to reach the same words. The row is `aria-disabled` rather
than natively `disabled` — a natively disabled button takes no focus and screen
readers step over it, which would hide the very sentence that was the point of
saying no in words.

"Nothing before this message to keep" is stated in three layers, on purpose:
`chat.Client.Fork` refuses it (correctness), `resolveForkAnchor` returns no
anchor (so the sheet cannot open onto a request that must fail), and the menu
row says it in words (so the user learns it on the way to the action rather than
from a failure). Three copies of one rule is a maintenance debt worth naming —
change one and check the other two.

**The request fails.** The sheet stays open and becomes dismissible again, the
server's message renders above the footer in `text-th-error`, and `Fork` returns
to its idle state. The app never navigates on failure — landing the user in a
session that may not exist is worse than the error. Retrying is pressing `Fork`
again.

## Components

New, all in `web/src/components/Chat/` unless noted:

| File | Role |
| --- | --- |
| `MessageMenuTrigger.tsx` | The slot beside a bubble and the `…` in it, plus whether its menu is open. Props: `{ side: "user" \| "assistant"; onFork?: () => void; forkBlocked?: "nothing-before" \| "no-anchor-seq" \| "pending-request" }`. No `onFork` means this message is not a turn — the slot renders, the glyph does not. It also owns the `ForkBlocked` type, though only `nothing-before` is spelled there: the other two are `forkAnchor.ts`'s `ForkUnavailable`, declared beside the check that produces them, since a utility module does not import from the components that use it. `MessageMenu` imports `ForkBlocked`, as a type, which is erased at compile time and so is not a runtime cycle |
| `MessageMenu.tsx` | The `Sheet` behind the `…`: everything this message can do, titled by speaker — **Your message** / **Agent message**, since a sheet here names its subject the way `Fork session` and a file's own name do. The rules for adding the second row live at its top, where the list is |
| `ForkSessionSheet.tsx` | The confirm sheet above. Props: `{ anchor, droppedCount, agentType, defaultTitle, isForking, error, onFork, onClose }` |
| `ForkOriginBanner.tsx` | The lineage row at the top of `MessageList` |

`MessageActions.tsx`, the standing row, is **deleted**; `MessageMenuTrigger` took
its place and its props. `MessageMenu.tsx` is the once-deleted `…` sheet brought
back out of git history with a different job: "everything this message can do"
rather than "what did not fit". `common/MenuRow` is a shared component again —
`Files/FileEntryMenu` and this menu are both built out of it — which is why
`disabled` and `description` landed on it rather than on a row written for chat
alone.

Changed:

- `ui/iconButtonClass.ts` — the signature became an options object and gained
  `grow` (see *The slot's weight*). Chat is its third caller after the Git and
  Files panels, and the only one that asks for `grow: false`; the remaining call
  sites changed shape and nothing else.
- `common/MenuRow.tsx` — `disabled` and `description`, both for the blocked fork
  row (*Blocked and failed*). `description` renders inside the button, so it
  joins the row's accessible name without an `aria-describedby`.
- `MessageItem.tsx` — renders `MessageMenuTrigger` on every row of a forkable
  session, as a flex sibling on the bubble's inside, and assembles fork's
  blocked reason: the menu gate first, then `nothing-before`, the one cause that
  needs the transcript, then whatever `forkUnavailableReason` says about the
  message alone. Optional props `onForkMessage?: (messageId: string) => void`
  (stable, since the component is `memo`) and `isFirst?: boolean` — first in the
  *whole* session, not in the pages loaded so far, since that is what decides
  whether a fork here has anything behind it to keep.
- `MessageList.tsx` — the origin banner, and threading `onForkMessage` and
  `isFirst`. The top of the loaded transcript is the session's start only once
  `hasMoreHistory` is false; with older pages still unread, the first rendered
  message has conversation behind it and forking there is fine. The same
  condition is passed to `resolveForkAnchor` in `ChatPanel`.
- `ChatPanel.tsx` — owns which message a fork is being confirmed for, owns the
  fork mutation and its in-flight/error state, renders `ForkSessionSheet`, and
  writes the dropped prompt into the draft store before navigating. The sheet is
  a portal and the RPC is a session-level concern; neither belongs inside a
  message. It is also where `onForkMessage` is withheld — from a host that
  cannot navigate, or an agent that cannot be forked — because both facts are
  session-wide, and a second copy of that policy inside `MessageMenuTrigger`
  would one day disagree with this one.
- `Session/SessionItem.tsx` — the `GitBranch` glyph in `leftSlot`.

Outside the component tree, because none of it is about rendering: which messages
have a menu at all (`utils/messageActions.ts` — deliberately not in
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
changeable, as on any activated session. `unread` and `needs_input` start false,
and the token usage starts at zero — the tokens behind the copied transcript were spent
by the parent, and counting them on both sides would make every sum over sessions
wrong ([usage-display-ui.md](usage-display-ui.md#a-fork-starts-at-zero)). So a
fork can show a long conversation and a small total; the panel says why.

A fork of a session that belongs to a work is **not** linked to that work. The
link is a single field on the work (`Work.session_id`), so a second session
claiming the same work has nowhere to be recorded — and everything that goes
from a work to *its* session would have two candidates and no rule for picking
one: the work list's Chat shortcut, and `AutoResumer`, which sends the next
nudge to that id. The fork is an ordinary session.

**3. Who can be forked at all.** The transcript has to know, before it reserves
a single slot, whether this session's agent can follow a fork — and it must not
know it by name:

```
agent.list  {}  ->  { agents: [{ type, fork_support }] }
```

One app-scoped call, answered from the server's own registry. The UI keeps no
table of its own — a second copy of this fact would disagree the day an agent
learns something new — and it is not a subscription: the answers come from the
implementations compiled into the server and cannot change while it runs. Until
the answer arrives, forking is offered; the reasoning for that default and for
retrying it after a reconnect is with the hook. Reserving the slot makes that
default visible — in a session that turns out to answer `"none"`, the slots
appear and then go away once, widening every bubble as they do. Accepted, and
not patched over with a second default inside the component, which would be a
copy of the hook's policy waiting to disagree with it.

Accessibility, beyond the sentence a blocked row says out loud (*Blocked and
failed*):

- **The `…` names its speaker** — *"Actions for your message"* or *"Actions for
  the agent's message"*, plus `aria-haspopup="dialog"` and `aria-expanded`.
  There is one of these per message, and a screen reader's button list — or a
  voice command naming one — is unusable when every entry reads "Message
  actions". The menu's title names the speaker again for whoever arrives after
  it has opened.
- **Focus is `Sheet`'s, not this feature's.** `Sheet` takes focus on open,
  cycles Tab inside itself and hands focus back to whatever opened it; the fork
  sheet's own title field wins over the box `Sheet` would otherwise take. Both
  sheets here rely on that and neither writes any focus code of its own — the
  menu's `…` gets focus back on close, and a second copy of the logic would one
  day disagree with `Sheet`'s.

## Considered and not done

- **A "first instruction" field in the fork sheet**, sent automatically into the
  new session. It would turn fork-and-redirect into one tap, which is a real
  mobile win, but it is a second feature wearing the first one's clothes, and it
  makes the sheet's failure modes compound (forked but not sent?). The new
  session's input bar is one tap away — and on the case this would have helped
  most, forking off one's own prompt, the text is already sitting in it
  (*The dropped prompt*).
- **`Copy text` in the menu.** Genuinely useful on a phone, and the menu is
  built to take it — the *Which messages get a menu* split exists precisely so
  that the second action does not inherit fork's reasons for being unavailable.
  It is still not this feature. No placeholder was left for it either; the menu
  is the placeholder, and it is the reason the second action costs no layout at
  all now.
- **A marker on the parent.** Rejected on the grounds in *The rule*.
