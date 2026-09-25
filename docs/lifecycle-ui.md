# Lifecycle UI

How the three-layer lifecycle (process → session → work) is presented to the
user. The model itself — `TurnState`, leases, work `status` + `wait` — is
[lifecycle.md](lifecycle.md), and this document does not restate it: it is only
the presentation layer, and it is written to be implemented from — every state
has one glyph, one tone, one label and one rule for when its buttons exist.

It replaces the presentation half of
[work-system.md § One Vocabulary for Work Status](code/work-system.md#one-vocabulary-for-work-status)
and the UI claims in
[agent-integration.md § Background Waits](code/agent-integration.md#background-waits).

## The one thing this fixes

"What is the agent waiting for" is drawn today in six places from five
independently maintained facts, and the one case that matters most — a turn
parked on a background task — is drawn as a spinner that can turn for two hours.
The new model makes waiting explicit, so the UI's job becomes narrow:

> **One derived `Activity`, one visual map, every surface.** Nothing on screen
> may spell a state out of raw fields; a surface either renders an `Activity` or
> it renders no state at all.

## 1. The vocabulary

### 1.1 Activity

`Activity` is the only state any surface paints. Eight leaves, and there is never
more than one — the layers it is derived from are each exclusive.

It answers **what the session is doing**, and only that. What the user has to
*do* is a second, independent dimension — the unanswered questions — which a
surface draws beside the activity rather than instead of it
([answering-ui.md](answering-ui.md)). A work can be `running` and be waiting on
two answers, and both halves are true at once.

| `Activity` | Means | Glyph | Tone | Label |
|---|---|---|---|---|
| `open` | Work exists, never started | `Circle` | muted | Open |
| `running` | A turn is producing output | `CircleDot` | accent | Running |
| `needs_permission` | Turn blocked on a permission request | `Lock` | warning | Needs permission |
| `background` | Turn blocked on a background task | `Hourglass` | secondary | Background task |
| `waiting_children` | Work waits on subtasks (`work_wait`) | `Clock` | accent | Waiting on subtasks |
| `idle` | Engine drives the work, nothing is happening | `CircleDot` | muted | Idle |
| `stopped` | Engine does not touch it; a human must act | `CircleStop` | error | Stopped |
| `closed` | Finished | `CircleCheck` | muted | Closed |

Glyphs are all lucide icons the app already imports, except `Lock` and
`Hourglass`. Nothing else is new: tones are the existing `th-*` semantic tokens
(`text-th-accent`, `text-th-warning`, `text-th-text-secondary`,
`text-th-text-muted`, `text-th-error`).

Four decisions inside that table are load-bearing:

- **`running` and `idle` share `CircleDot`; only the colour differs.** They are
  the same thing — a live, engine-driven work — differing in whether a turn is
  open right now. `open` is a hollow `Circle` for the same reason: it is a
  different *kind* of nothing than `idle` is. Keeping the pair on one glyph is
  also what stops a work from appearing to change identity every time a turn
  settles.
- **One "needs you" leaf, and it is the only one left.** Warning marks *the user
  is the blocker*, and `needs_permission` is now the only state in which that is
  a property of the turn: a question does not block a turn, and a work no longer
  waits on a message. `needs_answer` and `needs_message` are deleted, and what
  they used to say is said by the question count instead — which is what lets it
  be true at the same time as `running`, and that is the one thing an exclusive
  leaf could never express.
- **`background` is deliberately quiet.** `text-th-text-secondary`, no spinner,
  no accent. There is nothing for the user to do and nothing is stuck; the whole
  point of surfacing it is to stop it *impersonating* activity. A tone louder
  than the copy would re-create the two-hour spinner in a new costume.
- **`waiting_children` keeps accent.** Unlike `background` it is a structural
  state the user reads on purpose ("this story is coordinating"), and it is the
  state whose subtasks are the next place to look.

### 1.2 Deriving it

One rule, stated once, and the reason it is short:

> **The session says what is happening; the work's `wait` says what it is waiting
> for when nothing is happening.**

```
activity(work, turn):            // work may be absent; turn may be absent
  no work                  -> skip to the turn branches below
  work.status == "open"    -> open
  work.status == "closed"  -> closed
  work.status == "stopped" -> stopped
  // status == "active"
  turn.phase == "running"  -> running
  turn.phase == "blocked"  -> permission in turn.blockers -> needs_permission
                              otherwise (background)      -> background
  // turn.phase == "idle", or there is no turn at all
  work.wait == "child"     -> waiting_children
  otherwise                -> idle
```

A session uses the same function, and what it passes for the work half is the
one subtle call in this document:

```
sessionActivity(session):
  work = the work the row names, looked up by session.work_id in workStore
  activity(work?.status == "active" ? work : undefined, session.turn)
```

**A session row sees a work's `wait`, never its `status`.** The wait is a fact
about this conversation — the work is coordinating its subtasks *from here*. The
status is not: a session outlives the work's lifecycle, and a row reading
`Stopped` or `Closed` would be reporting the work list's business in a list that
cannot act on it. Passing the work only while it is `active` gets both halves
from one expression, because the three status leaves are unreachable by
construction once `active` is the only status that arrives.

**The row names its own work; nothing scans the work list for one that names the
row.** Which sessions belong to work is the server's answer, carried on the row
as `work_id`
([subscription-system.md](code/subscription-system.md#which-sessions-belong-to-work)),
and this lookup is the only thing the row still asks the work list for. What it
asks for is the `wait` — and that is why the direction matters: a work the store
has not paged in costs the row its `wait` and nothing else. The row is still in
the right list, still says what its own `turn` is doing, and still links to the
right work. Inverting the list instead would make *membership* depend on the
list being complete, and that is a wrong row rather than a row missing one
field.

Why phase outranks `wait` rather than the other way round: a `wait` is a standing
intention, a phase is a fact about this second. A story that has called
`work_wait` and then keeps writing for another ten seconds *is* running, and the
row should say so; the moment the turn settles, the `wait` takes over. The
alternative — `wait` first — needs a priority table between two kinds of waiting
that can legitimately coexist, and every entry in such a table is an arbitrary
choice someone later "fixes".

`work.wait == "user"` leaves this function, and the `work_needs_input` that set
it leaves with it — the tool name survives only as a notice pointing at
`question_post` ([work-system.md](code/work-system.md#work-tools)). Waiting for
a person is no longer something a work declares; it is the session's unanswered
questions, and they never enter the activity at all.

### 1.3 Where it is computed

- **Sessions** carry `turn` on the wire; the client maps `turn` (plus the work
  it already holds, §1.2) to an `Activity` with the pure function above. Chat
  needs `phase` and `blockers` in detail anyway, so sending the raw state and
  mapping locally costs nothing.
- **Work rows carry a server-computed `activity` string** (and so does the
  detail). The work list is global across worktrees while the session list is
  worktree-scoped
  ([work-system.md § Displaying a Work's Worktree](code/work-system.md#displaying-a-works-worktree)),
  so a client *cannot* derive a work's activity — it does not hold the
  `TurnState` of a session in another worktree. The server owns the function; the
  client owns the visual map. Those are the two single sources, and they are
  single because each lives where the data is.

  The rule is therefore *evaluated* twice — `server/work/activity.go` for work,
  `web/src/lib/activity.ts` for sessions — and *written down* once, as a table of
  cases at `server/work/testdata/activity_cases.json` that both test suites read
  (`work/activity_test.go`, `web/tests/activityRule.test.ts`). A change made on
  one side and not the other fails on the other side. This is the one thing in
  this document that could not be a single implementation, and the fixture is
  what keeps "two implementations" from meaning "two rules".

  On the detail page that string **rides beside the item rather than on it**
  (`useWorkDetailSubscription`), because the stored record it accompanies knows
  nothing about a session's turn — and the three calls that answer with a bare
  work, `work.create` / `work.start` / `work.detail`, carry no activity at all.
  The client's `Work` type is shaped to say so (`web/src/types/work.ts`).
- An unrecognised `activity` value normalises to `idle` at the wire boundary, the
  same place `normalizeOrigin` folds legacy message origins. Old index values are
  normalised on load, not migrated.

Wire shape the surfaces below assume:

```ts
type TurnPhase = "idle" | "running" | "blocked";
type BlockerKind = "permission" | "background";

interface Blocker {
  kind: BlockerKind;
  /** The card to jump to. Absent on `background`, which nobody answers. */
  request_id?: string;
  raised_at: string;
}

interface TurnState {
  phase: TurnPhase;
  /** Whether a turn is under way behind whatever is in its way. */
  open: boolean;
  blockers?: Blocker[];
  /**
   * Every question this session has asked and nobody has resolved. Not a
   * blocker and not part of `phase`: a session can be `running` with three of
   * these (docs/answering-ui.md). Carried in full on the subscription, because
   * the one session on screen is the one that can be answered.
   */
  unanswered?: PendingQuestion[];
  /** When the session entered this phase. ISO 8601. Drives "since HH:MM". */
  since: string;
  /** How the previous turn ended; says nothing while the phase is not idle. */
  last_outcome?: "completed" | "failed" | "aborted";
}
```

This is `session.TurnState` serialized as it stands, rather than the separate
`blocker_detail` an earlier cut of this document specified. The reason is that
the detail the strip needs is already the blocker's own: `request_id` belongs to
the prompt that raised it, and a second field carrying "the request id of
whichever blocker leads" would be a second place where the precedence in §1.2 is
decided, free to disagree with the first.

**Background task names are not sent, and no count is either.** The CLI's own
schema says the background task level and the task lifecycle frames have no
defined order against each other and must not be joined, so the live set holds
task ids and nothing that could be shown to a user
([agent-integration.md](code/agent-integration.md#background-waits)). The strip's
copy below is written to need neither.

`SessionListItem` / `SessionDetail`: `state: ProcessState` and
`needs_input: boolean` are replaced by `turn: TurnState`. `unread` stays exactly
as it is. `WorkListItem`: `status: "open" | "active" | "stopped" | "closed"`,
plus `activity` and `wait?: "child"`.

**Every row also carries `unanswered_questions: number`, and only the number.**
That is the second dimension in its list-shaped form: thirty sidebar rows do not
need thirty question texts to draw thirty glyphs. The full list rides on the
`TurnState` of the subscribed session, and on `work.detail` as
`pending_questions`, which are the two places something can actually be answered
or read ([answering-ui.md §1](answering-ui.md#1-what-a-surface-reads)).

`wait_reason` goes too. It was the only place in the app the user could read what
an agent wanted, and what replaces it on every surface below is the question
itself ([lifecycle.md](lifecycle.md#work-four-intentions) has why the field was
the worse of the two).

### 1.4 The three components

`web/src/lib/activity.ts` — `deriveActivity(work, turn)`,
`sessionActivity(session, work)` (the three-line wrapper in §1.2),
`ACTIVITY_VIEW` (`{ Icon, tone, label, ariaLabel }` per leaf),
`needsAttention(activity, unansweredQuestions)`.

`needsAttention` replaces `needsUser(activity)` and is exactly
`activity == needs_permission || unansweredQuestions > 0` — the one predicate
that folds the two dimensions back into the single question every grouping and
every dot asks: *is a person owed something here*. It takes both arguments
rather than reading a whole row, so the same function serves a work row, a
session row and a project tab.
`ACTIVITY_VIEW` replaces all three things `StatusBadge.tsx` and `StatusIcon.tsx`
hold today — `statusLabels`, the badge palette and the glyph switch — and both
files go away with it.

`ActivityBadge` and the `label` half of `ACTIVITY_VIEW` land with the work
surfaces that have room for words: `StatusBadge` is where the badge palette's
whole justification lives, so the two are one edit. Session surfaces need only
the glyph and the dot.

| Component | Shape | Used by |
|---|---|---|
| `ActivityIcon` | glyph only, `size-3.5` (`size-3` at `sm`) | work rows, session rows, group headers |
| `ActivityBadge` | pill: glyph + label | the work detail heading, which is the one surface with room for the word |
| `ActivityDot` | 8px dot, warning, `aria-hidden` | the Project tab's panel (§4); the tab's own badge is a `BadgeDot` in the same hue |

`ActivityBadge` keeps `StatusBadge`'s existing shape — hue on the border, tint
behind it, label in a text colour that passes AA — including its reasoning about
why the hue may not be in the letters. Tones map onto it unchanged:

```
accent    border-th-accent    bg-th-accent/10     text-th-text-primary
warning   border-th-warning   bg-th-warning/10    text-th-text-primary
error     border-th-error     bg-th-error/10      text-th-text-primary
secondary border-th-border    bg-th-bg-tertiary   text-th-text-secondary
muted     border-th-border    bg-th-bg-tertiary   text-th-text-secondary
```

`secondary` and `muted` share a badge palette and differ only in glyph colour —
a badge already carries its label, so the distinction the tone makes is only
needed where the glyph stands alone.

### 1.5 The spinner rule

**Exactly one surface animates: a session row whose activity is `running`.**
Everything else uses the static `CircleDot`.

A spinner asserts "output is arriving right now". Under the new model that
assertion is finally true and bounded — `running` is a reducer phase that a
background wait can no longer squat in — and the session list is the one place
where liveness is the question being asked. Work rows keep the static glyph for
the reason already recorded in work-system.md: an `active` work with an idle
process is an ordinary resting state, and a settle delay is not an emergency.

A row shows **at most two** indicators, and they are not in competition, because
they answer different questions:

1. `activity != idle` → `ActivityIcon` (spinner in place of the glyph for a
   running session row).
2. `unanswered_questions > 0` → `CircleHelp` warning, plus the number above 1
   (§2.1). Independent of 1: a row can draw both, and that is the second
   dimension doing its job.
3. neither drew anything, and `unread` → the existing accent dot.

Today's "running beats needs_input" precedence disappears with the fields it
arbitrated between. The unread dot keeps its place at the end for the reason it
always had: it is the weakest claim on the reader, and a row already saying
something more specific does not need it. `unread` and `MarkRead` are otherwise
untouched by this redesign.

"Surface" here means *a surface that paints an `Activity`*. The transcript's own
motion — a streaming bubble, a tool call's own progress — is untouched and is not
covered by this rule: those describe one message, not a state, and a message that
is arriving is the one thing a spinner has always been honest about.

## 2. Session surfaces

### 2.1 Session list row

`SidebarListItem`'s `isRunning` / `needsInput` / `hasChanges` props become
`activity: Activity` / `unread: boolean`. The existing `<output>` spinner keeps
its markup and becomes one branch of the indicator slot; every other leaf renders
`ActivityIcon` (a 12px glyph reads as an indicator, not as an action, so it needs
no hit area). Every `aria-label` in the table below, the spinner's included,
comes from `ACTIVITY_VIEW` — the spinner is the one element here that had a
hand-written label, and leaving it hand-written would have kept one row of the
vocabulary outside the map that owns it.

| Activity | Row indicator | aria |
|---|---|---|
| `running` | spinner, accent | "Agent is running" |
| `needs_permission` | `Lock` warning | "Waiting for your permission" |
| `waiting_children` | `Clock` accent | "Waiting on subtasks" |
| `background` | `Hourglass` secondary | "Waiting on a background task" |
| `idle` | unread dot, or nothing | — |

`waiting_children` is the one a session row can only get from a work, and only
from an `active` one, by the rule in §1.2; `open`, `stopped` and `closed` never
reach a session row at all. Everything else in the table is read from the
session's own turn, so it reaches a row whether or not any work is behind it.

**The question count is a second indicator beside that one, never instead of
it** — rung 2 of §1.5. When `unanswered_questions > 0` the row draws `CircleHelp`
in `text-th-warning`, followed by the number when it is above 1, after the
activity indicator. Both are `shrink-0`, so the 240px sidebar pays about 30px and
the title keeps being the one `flex-1 min-w-0` element
([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)).

**A count of one is drawn as the glyph alone.** "1" beside a glyph that already
means "a question" is a character spent restating it, and one is the common case
— which is the case that has to fit. `aria-label` carries the words either way:
"1 question waiting for your answer" / "{n} questions waiting for your answer".

This is the case the two deleted leaves could not draw: a session that is
running *and* owes two answers used to have to pick one of those to say.

### 2.2 Chat: the attention strip

One line between the transcript and `InputBar`, saying **what needs the user** —
and, when nothing does, that a message reached the reply the agent is working
on. `BlockerStrip` is renamed `AttentionStrip` with this change: two of its four
rows are not blockers, a question does not block a turn at all, and a name that
describes one row of four is a name every later reader works around. It
borrows `ForkOriginBanner`'s chrome — centred, `text-xs`, `size-3` glyph, muted —
because both are one-line statements about the transcript rather than controls,
and the pane should have one vocabulary for them. It sits below the list (not at
the top like the fork banner) because it describes the transcript's *end*.

Four things it can say, in the order it prefers them:

| State | Copy | Trailing action |
|---|---|---|
| `permission` | "Waiting for your permission. Answer above or Stop before sending." | "Jump to request" |
| unanswered questions | "1 question is waiting for your answer." / "{n} questions are waiting for your answer." | **Answer** |
| a message went into a turn already open, unread so far | "Sent — the agent has not read it yet." | — |
| `background` | "Waiting on a background task — nothing to answer." | "Details" (expands) |

The layout, copy and controls of the question row are
[answering-ui.md §2](answering-ui.md#2-the-strip); only its rank is decided here.

Permission is first, and now for a sharper reason than the precedence §1.2 uses:
it is the only row left that Send is refused under (§2.3), and it is also the
state in which *answering a question is refused*, because the CLI holding the
request open reads nothing else. It is the thing that has to happen first in both
senses. Its second sentence stays, because a disabled control with no reason on
screen is the silent failure this project forbids.

The question row carries no such sentence. Sending is not refused while a
question is open — the agent may well be running — so a second sentence there
would be inventing a restriction to explain.

The third row is a **receipt**, and it is the only one the user's own action
produces. It covers the stretch between the message being sent and the agent
reading it: until then the reply above keeps growing and nothing appears under the
message, so a message that landed and a message that vanished look identical
without this line. It stops at the read point rather than at the end of the turn —
that is where a bubble opens under the message and the transcript says it for
itself (§2.3). It is ranked above
`background` on purpose: sending *is* allowed during a background wait, and "nothing
to answer" is the older news of the two, so the other order would leave the one
state where a message lands with nothing said about it at all. It is ranked below
the two prompts because the agent can raise a request after the message went in,
and then both are true at once — the session being stuck is the more urgent of the
two facts.

The receipt is derived, never stored: it is `turnOpen` plus "the last thing in the
transcript is a message the user or another client sent" (`isSendPending` in
`useChatMessages`). There is no queue, no flag on the record, and nothing to go
stale — the moment the agent writes a bubble under that message, or the turn ends,
the line is gone by arithmetic rather than by cleanup. A system-driven message
(kickoff, step advance, auto-continuation) is excluded: the user did not send it,
so there is nothing to give them a receipt for.

The copy says only that the message was sent and has not been read. It deliberately
says nothing about *where* it will be answered: it is answered below itself, which
is where the reader is already looking, and the line's one job is to be believed
about the message having arrived at all. It is also reachable a moment before the
agent has written anything, through `turnOpen`'s optimistic half (§2.3) — two
messages typed inside one round trip put the second one here while the server has
yet to report the first — and "not read yet" is true of that moment too.

Whichever it says, it is one bordered row, so the composer moves by at most one
line's height however many of the four states hold.

"Jump to request" uses the jump `MessageList` owns — scroll, ring, focus the
header row — via the permission blocker's `request_id`. The strip does not
re-implement it: the scroll container is there, and a second implementation of a
scroll-and-highlight is a second set of edge cases.

It is the **only** jump left on this strip, and the only one in the app: the
question row's action opens the answer panel instead, and the pending-question
pill is deleted, because both existed to reach the place answering happened and
answering does not happen in the transcript any more
([answering-ui.md](answering-ui.md)). A question record card therefore carries no
jump handle either — `findRequestCard` matches permission cards alone.

"Details" expands to "Waiting since {HH:MM}", from `turn.since`. Two things are
stated in the copy because a user who has waited an hour will otherwise assume a
hang:

- **Nothing is stuck.** The agent resumes on its own when the task finishes.
- **The only lever is Stop.** There is no per-task kill: a blocker is not a task
  manager, and the model gives the host no way to kill one task without ending
  the turn. Stop ends the turn; tasks are lost and reported on the next start,
  which is the existing loss report. The strip says so before the user presses
  it: Stop's confirmation copy is in §3.

Expanded copy, verbatim:

> Waiting on background tasks since 14:02. The agent resumes on its own when they
> finish. Stopping ends the turn and loses the tasks.

The clock is dropped rather than faked when `turn.since` is missing or
unreadable — "Waiting on background tasks." and then the same two sentences. The
two things the copy exists to say do not depend on the time, and a made-up one
would be the only false thing on the line.

No countdown to the 24h lease. A number the user cannot change, counting down to
an outcome they would not recognise, is worse than the sentence above; the lease
expiring produces a visible warning in the transcript (existing `WarningEvent`
path), which is where a deadline belongs.

### 2.3 Chat: composer and Stop

`isStreaming` — today `lastIsSending || (lastIsStreaming && isProcessRunning)` —
is replaced by

```
turnOpen = hasUnansweredEcho || turn.phase != "idle"
```

The optimistic half stays, and dropping it would be the one regression easiest to
ship by accident: between the user pressing send and the server reporting
`running` there is a round trip, and a surface watching only `turn` would leave
them with no Stop for the length of it.

`hasUnansweredEcho` is the placeholder this client opened and the server has yet to
say anything about — located wherever it sits in the transcript rather than at the
tail, because a second message sent inside that same round trip is appended *below*
it (§2.2). An optimistic half that insisted on the tail would go false exactly then,
taking Stop off the screen at the moment two messages are in flight and it is wanted
most. What the `turn` half removes is the part that was never reliable — inferring
liveness from the last message's status and a `process_ended` that a restart never
wrote.

`turnOpen` governs Stop, the Escape shortcut and the model / mode / effort
selectors. It is **not** the composer's gate, and the table below is where those two
questions part company:

| `phase` | Stop button | Escape shortcut | Send | Composer hint |
|---|---|---|---|---|
| `idle` | hidden | inactive | enabled | — |
| `running` | shown | active | enabled | the strip, once a message has gone in |
| `blocked(permission)` | shown | active | disabled | the strip |
| `blocked(background)` | shown | active | enabled | the strip |

**Unanswered questions are not in this table at all**, and their absence is the
model change made visible. They are not a `phase`, so they gate nothing: the
composer is live, Send is live, Stop is whatever the turn says. A message typed
while a question is open is an ordinary message that resolves nothing
([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)).

**An open turn is not a reason to refuse a send.** A message typed while the agent
is mid-reply *steers* the turn already running: it shares that turn's single
ending, on both CLIs — measured rather than reasoned about, and recorded once in
[lifecycle.md § What was measured rather than assumed](lifecycle.md#what-was-measured-rather-than-assumed).
Sharing an ending is not sharing a bubble: the agent reads the message part-way
through the turn, and from that point on it is answering it, so the transcript
closes the bubble above and opens a fresh one under the message
([code/agent-integration.md](code/agent-integration.md#the-read-point)).
A message sent under a `background` blocker is accepted for a different reason
rather than the same one: there the CLI is between turns and reads what arrives, and
the wait is asking nobody for anything, so the message simply overtakes it — the
blocker expires, the strip's background line goes with it, and the turn stays open
throughout. Send needs to know neither of these reasons, which is the point: one
rule covers both.

**A permission request is the exception, and a hard one.** A CLI holding one open
is inside the tool call waiting for that answer and reads nothing
else, so the message is not delivered at all; worse, accepting it would take the
card off the user's screen, leaving a turn that only an answer nobody can give any
more could end. The server refuses it for that reason, as `-32602`
([lifecycle.md](lifecycle.md#session-one-reducer)), and refuses it for every sender
rather than for the composer alone. So an unblocked composer here would not be a
more permissive Pockode; it would be a hung session. The user's two exits are the
card and Stop — both on screen, and Stop is measured to land even from under a
request — and the strip states them on the line above the composer (§2.2), because
a greyed Send that says nothing is the silent failure the project forbids. The
same refusal covers an *answer* submitted while a permission request is open,
which is why the strip ranks permission above questions and why the answer panel
reports that refusal rather than swallowing it
([answering-ui.md §7](answering-ui.md#7-edge-cases)).

Typing is never blocked in any of these states — only sending — so a drafted
message survives the wait. Model / mode / effort selectors stay disabled for the
whole open turn, as they are today — and mid-turn sending is a reason they stay
that way rather than an argument against it: a message that joins the turn already
running is answered by the engine and mode that turn started under, so offering to
change them beside it would offer something that cannot take effect.

An expired **permission** card is untouched by all of this and stays the case it
always was: the process is gone, so `phase` is `idle` and the composer is live
for the ordinary reason. §5. An expired *question* no longer exists: a question
outlives the process that asked it, which is what §5.1 below gives up.

### 2.4 Recovering a dangling turn after a restart

The subscription result carries `turn`, so the client no longer infers liveness
from the absence of `process_ended` in history. Rule: **on subscribe, if
`turn.phase != "running"`, every message still `streaming` is finalised** — as
`interrupted` when `turn` reports the last turn aborted, `complete` otherwise.
This replaces the `isProcessRunning` bookkeeping in `useChatMessages` and is the
only thing that closes out a transcript whose server died mid-stream.

## 3. Button rules

**Which buttons exist is decided by `status`, never by `activity`.** A button
that appears and disappears as turns settle is a button the user cannot aim at.
What a *confirmation* says may read the activity — by then the user has already
aimed, and what they are about to lose depends on what is happening.

### Work side

| `status` | Start | Restart | Stop | Reopen | Open Chat | Delete |
|---|---|---|---|---|---|---|
| `open` | ✓ | — | — | — | if `session_id` | ✓ |
| `active` | — | — | ✓ | — | if `session_id` | ✓ |
| `stopped` | — | ✓ | — | — | if `session_id` | ✓ |
| `closed` | — | — | — | ✓ | if `session_id` | — |

Same table for the list and the detail page, out of one implementation
(`primaryAction(status)`); only the shape differs with the room available. The
detail page renders labels in `BottomActionBar`; **every work row renders the
button icon-only, whatever the row is and whichever group it is in**
([project-ui.md §3](project-ui.md#3-the-row)) — a control that wears a word in
one group and a glyph in another is a control the user has to look for, and the
row's second line holds facts rather than actions. Both shapes are held to the
hit-area floors, by different halves of the rule (§10).
`Start` and `Restart` are the same control
with two labels, as today — the label is the honest difference, since one starts
a fresh session and the other resumes a kept one.

**Stop is shown for every `active` work, including `idle` and every blocked
leaf.** Today it is hidden unless the status is one of three live values, which
is exactly how a work stuck in a stale status became unstoppable. `active` means
the engine is driving it; Stop means "stop driving it". Nothing else needs to be
known.

Stop's confirmation depends on what would be lost, and only these two cases ask
at all:

| When | Confirmation |
|---|---|
| activity is `background` | "Stop and end the current turn? Its background tasks will be lost." |
| a story with active subtasks | "Stop this story? Its {n} active subtask(s) keep running." |
| otherwise | none — Stop is immediate and Restart is one tap away |

Delete keeps its existing confirmation and gains one clause while the work is
`active`: "Its session and its running agent will be deleted too." Deleting
`active` work is the one destructive action here that also kills a process, and
the dialog has to say the whole of what it does.

### Session side

Stop / interrupt follows §2.3 and nothing else. There is no session-side Start:
a session runs when it is sent something.

## 4. Attention dots

One dot, one hue, one meaning: **`needsAttention` is true somewhere below this
thing.** `needsAttention` is exactly
`activity == needs_permission || unanswered_questions > 0` (§1.4) — the two
dimensions folded back into the one question a dot can ask.

| Surface | Condition |
|---|---|
| The sidebar's Project tab, and its panel | any work in the list satisfies `needsAttention` |
| Session row | the row's own two facts (it *is* the leaf) — §2.1 |

**That tab carries the dot twice, and the two are one dot.** They are both kept
because they answer different halves of one journey: on a phone the tab bar is
itself inside the drawer, so without a badge on the tab a waiting work is found
only by opening the drawer *and* picking this tab. The badge says which tab; the
dot in the panel says where to look once it is open. Neither derives the bit for
itself — both read `useWorkNeedsAttention` (`workStore.ts`), where the rule lives
so that no call site can restate it, following `isWorktreeBound`
([work-system.md § Displaying a Work's Worktree](code/work-system.md#displaying-a-works-worktree)).
A second copy of *is anyone waiting on me* is a copy that can disagree, and what
the user would see is a badge for a dot that is not there.

**The badge wears warning, not the accent the other tabs' badges use.** Accent
on that tab bar already means *something arrived here*
([sidebar-ui.md § Visual weight](sidebar-ui.md#visual-weight)); this badge means a
person is being waited on, and it stands for a dot a few pixels away that is
already warning. One hue per meaning is the rule this section opens with, and
two hues for one meaning, side by side, is the thing it forbids.

**The two dimensions are separate everywhere a user can act and joined only
here.** A dot cannot be acted on — it says "look over there" — so it needs one
bit, and splitting it into two dots would mean teaching two hues for one journey.
Everywhere the user can actually do something, the activity and the count are
drawn side by side, because what to do differs: allow or deny a command, or
answer a question.

A work row carries **no** dot, and the story row's child rollup is gone with it
([project-ui.md §3](project-ui.md#3-the-row)): a task that needs the user now
has a row of its own in *Needs you*, so both halves of what the dot used to
roll up are already on screen beside the story, and a dot would point at them.
The Project tab's dot is untouched, because it is read when the list is *not* on
screen — which is the whole reason it exists, and the reason the tab badge
carries it one step further out.

Deliberately outside the dot:

- **`background` and `waiting_children`.** There is nothing to do. A dot that
  means "something is happening" is a dot the user learns to ignore, and that
  habit is what made the old needs-input dot worthless.
- **`stopped`.** A stopped work needs a human, but it needs one *whenever the
  human gets to it*; a dot that only clears when someone restarts every stale
  work is permanent, and a permanent dot is not a signal. Stopped work is found
  through the list's *Stopped* group, which sits at the top of the list and is
  the same argument in the other direction: it is given its own heading and its
  own count rather than being folded into *Needs you*, whose count has to stay a
  number of things waiting on the user right now
  ([project-ui.md §2.3](project-ui.md#23-four-groups-and-why-four)).

## 5. Expiry

**This section is now about permission requests alone.** A question no longer
expires: it belongs to the session rather than to the process that asked it, it
survives a restart, a stop and a fork, and the only things that resolve it are an
answer, a decline and the agent's own withdrawal
([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)). The
`expired` question status, the "answer it as a message" path and the three
banners that went with it are deleted; §5.1 below records what they were and why
they are not needed, because the reasoning is what a reader will come looking
for.

A blocker belongs to the process that raised it and ends with it. The user has to
be able to tell which of those endings happened and what they can still do, so
the reason rides on the record next to its status — one field for both the
`expired` and the `cancelled` status, because "why did this stop waiting for me"
is one question.

`reason: "process_ended" | "timeout" | "work_closed" | "step_done"`. Each value
has exactly one producer, and **no value reaches both kinds of card**:

| Reason | Reaches | Producer |
|---|---|---|
| `process_ended` | a permission card | the process going away |
| `timeout` | a permission card | the answer lease running out — now permission-only, since `--answer-timeout` has no question to count |
| `work_closed` | either | the work engine retiring the session of a work it has closed |
| `step_done` | a question card | a step completing while one of its questions was still waiting |

All four arrive the same way, as a `request_cancelled` record naming the request
and carrying the reason, which is also what makes the outcome survive a reload — a
client paging back through history would otherwise replay a card as still
waiting.

The client's own copy of this set is `ExpiryReason`, and it deliberately does not
give a permission card a sentence for `step_done`: the missing entry *is* the
statement that the value cannot arrive there, and a sentence written for a case
that never happens is a sentence nobody can check.

The `process_ended` record retires whatever is still open on top of that, and
the overlap is deliberate: a session repaired at startup has one of those and no
per-prompt record, because the run that died wrote nothing. Either way the card
ends up expired; the per-prompt record is what adds the reason, and a card that
already expired takes a reason that arrives afterwards.

**The reason can be absent, and that is an answer rather than a missing one.** A
turn that simply ended, a user who sent a message instead of answering, a session
restored from an index written before any of this existed — the server cannot name
what happened, so it says nothing and the card states what is true of all of them.
Every table below therefore has a fallback row. A question card's absent reason is
narrower and says something definite: the agent called `question_cancel` itself.

### 5.1 What an expired question used to be

A question could expire because the process that held it died, because the
answer lease ran out, or because the work closed. It stayed answerable: the card
kept a live form, its button relabelled to "Send as message", and the message it
produced carried the question text with it, because a CLI resuming after its
process died drops the dangling tool call and a bare "React" would arrive as an
answer to nothing.

All of it is gone, and the reason is worth keeping: **that design existed because
a question was owned by a process.** It is owned by the session now. A process
dying, a lease running out and a work being stopped no longer end anything — the
question is still in the session's unanswered list when the next process starts,
and the answer panel still offers it. What replaced "send it as a message" is
that the real answer path never became unavailable.

Two of the three endings survive under other names and are not expiry:
`question_cancel` is the agent withdrawing its own question, and closing a work
or advancing a step cancels the questions of the session it lets go. Both draw
as `Cancelled` on the record card, with a sentence saying who decided
([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)).

The third ending — the timeout — has nothing left to time out. The answer lease
counts permission requests only, and `--answer-timeout` with it.

### 5.2 An expired permission can only be a denial

The card is **read-only with no buttons at all** — its existing `pending` branch
already gates the button row on `isPending`, so the only change is the banner.
Glyph stays `X` muted.

**There is no `Expired` chip here**, unlike the question card, and that is a
known gap rather than a shipped decision: a permission request is drawn as a tool
row, whose one chip slot is already the tool's own summary, so the card has
nowhere to put a state chip without giving every tool row a second slot. Expired
and denied are told apart today by the glyph's colour — muted against error — as
they were before this redesign. What this section owes the card — the banner
that states the outcome — is there.

| `reason` | Banner |
|---|---|
| `process_ended` | "The agent's process ended before this was answered, so it counted as a denial and the tool did not run." |
| `timeout` | "This request was not answered in time, so it counted as a denial and the tool did not run." |
| `work_closed` | "This request was cancelled because the work was closed. The tool did not run." |
| absent | "The agent stopped waiting for this request, so it counted as a denial and the tool did not run." |

Every row ends in the same outcome, and that is the point: a permission that was
not granted is a denial whichever way the waiting ended. Only the first clause
differs.

The rule this used to state — *the two expired cards are told apart by their
affordances, not their chrome* — now has only one card to apply to, and it holds
in its stronger form: an expired permission offers nothing to press and states an
outcome instead, because there is genuinely nothing left to do. Reaching for a
chip to say so would put the distinction in a colour the card cannot afford to
shout in; the banner says it in words.

## 6. Work surfaces

### 6.1 List grouping

Which groups the list has, which work gets a row and what a row holds is
[project-ui.md §2](project-ui.md#2-the-project-screen), which owns the project
page's information architecture. Only the part that is about *this* vocabulary
is here.

**Grouping reads `status` plus the single `needsAttention` predicate (§1.4) —
never the full `Activity`.** A list that regrouped on every phase change would reorder itself
while being read. A work moving in or out of *Needs you* is the one movement
worth the disruption, since it is the one the user is waiting for — and a
question arriving or being answered is exactly that movement, which is why the
count is inside the predicate rather than beside it. That one predicate is also
enough to draw the whole list: the four groups are "has this
been handed back to a person, and if not, is an engine driving it, blocked on
the user", and the archive is `status == closed` and lives in its own segment
rather than a group. The status is asked before the activity, so a `stopped`
work is in *Stopped* whatever leaf it stopped on — that leaf describes a turn
already over. *Stopped* and then *Needs you* come before the rest, where the old
status order put `in_progress` first: a list of work is a list of things to do,
and the things needing a person come before the things running by themselves.

**A group heading's glyph is fixed per group, not taken from the rows inside
it.** *Needs you* now holds rows for two unrelated reasons — a permission
request, and questions waiting on any leaf including `running` — so a heading
that borrowed a row's glyph would mislabel every other row under it. It is drawn `decorative` for the same
reason — the written label is the honest name of the group. The rows keep their
own precise leaf, which is where the distinction belongs.

Within a row the vocabulary is the row's own: `ActivityIcon` for the glyph,
`ACTIVITY_VIEW[...].label` in the title's `aria-label` and in the row's state meta
slot — written on every row, and in plain text rather than the leaf's tone, for
the contrast reasons in [project-ui.md §3](project-ui.md#3-the-row) — and the left
edge keyed off `needsAttention`: warning when it holds, error for `stopped`, the
card's own border colour otherwise.

**The count is a meta slot of its own, immediately after the activity label**,
reading `1 to answer` / `{n} to answer` in the same `text-th-text-secondary` tier
the label uses, because both are state rather than attribute. Together the two
read `Running · 1 to answer`, which is the whole point of the second dimension in
six characters. Short on purpose: line 2 clips from the right, and this slot sits
near the front of a line that has six other things to fit. The row's **glyph is
not changed** by it — the glyph is the activity's, and swapping it for
`CircleHelp` would be collapsing the two dimensions back into one at the one
place the redesign is trying to separate them.

### 6.2 Detail page

- Heading row: `ActivityBadge` beside `WorktreeBadge`, unchanged in layout.
- **Under the badge, one muted line for the work's own `wait`**, which now has
  exactly one value: "Waiting for its subtasks to finish." Absent otherwise; no
  empty row. The `user` branch and the `wait_reason` it printed are deleted with
  `work_needs_input`.

  The line reads the **wait**, not the activity, and that is the reason
  `background` gets no line of its own: a background wait is a blocker on the
  session's turn rather than something the work declared, the badge above already
  says `Background task`, and the place it can actually be looked at is the chat.
  Repeating it here would mean the detail page deriving a sentence from a state
  it does not own — and then owning a second copy of §1.2's precedence to decide
  when to print it.

  The subtask count is not in this line either. It is on the children section
  header below, next to the children being counted, where it can be checked
  rather than taken on faith.
- **In the space that line used to need, the unanswered questions.** This is the
  one thing the detail page gains from the second dimension, and it takes over
  the job `wait_reason` did badly: it is where a user finds out *what* an agent
  is asking without opening the chat. A bordered block under the badges,
  **whenever `pending_questions` is non-empty**, and gated on nothing else. In
  practice that is `active` and `stopped`: closing a work cancels its questions
  (§8), and a work that has never started has asked nothing. Writing the rule as
  "whenever the list is non-empty" rather than "while active" is what makes the
  `stopped` case work without a second clause — a stopped work still owes those
  answers, and Stop deliberately does not cancel them.

  ```
  ┌──────────────────────────────────────────────┐
  │ (?) 2 questions waiting for your answer      │
  │                                              │
  │  [Database]  Which database should I use?    │
  │              Postgres · SQLite               │
  │  [Region]    Which region?                   │
  │                                              │
  │                                   [ Answer ] │
  └──────────────────────────────────────────────┘
  ```

  **Read-only, and deliberately.** Question text at `text-sm`, the option labels
  under it joined by `·` and muted, one entry per `request_id`. No radios, no
  free-text box, no per-question buttons. Answering is a conversation — it
  produces a message in a session, the agent replies in that session, and half
  the reason to answer at all is to see what happens next. A form here would be a
  second answer path to keep in step with the panel, on a page with no transcript
  to show the result in.

  One **Answer** button for the block, and only when the work has a
  `session_id`. It navigates to the chat and names the first question, which is
  what the answer panel anchors and reads itself out on — the panel puts itself
  up on arrival either way, so what this button carries is *which* question, the
  one thing showing itself cannot work out
  ([answering-ui.md §4](answering-ui.md#4-when-the-panel-is-up)). The plain
  `Open Chat` control beside it is unchanged: it names no question, so the panel
  comes up on the oldest one and takes no focus.
- Children section header gains an active count — "{n} active" — whenever any
  child is `active`. This is what makes both §7 rejections legible without a
  second explanation: it is the same count each of them turns on, and "0 active"
  is the whole reason a `work_wait` was refused.

### 6.3 StepList

The current step is highlighted for every status except `open` and `closed`:

```
isCurrent   = status != "open" && status != "closed" && index == currentStep
isCompleted = status == "closed" || index < currentStep
```

Same behaviour as today's four-value `isActiveState` check, one less thing to
keep in sync with the status enum. `StepList` takes `status`, not `activity`: a
step's position does not change because a turn started.

## 7. The two refusals about subtasks

**The step_done that would *close* the work is the one that is refused**, not
every step_done. A story's steps are its own workflow, and walking through them
while subtasks run is what a story with subtasks does; what is not ordinary is
finishing, because the children would be left with a parent nobody is going to
report to, and closing the story retires the session they report through. Two
things say so before an agent hits it: the MCP tool description, and the
lifecycle section carried by every message the engine sends — which states this
refusal and its complement (§7.1) in the same sentence that tells a story to
wait for its tasks.

The rejection is an agent-facing error, and the user sees it in two places that
already exist. Nothing new is drawn.

The MCP error text — this is the copy, and it is the whole feedback mechanism for
the agent:

> This story still has 2 active subtask(s): "Session layer TurnState and
> reducer", "Process lease table and reaper". Call `work_wait` to pause until
> they close, or stop them first. The step was not completed.

Three properties it needs: it **names** the blockers (an agent told only "there
are subtasks" will guess), it names **both** ways out, and it states plainly that
nothing happened. That text appears in the transcript as an ordinary tool error,
which is the user's first view of it.

The user's second view is the story detail page: the children section says
"{n} active" (§6.2) and the story's own activity says `idle` or
`waiting_children`. Together those answer "why is this story not finishing".

No toast, no dialog, no comment on the work. The UI never calls `step_done` — it
has no such button — so there is no user action to report a failure for, and a
comment for every rejected attempt would bury the story's real comments under
machine noise.

### 7.1 `work_wait` with no subtask running

**The two gates are exactly complementary**: a `work_wait` is accepted precisely
when the closing `step_done` is refused. That is what makes each error's way out
real — "call `work_wait` to pause until they close" would be a lie if the wait
could be refused for the same story.

A `child` wait is ended by one event and no other: a subtask closing. So a story
waiting with nothing running waits forever — the engine does not nudge a waiting
work by design, its process goes at the idle lease, and `waiting_children` is
deliberately outside the attention dot (§4). It is the one state in this model
that can be stuck with **nobody told**, which is why it is refused at the source
rather than drawn somewhere.

Same three properties, same reason, and a fourth the other refusal does not
need: the three situations have three different ways out, so they are three
messages rather than one.

Each is one sentence of what is in the way, then the ways out, then the
statement of no effect — the shape the `step_done` refusal already has, ending
on "The wait was not set" as that one ends on "The step was not completed". The
rule itself leads, so that the third situation, which ends in a list, is closed
by the dash rather than by another comma clause.

| Situation | Copy |
|---|---|
| no subtasks at all | "only a subtask closing ends a wait on subtasks, and **this work has no subtasks** — so nothing would ever end this one. **Create them with `work_create` and start them with `work_start`**, or call `question_post` if you need something from the user, or `step_done`…. The wait was not set" |
| all subtasks closed | "…and **all 3 subtask(s) of this work are already closed** — so… **Create more with `work_create` and start them…**" |
| subtasks exist, none running | "…and **none of this work's subtasks is running, though 2 of them can be started: \"Reducer\" (stopped), \"Lease table\" (open)** — so… **Start them with `work_start`**…" |

The third names the subtasks *with their statuses*, because "nothing is running"
and "you never started them" are the same sentence to an agent that has just
created three of them, and the fix is different for each. Two things keep that
list from reading as one that was cut short: the number introducing it counts
what it lists rather than every subtask — a story with four closed subtasks and
two stopped ones would otherwise offer a list of two under "none of 6" — and
what follows the list is a dash, not another "and", which is what would read as
one more item.

Nothing is drawn for this either, for the same reason: the UI has no `work_wait`
button, and the story detail page already answers "why is this not moving" —
the children section says how many are active (§6.2) and the story's own
activity says `idle`.

### 7.2 A wait that becomes unendable is not refused, it is cleared

The refusal only covers a wait that could never have ended. The mirror case is a
wait that was legitimate and then lost what it was waiting for: the last running
subtask is deleted, stopped, or rolled back before it closes.

There the engine clears the wait and tells the agent what became of the subtask
([work-system.md](code/work-system.md#a-wait-nothing-could-end)). It appears in
the transcript as one more work event — subtype `wait_stranded`, drawn exactly
like `child_done` and carrying the subtask's title on its secondary line
([work-system.md § Work Messages in Chat](code/work-system.md#work-messages-in-chat))
— and the story's own activity goes back to `idle`, or to whatever its turn is
doing, which is the truth: it is being driven again.

It is deliberately **not** a stop. Stopping would take away the recovery that
costs nobody anything — the agent restarting the subtask itself — and would make
a user who stopped one subtask restart two things.

## 8. Edge cases

| Situation | Behaviour |
|---|---|
| `active` work whose session was deleted | engine moves it to `stopped`; the row says Stopped and offers Restart. No "ghost" activity, because activity is never read from a missing session |
| `active` work in a worktree that is not loaded | server-computed `activity` still arrives, so the row is fully drawn — the reason §1.3 puts the derivation on the server |
| Turn ends while the row is on screen | `running` → `idle` after the settle delay, one static glyph to another; no flash, because the glyph does not change |
| A question open while a background task runs | Two dimensions, not a contest. The leaf is `background`; the strip shows the question row above the background row, because the question is the one with something to press. Neither hides the other |
| A question open while the agent is running | The row says `Running` *and* `2 to answer`; the strip shows the question row; the composer is live. This is the case the two deleted leaves could not express |
| Fork of a session mid-turn | the fork starts at `phase: idle`, so it has a live composer and no Stop button on its first frame |
| Message sent into a running turn | until the agent reads it the transcript ends on the message with no bubble under it and the strip says so (§2.2); the reply above keeps growing where it is, since arriving underneath a reply never closes it (§2.3). At the read point that reply is closed and a fresh bubble opens under the message, so what answers it is below it. Either way the spinner asks whether a bubble is the open turn rather than whether it is the last row |
| Message sent a moment before a request appears | the accepted message takes the card off screen and the turn is left waiting for an answer nobody can give. Stop recovers it — the half of the strip's advice that survives the card going away, and measured to land from under a request. The window is between the server's check and the prompt reaching the turn state, is milliseconds wide, and is accepted on purpose rather than closed with a lock spanning the CLI's stdin (`session.ReduceTurn`, `SignalPrompt`) |
| Send refused because a request is on screen | the reason is reported as a bubble directly under the message it refused, not at the end of a transcript that may have moved on since. A refusal shown nowhere would leave the message looking delivered, which is the failure shape §2.3 forbids |
| Work stopped by the nudge limit | `stopped`, plus the engine's comment saying so. Chat shows nothing extra — the transcript already ends where the agent stopped answering |
| Work closed, or its step advanced, while a question is unanswered | The engine cancels it; the card reads `Cancelled` and says the agent's work moved on. The panel's block behaves as a withdrawal ([answering-ui.md §7](answering-ui.md#7-edge-cases)) |
| Work stopped by the user while a question is unanswered | Nothing happens to the question. Stop hands the work to a person, and the question is one of the things that person may want to answer. Its detail page still shows it (§6.2), and answering it reactivates the work the way any message does — there is no restart prompt in the way, which is the existing rule rather than a new one |
| Server restart with a blocked turn | blockers expire on process death and are written to history, so on reconnect the permission cards read Expired and the composer is live. Unanswered questions are untouched: they are turn state on disk, not a blocker, and they are still listed when the next process starts |
| `activity` the client does not know | normalised to `idle` at the wire boundary; an unknown state must not blank a row |
| Story with children in several activities | the story shows its *own* activity. What children contribute to a story row is counts, not a state: "{n} active" and "{closed}/{total} tasks" in its meta line |
| A decision pressed on a permission card that expired a moment ago | the RPC fails with the server's own reason ("this request is no longer waiting for an answer"); the card flips to Expired with §5's banner and the error is shown inline under the buttons. There is no second route: an expired permission is a denial. The refusal is the session's turn speaking — a request it no longer lists as a blocker cannot be answered, which also covers a decision that arrives after another client's |
| Session deleted while its work is `active` | the work moves to `stopped`. The delete confirmation says so: "Delete "{title}"? The work "{work}" will stop." — a session delete that silently stops work is the kind of silent failure this project forbids |
| Work closed while its turn is still finishing (grace: 2 minutes) | the work row reads `Closed` immediately while its session row may still read `Running` for the length of the grace period. That is two layers telling the truth about themselves, not a contradiction: the engine has let go, the process has not finished speaking. Nothing waits for the other before it updates |
| Work reopened during the close grace | the reopen's restart message cancels the retirement outright — the premise of it was that nobody was coming back. The session keeps its process and its transcript, and the work is `active` again with no trace of the two minutes it spent closed |
| Blocker raised *during* the close grace period | it never appears as `Closed` work needing input: it is cancelled with reason `work_closed` (§5), and the session's phase returns to idle. A question posted then is cancelled by the same rule — a closed work must not leave a card waiting on an answer nobody will act on |
| 240px sidebar | every indicator is `shrink-0` and icon-only; the title is the one `flex-1 min-w-0` element ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)) |
| Reduced motion | the one spinner degrades the way the existing one does |

## 9. Deliberately not done

- **No per-task background kill.** §2.2 — the model has no such operation, and
  inventing a UI for it would promise something the process layer cannot do.
- **No countdown on any lease.** §2.2.
- **No status of any kind back in the transcript.** Chat gave that up already
  ([work-system.md](code/work-system.md#work-messages-in-chat)); the attention
  strip is not a re-entry — it describes the *session's* own blocker and its own
  unanswered questions, holds no work state, and disappears with them.
- **No third dimension.** The activity and the question count are the two, and
  they are two because a user can be owed something while the machine is busy.
  Anything else a surface might want to say — unread, worktree, role — is an
  attribute and stays in the meta line's attribute tier.
- **No new tokens, components or dependencies.** Two lucide glyphs (`Lock`,
  `Hourglass`) and nothing else; if either is absent from the pinned lucide
  version, `Lock` → `CirclePause` with its label carrying the distinction and
  `Hourglass` → `Clock` in `secondary` (the tone, not the glyph, is what keeps
  `background` from reading as `waiting_children`).

## 10. What the automated gates will ask

Three of `web/tests/`'s scans read this work without being told to, and two new
controls are what they will land on:

- **Hit areas.** The attention strip's trailing actions ("Jump to request",
  "Answer", "Details"), the answer panel's option rows and its per-question
  "Won't answer" checkbox, and the list row's Restart button are interactive and
  must clear the floor in
  [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing). The row's button is
  icon-only on every row (§3), so it owes a box on both axes and never appears in
  the register's deferred list at all. The strip's actions carry text, so they owe
  only the height — `touch-target` over a `text-xs` line, which is the shape the
  strip already uses and the one thing worth keeping from the pill it replaced.
  The panel's option rows are the exception and take a real
  `pointer-coarse:min-h-11` box rather than an overlay: a panel has room to grow
  the box, and a real box is always simpler.
- **Indicators are not controls.** `ActivityIcon` and `ActivityDot` render no
  button and take no handler anywhere in this design; a 12px glyph that could be
  tapped is a 12px glyph somebody will try to tap.
- **Contrast.** The tone table in §1.4 reuses `ActivityBadge`'s existing
  palette unchanged, so nothing there is new to `contrast.test.ts`. The one
  genuinely new pairing is `Hourglass` in `text-th-text-secondary`, a glyph
  rather than text — so it owes the non-text floor, not AA, and that tone
  already cleared AA where the deleted `StatusBadge` lettered `open` and
  `closed` in it.

## 11. What each surface reads

| File | Change |
|---|---|
| `web/src/lib/activity.ts` | new — `deriveActivity`, `ACTIVITY_VIEW`, `needsAttention` |
| `web/src/components/ui/Activity{Icon,Badge,Dot}.tsx` | new — replace `StatusIcon` / `StatusBadge` |
| `web/src/components/ui/StatusIcon.tsx`, `StatusBadge.tsx` | deleted |
| `web/src/components/common/SidebarListItem.tsx` | `activity` + `unread` replace three booleans. It is a `web` component, not a `@pockode/shared` one — `web-cluster` has no sessions and no work, so nothing here is shared code |
| `web/src/components/Session/SessionItem.tsx` | looks the row's own `work_id` up in `workStore` and passes `sessionActivity` (§1.2) |
| `web/src/components/Chat/ChatPanel.tsx` | `turn.phase` replaces `isStreaming`; mounts the attention strip and the answer panel |
| `web/src/components/Chat/AttentionStrip.tsx` | renamed from `BlockerStrip.tsx` — §2.2 |
| `web/src/components/Chat/AnswerPanel.tsx` | new — [answering-ui.md §3](answering-ui.md#3-the-answer-panel) |
| `web/src/components/Chat/QuestionRecordItem.tsx` | replaces `AskUserQuestionItem.tsx` — a record card: four states, no form ([answering-ui.md §6](answering-ui.md#6-the-record-card-in-the-stream)) |
| `web/src/components/Chat/MessageItem.tsx` | permission card's expired banners |
| `web/src/hooks/useChatMessages.ts` | `isProcessRunning` bookkeeping replaced by §2.4 |
| `web/src/components/Project/WorkListOverlay.tsx` | the groups of §6.1, headed by a fixed `ActivityIcon` per group |
| `web/src/components/Project/WorkRow.tsx` | the row itself — `ActivityIcon`, the activity label in its meta line, the icon-only lifecycle control ([project-ui.md §3](project-ui.md#3-the-row)) |
| `web/src/components/Project/WorkDetailOverlay.tsx` | `ActivityBadge`, the `child`-only wait line, the unanswered-questions block, four-status button table |
| `web/src/components/Project/WorkPrimaryAction.tsx` | new — the four-status table and the Stop confirmation. The row renders it; the action bar writes its own labelled button from the same hook and tables, which is why this has no labelled form of its own. It absorbs `WorkListOverlay`'s exported `StartButton`, which was the second answer to "which button does this row get" |
| `web/src/components/Project/StepList.tsx` | §6.3 |
| `web/src/components/Project/ProjectTab.tsx` | dot from `useWorkNeedsAttention` (`workStore.ts`) — the same bit `SessionSidebar` badges the tab itself with (§4) |
| `web/src/utils/systemMessage.ts` | the `wait_stranded` work event (§7.2), laid out like `child_done` |
| `web/src/types/{message,work}.ts` | `turn`; `status` / `activity` / `wait`; `unanswered_questions`, `PendingQuestion` |
