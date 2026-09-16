# Lifecycle UI

How the three-layer lifecycle (process → session → work) is presented to the
user. The model itself — `TurnState`, leases, work `status` + `wait` — belongs to
`docs/lifecycle.md`; this document is only the presentation layer, and it is
written to be implemented from: every state has one glyph, one tone, one label
and one rule for when its buttons exist.

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

`Activity` is the only state any surface paints. Ten leaves, and there is never
more than one — the layers it is derived from are each exclusive.

| `Activity` | Means | Glyph | Tone | Label |
|---|---|---|---|---|
| `open` | Work exists, never started | `Circle` | muted | Open |
| `running` | A turn is producing output | `CircleDot` | accent | Running |
| `needs_answer` | Turn blocked on `AskUserQuestion` | `CircleHelp` | warning | Needs answer |
| `needs_permission` | Turn blocked on a permission request | `Lock` | warning | Needs permission |
| `needs_message` | Work waits on the user (`work_needs_input`) | `CirclePause` | warning | Needs input |
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
- **Three separate "needs you" leaves, one hue.** Warning marks *the user is the
  blocker*, and a single hue is what makes the attention dot (§4) possible at
  all. What the user has to *do* differs in every case — pick an option, allow or
  deny, write a message — so the glyph and the label differ. Do not collapse
  them into one `needs_input` again: that is the field this redesign removes.
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
                              question   in turn.blockers -> needs_answer
                              otherwise (background)      -> background
  // turn.phase == "idle", or there is no turn at all
  work.wait == "user"      -> needs_message
  work.wait == "child"     -> waiting_children
  otherwise                -> idle
```

A session uses the same function, and what it passes for the work half is the
one subtle call in this document:

```
sessionActivity(session):
  work = the work whose session_id is this session, from workStore
  activity(work?.status == "active" ? work : undefined, session.turn)
```

**A session row sees a work's `wait`, never its `status`.** The wait is a fact
about this conversation — the agent asked *here* for a message, and the row is
what tells the user a session they are not looking at is waiting on them. The
status is not: a session outlives the work's lifecycle, and a row reading
`Stopped` or `Closed` would be reporting the work list's business in a list that
cannot act on it. Passing the work only while it is `active` gets both halves
from one expression, because the three status leaves are unreachable by
construction once `active` is the only status that arrives.

The lookup is always available: the work list is global and survives worktree
switches, while the session list is scoped to one worktree — so every session on
screen has its work in the store, never the other way round.

Why phase outranks `wait` rather than the other way round: a `wait` is a standing
intention, a phase is a fact about this second. An agent that calls
`work_needs_input` and then keeps writing for another ten seconds *is* running,
and the row should say so; the moment the turn settles, the `wait` takes over.
The alternative — `wait` first — needs a priority table between two kinds of
waiting that can legitimately coexist, and every entry in such a table is an
arbitrary choice someone later "fixes".

Permission outranks question when both are somehow live: a permission request
cannot degrade (§5) and so is the one with a deadline that costs something.

### 1.3 Where it is computed

- **Sessions** carry `turn` on the wire; the client maps `turn` (plus the work
  it already holds, §1.2) to an `Activity` with the pure function above. Chat
  needs `phase` and `blockers` in detail anyway, so sending the raw state and
  mapping locally costs nothing.
- **Work rows carry a server-computed `activity` string.** The work list is
  global across worktrees while the session list is worktree-scoped
  ([work-system.md § Displaying a Work's Worktree](code/work-system.md#displaying-a-works-worktree)),
  so a client *cannot* derive a work's activity — it does not hold the
  `TurnState` of a session in another worktree. The server owns the function; the
  client owns the visual map. Those are the two single sources, and they are
  single because each lives where the data is.
- An unrecognised `activity` value normalises to `idle` at the wire boundary, the
  same place `normalizeOrigin` folds legacy message origins. Old index values are
  normalised on load, not migrated.

Wire shape the surfaces below assume:

```ts
type TurnPhase = "idle" | "running" | "blocked";
type BlockerKind = "permission" | "question" | "background";

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
plus `activity`, `wait?: "user" | "child"` and `wait_reason?: string` (free text
the agent supplied, shown on the detail page only).

### 1.4 The three components

`web/src/lib/activity.ts` — `deriveActivity(work, turn)`,
`sessionActivity(session, work)` (the three-line wrapper in §1.2),
`ACTIVITY_VIEW` (`{ Icon, tone, label, ariaLabel }` per leaf),
`needsUser(activity)`.
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
| `ActivityBadge` | pill: glyph + label | work detail heading, story child rows on wide layouts |
| `ActivityDot` | 8px dot, warning, `aria-hidden` | ProjectTab, story rollup (§4) |

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

A row shows one indicator. Precedence collapses to two lines, because the layers
are exclusive:

1. `activity != idle` → `ActivityIcon` (spinner in place of the glyph for a
   running session row).
2. otherwise `unread` → the existing accent dot.

Today's "running beats needs_input" precedence disappears with the fields it
arbitrated between. `unread` and `MarkRead` are untouched by this redesign.

"Surface" here means *a surface that paints an `Activity`*. The transcript's own
motion — a streaming bubble, a tool call's own progress — is untouched and is not
covered by this rule: those describe one message, not a state, and a message that
is arriving is the one thing a spinner has always been honest about.

## 2. Session surfaces

### 2.1 Session list row

`SidebarListItem`'s `isRunning` / `needsInput` / `hasChanges` props become
`activity: Activity` / `unread: boolean`. The `<output aria-label="AI
responding">` spinner keeps its markup and becomes one branch of the indicator
slot; every other leaf renders `ActivityIcon` with `aria-label` from
`ACTIVITY_VIEW` (a 12px glyph reads as an indicator, not as an action, so it
needs no hit area).

| Activity | Row indicator | aria |
|---|---|---|
| `running` | spinner, accent | "Agent is running" |
| `needs_answer` | `CircleHelp` warning | "Waiting for your answer" |
| `needs_permission` | `Lock` warning | "Waiting for your permission" |
| `needs_message` | `CirclePause` warning | "Waiting for your message" |
| `waiting_children` | `Clock` accent | "Waiting on subtasks" |
| `background` | `Hourglass` secondary | "Waiting on a background task" |
| `idle` | unread dot, or nothing | — |

`needs_message` and `waiting_children` are the two a session row can only get
from a work, and only from an `active` one, by the rule in §1.2; `open`,
`stopped` and `closed` never reach a session row at all. Everything else in the
table is read from the session's own turn, so it reaches a row whether or not
any work is behind it.

### 2.2 Chat: the blocker strip

One line between the transcript and `InputBar`, present only while
`phase == "blocked"`. It borrows `ForkOriginBanner`'s chrome — centred, `text-xs`,
`size-3` glyph, muted — because both are one-line statements about the transcript
rather than controls, and the pane should have one vocabulary for them. It sits
below the list (not at the top like the fork banner) because it describes the
transcript's *end*.

| Blocker | Copy | Trailing action |
|---|---|---|
| `question` | "Waiting for your answer." | "Jump to question" |
| `permission` | "Waiting for your permission." | "Jump to request" |
| `background` | "Waiting on a background task — nothing to answer." | "Details" (expands) |

"Jump to question" reuses `PendingQuestionPill`'s jump (scroll, ring, focus the
header row) via the leading blocker's `request_id`; the strip does not
re-implement it — `MessageList` exposes the jump it already owns, because the
scroll container is there and a second implementation of a scroll-and-highlight
is a second set of edge cases,
and the pill continues to own the *scrolled-away* case. The two can be on screen
together and that is correct: the pill counts questions you cannot see, the strip
states why the agent is quiet.

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

No countdown to the 24h lease. A number the user cannot change, counting down to
an outcome they would not recognise, is worse than the sentence above; the lease
expiring produces a visible warning in the transcript (existing `WarningEvent`
path), which is where a deadline belongs.

### 2.3 Chat: composer and Stop

`isStreaming` — today `lastIsSending || (lastIsStreaming && isProcessRunning)` —
is replaced by

```
turnOpen = lastIsSending || turn.phase != "idle"
```

The optimistic half stays, and dropping it would be the one regression easiest to
ship by accident: between the user pressing send and the server reporting
`running` there is a round trip, and a composer that only watched `turn` would
leave the user with a live send button and no Stop for the length of it. What the
`turn` half removes is the part that was never reliable — inferring liveness from
the last message's status and a `process_ended` that a restart never wrote.

The Stop button exists whenever a turn is open:

| `phase` | Stop button | Escape shortcut | Send | Composer hint |
|---|---|---|---|---|
| `idle` | hidden | inactive | enabled | — |
| `running` | shown | active | disabled | — |
| `blocked(question)` | shown | active | disabled | the strip |
| `blocked(permission)` | shown | active | disabled | the strip |
| `blocked(background)` | shown | active | disabled | the strip |

Send stays disabled for every open turn, including blocked ones: the process is
alive and its stdin is owned by the pending request, so a typed message would
either be dropped or arrive in an order nobody chose. The user's two exits are
the card and Stop, and both are on screen. Typing is never blocked — only
sending — so a drafted message survives the wait. Model / mode / effort
selectors stay disabled for the whole open turn, as they are today.

The one case where an *un*blocked composer matters is an expired card, and that
is a different session state: the process is gone, so `phase` is `idle` and the
composer is live. §5.

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

Same table for the list and the detail page; the list renders the primary one
icon-only (`StartButton`'s existing shape, extended to Restart) and the detail
page renders labels in `BottomActionBar`. `Start` and `Restart` are the same
control with two labels, as today — the label is the honest difference, since
one starts a fresh session and the other resumes a kept one.

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

One dot, one hue, one meaning: **`needsUser(activity)` is true somewhere below
this thing.** `needsUser` is exactly `needs_answer | needs_permission |
needs_message`.

| Surface | Condition |
|---|---|
| ProjectTab | any work in the list satisfies `needsUser` |
| Story row | the story satisfies `needsUser`, or any of its tasks does |
| Session row | the row's own activity (it *is* the leaf) — §2.1 |

Deliberately outside the dot:

- **`background` and `waiting_children`.** There is nothing to do. A dot that
  means "something is happening" is a dot the user learns to ignore, and that
  habit is what made the old needs-input dot worthless.
- **`stopped`.** A stopped work needs a human, but it needs one *whenever the
  human gets to it*; a dot that only clears when someone restarts every stale
  work is permanent, and a permanent dot is not a signal. Stopped work is found
  through its own list group, which is ordered above `open` for that reason.

## 5. Expiry

A blocker belongs to the process that raised it and ends with it. Three reasons
a blocker can end without the user answering, and the user has to be able to tell
which one happened and what they can still do. The reason rides on the record
next to its status, as
`reason: "process_ended" | "timeout" | "work_closed"` — one field for both the
`expired` and the `cancelled` status, because "why did this stop waiting for me"
is one question.

**That field is not on the record yet**; it lands with the question-timeout work
that gives it its third value. Until it does, both cards state what is true of
all three reasons rather than guessing which one happened, and the *behaviour*
below — an expired question answerable as a message, an expired permission
read-only — is in place, because it does not depend on the reason. The three
banners are the copy for the field's three values when it arrives.

### 5.1 An expired question is still answerable

Chip `Expired`, muted, exactly as today — the card keeps its existing `expired`
palette (`bg-th-bg-tertiary text-th-text-muted`, opaque for the contrast reason
recorded in `AskUserQuestionItem`). What changes is that the form stays **live**
and the submit button relabels.

| `reason` | Banner | Form | Submit |
|---|---|---|---|
| `process_ended` | "The agent's process ended before this was answered. You can still answer — it will be sent as a new message and the agent will pick up from there." | enabled | "Send as message" |
| `timeout` | "This question timed out after 24 hours without an answer. You can still answer — it will be sent as a new message and the agent will pick up from there." | enabled | "Send as message" |
| `work_closed` | recorded as `cancelled`, not expired: "This question was cancelled because the work was closed." | read-only | none |

"Send as message" rather than "Send": the button says what will happen, because
what happens is not what the card originally promised. Pressing it produces an
ordinary user message in the transcript (the selection, formatted the way the
card's collapsed answer summary formats it); a work behind that session returns
to `active`, and a session with no work simply starts a turn, as any message
does.

The card itself records **nothing** afterwards. It stays `Expired` with no answer
summary, and the answer is visible as the message directly below it. That is the
truth: the request was never answered, a message was sent. Writing a late answer
back onto the request would put live state into an immutable record — the rule in
[work-system.md § Work Messages in Chat](code/work-system.md#work-messages-in-chat) —
and would then have to explain a "Answered" chip on a tool call that never got a
result. The user is not left guessing, because their own message appears
immediately, optimistically, as it does for anything they send.

The pending-question pill keeps counting only `pending` questions
([pending-question-entry.md](pending-question-entry.md)). An expired question
blocks nothing, so the affordance whose purpose is unblocking a blocked agent has
no business announcing it. The entry point is the row the expiry already changed:
the work's `Stopped`, or the session's own row going quiet. This is a deliberate
non-change.

### 5.2 An expired permission can only be a denial

Chip `Expired`, muted, and the card is **read-only with no buttons at all** — its
existing `pending` branch already gates the button row on `isPending`, so the
only change is the banner. Glyph stays `X` muted, against the expired question's
`CircleHelp` muted: one is still a question, the other is closed.

| `reason` | Banner |
|---|---|
| `process_ended` | "The agent's process ended before this was answered, so it counted as a denial and the tool did not run." |
| `timeout` | "This request timed out after 24 hours, so it counted as a denial and the tool did not run." |
| `work_closed` | "This request was cancelled because the work was closed. The tool did not run." |

The two cards are told apart by their **affordances**, not by their chrome: an
expired question has a live form and a button, an expired permission has neither
and states an outcome. A user who can act sees something to press; a user who
cannot sees why. Reaching for two different chips instead would put the whole
distinction in a colour that neither card can afford to shout in.

## 6. Work surfaces

### 6.1 List grouping

Stories are grouped; tasks stay nested under their story exactly as today, so a
task never leaves its parent to join a group of its own.

Five groups, in this order, each headed by a glyph and a label the way today's
status groups are headed:

| Group | Contains | Header glyph | Why here |
|---|---|---|---|
| Needs you | `status == active` and `needsUser(activity)` | `CirclePause` warning | the only group with a task for the user |
| Active | every other `active` work | `CircleDot` accent | running, background, waiting, idle |
| Stopped | `status == stopped` | `CircleStop` error | a human must act, but not now |
| Open | `status == open` | `Circle` muted | not started |
| Closed | `status == closed` | `CircleCheck` muted | sorted newest-first, collapsed by default, as today |

A header glyph is fixed per group, not taken from the rows inside it: *Needs you*
holds three different leaves and a header that borrowed one of them would
mislabel the other two. The rows keep their own precise leaf, which is where the
distinction belongs.

Grouping is by `status` plus the single `needsUser` predicate — never by the full
`Activity`. A list that regrouped on every phase change would reorder itself
while being read. A work moving between *Needs you* and *Active* is the one
movement worth the disruption, since it is the one the user is waiting for.
"Needs you" is first, where today's order puts `in_progress` first: a list of
work is a list of things to do, and the things needing a person come before the
things running by themselves.

Within a row, nothing changes but the vocabulary: `StatusIcon` → `ActivityIcon`,
`statusLabels[...]` → `ACTIVITY_VIEW[...].label` in the `aria-label`, and the
task row's left bar keys off the new leaves — warning for any `needsUser` leaf,
error for `stopped`, none otherwise (today: `needs_input`, `stopped`).

### 6.2 Detail page

- Heading row: `ActivityBadge` beside `WorktreeBadge`, unchanged in layout.
- **Under the badge, one muted line for a wait that has a reason.** For
  `needs_message`: the agent's own `wait_reason` — this is the only place the
  user can read *what* the agent wants, and today it is nowhere. For
  `waiting_children`: "Waiting on {n} subtask(s)". For `background`: "Waiting on
  a background task since {HH:MM}" with Open Chat as the way to see it.
  Absent otherwise; no empty row.
- Children section header gains an active count — "{n} active" — whenever any
  child is `active`. This is what makes the `step_done` rejection in §7 legible
  without a second explanation.

### 6.3 StepList

The current step is highlighted for every status except `open` and `closed`:

```
isCurrent   = status != "open" && status != "closed" && index == currentStep
isCompleted = status == "closed" || index < currentStep
```

Same behaviour as today's four-value `isActiveState` check, one less thing to
keep in sync with the status enum. `StepList` takes `status`, not `activity`: a
step's position does not change because a turn started.

## 7. `step_done` with active subtasks

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

## 8. Edge cases

| Situation | Behaviour |
|---|---|
| `active` work whose session was deleted | engine moves it to `stopped`; the row says Stopped and offers Restart. No "ghost" activity, because activity is never read from a missing session |
| `active` work in a worktree that is not loaded | server-computed `activity` still arrives, so the row is fully drawn — the reason §1.3 puts the derivation on the server |
| Turn ends while the row is on screen | `running` → `idle` after the settle delay, one static glyph to another; no flash, because the glyph does not change |
| Both a question and a background task live | `blockers` is a set, permission > question > background decides the leaf; the strip states the question, which is the one with something to press |
| Fork of a session mid-turn | the fork starts at `phase: idle`, so it has a live composer and no Stop button on its first frame |
| Work stopped by the nudge limit | `stopped`, plus the engine's comment saying so. Chat shows nothing extra — the transcript already ends where the agent stopped answering |
| Work closed while a question is pending | question → `cancelled`, reason `work_closed` (§5.1); the card explains it rather than sitting pending forever |
| Server restart with a blocked turn | blockers expire on process death and are written to history, so on reconnect the cards read Expired and the composer is live |
| `activity` the client does not know | normalised to `idle` at the wire boundary; an unknown state must not blank a row |
| Story with children in several activities | the story shows its *own* activity; the rollup dot is the only thing children contribute to a story row |
| Answer pressed on a card that expired a moment ago | the RPC fails with the server's own reason ("the process that raised this request has ended"); the card flips to Expired with §5's banner and the error is shown inline under the buttons. A question card is then answerable again as a message, a permission card is not — the same two outcomes, reached a second later |
| Session deleted while its work is `active` | the work moves to `stopped`. The delete confirmation says so: "Delete "{title}"? The work "{work}" will stop." — a session delete that silently stops work is the kind of silent failure this project forbids |
| Work closed while its turn is still finishing | the work row reads `Closed` immediately while its session row may still read `Running` for the length of the grace period. That is two layers telling the truth about themselves, not a contradiction: the engine has let go, the process has not finished speaking. Nothing waits for the other before it updates |
| Blocker raised *during* the close grace period | it never appears as `Closed` work needing input: a question raised then is cancelled with reason `work_closed` (§5.1), and the session's phase returns to idle |
| 240px sidebar | every indicator is `shrink-0` and icon-only; the title is the one `flex-1 min-w-0` element ([sidebar-ui.md](sidebar-ui.md#the-narrow-width-rule)) |
| Reduced motion | the one spinner degrades the way the existing one does |

## 9. Deliberately not done

- **No per-task background kill.** §2.2 — the model has no such operation, and
  inventing a UI for it would promise something the process layer cannot do.
- **No countdown on any lease.** §2.2.
- **No status of any kind back in the transcript.** Chat gave that up already
  ([work-system.md](code/work-system.md#work-messages-in-chat)); the blocker
  strip is not a re-entry — it describes the *session's* current blocker, holds
  no work state, and disappears with it.
- **No new tokens, components or dependencies.** Two lucide glyphs (`Lock`,
  `Hourglass`) and nothing else; if either is absent from the pinned lucide
  version, `Lock` → `CirclePause` with its label carrying the distinction and
  `Hourglass` → `Clock` in `secondary` (the tone, not the glyph, is what keeps
  `background` from reading as `waiting_children`).

## 10. What the automated gates will ask

Three of `web/tests/`'s scans read this work without being told to, and two new
controls are what they will land on:

- **Hit areas.** The blocker strip's trailing action ("Jump to question",
  "Details") and the list row's Restart button are interactive and must clear
  the floor in [responsive-ui.md](responsive-ui.md#hit-areas-and-spacing).
  Restart is icon-only in a row, so it owes a box on both axes and takes
  `StartButton`'s existing shape; the strip's action carries text, so it owes
  only the height — `touch-target` over a `text-xs` line, the way the pending
  question pill does it.
- **Indicators are not controls.** `ActivityIcon` and `ActivityDot` render no
  button and take no handler anywhere in this design; a 12px glyph that could be
  tapped is a 12px glyph somebody will try to tap.
- **Contrast.** The tone table in §1.4 reuses `ActivityBadge`'s existing
  palette unchanged, so nothing there is new to `contrast.test.ts`. The one
  genuinely new pairing is `Hourglass` in `text-th-text-secondary`, a glyph
  rather than text — so it owes the non-text floor, not AA, and that tone
  already clears AA anyway where `StatusBadge` letters `open` and `closed` in
  it.

## 11. What each surface reads

| File | Change |
|---|---|
| `web/src/lib/activity.ts` | new — `deriveActivity`, `ACTIVITY_VIEW`, `needsUser` |
| `web/src/components/ui/Activity{Icon,Badge,Dot}.tsx` | new — replace `StatusIcon` / `StatusBadge` |
| `web/src/components/ui/StatusIcon.tsx`, `StatusBadge.tsx` | deleted |
| `web/src/components/common/SidebarListItem.tsx` | `activity` + `unread` replace three booleans. It is a `web` component, not a `@pockode/shared` one — `web-cluster` has no sessions and no work, so nothing here is shared code |
| `web/src/components/Session/SessionItem.tsx` | resolves the session's work from `workStore` and passes `sessionActivity` (§1.2) |
| `web/src/components/Chat/ChatPanel.tsx` | `turn.phase` replaces `isStreaming`; mounts the blocker strip |
| `web/src/components/Chat/BlockerStrip.tsx` | new — §2.2 |
| `web/src/components/Chat/AskUserQuestionItem.tsx` | expired stays answerable; "Send as message"; three banners |
| `web/src/components/Chat/MessageItem.tsx` | permission card's expired banners |
| `web/src/hooks/useChatMessages.ts` | `isProcessRunning` bookkeeping replaced by §2.4 |
| `web/src/components/Project/WorkListOverlay.tsx` | five groups, `ActivityIcon`, Restart in the row |
| `web/src/components/Project/WorkDetailOverlay.tsx` | `ActivityBadge`, wait line, four-status button table |
| `web/src/components/Project/StepList.tsx` | §6.3 |
| `web/src/components/Project/ProjectTab.tsx` | dot from `needsUser` |
| `web/src/types/{message,work}.ts` | `turn`; `status` / `activity` / `wait` / `wait_reason` |
