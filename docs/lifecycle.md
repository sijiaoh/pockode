# Lifecycle

Three layers each own a piece of "what is going on": the **process** running an
AI CLI, the **session** holding one conversation with it, and the **work** the
agent was started to do. This document is the model — what each layer owns,
which way the dependencies run, and why each answer is the one it is.

It is the entry point. How the model is *drawn* is
[lifecycle-ui.md](lifecycle-ui.md); how each layer is *built* is
[code/agent-integration.md](code/agent-integration.md) (process and session) and
[code/work-system.md](code/work-system.md) (work). Those two assume the model and
go deep on their own half of it; this is the only place all three are described
together, and the only place the arguments that span them live.

## What was wrong

The model this replaces is worth stating, because every trap in it is one a
later design walks back into by accident.

- **"What is the agent waiting for" had five representations.** The process kept
  `promptPending` and `turnEnded`, the session kept a `needs_input` boolean, the
  work kept a `needs_input` status, and the transcript kept pending cards. A
  restart had to repair them in two separate passes, and every rule depended on
  the other four not moving.
- **Work status was a cache of process events.** `in_progress` / `needs_input` /
  `waiting` described what a process had last been seen doing, so they went stale
  the moment an event was missed — and `AutoResumer`, `StatusSyncer`,
  `HandleUserAction` and `StopOrphanedWork` each carried their own special case
  for keeping that copy in step, or for putting it right afterwards.
- **A background wait had no state at all.** The Claude adapter swallowed the
  CLI's end-of-turn frame so that a two-hour wait would read as one long thought.
  Every surface drew a spinner for work nobody was doing, and the reaper needed a
  hole cut in it to avoid collecting the process underneath.
- **A process was held by three holds with no budget.** A session waiting on an
  unanswered question or a background task held its CLI indefinitely. Collecting
  it anyway was the only alternative on offer, and that threw the question away.
- **The process drove the work directly.** There was no direction to the
  dependency, so there was no layer whose rules could be read on their own.

Each of those is one symptom of the same thing: a fact was written down in more
than one place, and the copies were maintained rather than derived.

## The three layers

| Layer | Owns | Deliberately does not own |
|---|---|---|
| Process | That it exists, and an event stream | Any turn state, any lifetime of its own |
| Session | One `TurnState` — phase, blockers, when the phase started, how the last turn ended — persisted | Any `needs_input` flag; that is derived |
| Work | `status`, `wait`, the wait's reason, the consecutive nudge count, the current step | Any mirror of what the process is doing |

**The dependency runs one way: process → session → work.** A process feeds
events into its session's reducer; the work layer reads sessions and never the
other way round. Nothing below reaches up. That is what makes each layer's rules
readable without the other two open, and it is the reason a process now has no
state: everything a process used to know was a claim about the conversation, and
the conversation is the session.

**Everything that can be derived is derived, every time.** The phase is derived
from the blockers and whether a turn is open; the lease is derived from the
phase; a work's activity is derived from its status, its wait and the session's
turn. None of those three is stored anywhere, so none of them can be stale — the
failure mode that the old model spent four repair mechanisms on does not have a
place to happen.

## Session: one reducer

A session's whole state is one `session.TurnState`, and one pure function
changes it:

```go
func ReduceTurn(state TurnState, in TurnInput) TurnTransition
```

**`ReduceTurn` is the only rule.** Every caller goes through it, including the
ones that want a turn to *end*: a reaper with an expired lease sends the signal
the equivalent real event would have sent, rather than writing the state it
wants. There is one place the transitions are defined, and therefore one place
they can be wrong.

Three things about the state are load-bearing:

- **The phase is derived, never assigned.** Anything in the way makes the phase
  `blocked`, whatever else is true — so nothing drawing a session has to look
  past `phase` to find out. Answering a prompt mid-turn simply resumes the turn,
  because the blocker goes and the phase follows. The old model had to walk a
  process back through `idle` and forward again, because it was writing two
  facts by hand.
- **`Open` — whether a turn is under way behind whatever is in its way — is the
  one thing a phase cannot say on its own.** A CLI can raise a prompt *after* the
  turn it belonged to reported its end. That session is genuinely blocked, with
  no turn behind the prompt, so withdrawing it must land on `idle` rather than
  invent a turn — because a turn nothing will ever end is, one layer down, a
  process nothing can ever collect.
- **Inputs are signals, not event types.** The mapping is not one-to-one in
  either direction: five event types all mean "the agent produced content", and a
  `system` frame means "the turn is alive" while specifically *not* meaning "the
  CLI resumed". One function translates, and nothing else in the server reads
  event types to decide what a session is doing.

Three blockers, and the list is closed on purpose: a fourth kind would have to
answer two questions before it could be added, because these three differ on
both.

| Blocker | Cleared by | What expiring it costs |
|---|---|---|
| `permission` | the user's answer, or the agent withdrawing it | the request is a denial and the tool does not run |
| `question` | the same two | nothing final — the answer can still arrive as a message |
| `background` | the agent producing content again; nobody answers it | the task itself, which is gone |

Each also ends with the death of the process that raised it, which is the one
thing all three share and the subject of the paragraph after next.

**A background wait is a blocker rather than a kind of running**, and that is the
direct repair of the two-hour spinner. The turn is openly parked; the surfaces
say so; and the reaper can budget it because the model finally knows it is
happening.

**A blocker belongs to the process incarnation that raised it and never outlives
it**, and that is not a policy — it is what a blocker already is, in both of its
shapes. A request id is only meaningful on the stdio connection that issued it, so a
prompt whose process is gone is unanswerable *as a prompt*; background work dies
with the CLI that started it. So the death of a process expires every blocker it
raised, and what becomes of an expired question
([below](#an-expired-question-is-not-a-lost-answer)) is a question the session
layer has to answer rather than dodge.

**A turn's ending is reported exactly once**, even though agents announce it
twice — Claude acknowledges an interrupt and then ends the same turn again with
an aborted result. Downstream, a second ending reads as a second stop.

**One heuristic exists in the whole lifecycle, and it lives here.** A turn
reaching idle is a fact; "this session has stopped" is a guess, because an
aborted turn is routinely followed by its replacement a moment later. The
settler holds the ending back briefly and drops it if the session comes back.
It is in the session layer so that the guess is made once, by one listener —
two consumers of a guess is how the same guess ends up made twice with two
answers, which is exactly what the old per-consumer delays were.

Details: [agent-integration.md § Turn State](code/agent-integration.md#turn-state)
and [§ Settling](code/agent-integration.md#settling).

## Process: a lease table

**A process exists for exactly as long as the session holding it has a lease it
has not used up.** That is the whole process lifecycle policy, and it is one
table: four rows, each with what holds it, what it costs to let it run, and what
expiry does.

| Lease | Held until | Default | What expiry does |
|---|---|---|---|
| turn in progress | the turn ends | none (`--turn-timeout`) | interrupt the turn |
| blocked on a person | the prompt is answered or withdrawn | 1h (`--answer-timeout`) | withdraw the prompt |
| parked on background work | the CLI produces content again | 24h (`--background-timeout`) | end the turn (warning, then done) |
| idle | the next message | 5m (`--idle-timeout`) | close the process |

**The lease is derived from the turn state and nothing else.** The phase says
which row; the phase's entry time — or, for a blocked turn, when the oldest
blocker in the way was raised — says what the budget is measured from. This is
what "a process owns no lifetime" means concretely: how long it may live is a
question about the session, answered fresh each time the reaper looks.

Three properties of the table decide more than they look like they do:

- **The rows are read in the order above, and that order is how the waits nest,
  not a preference.** A blocked turn is also a turn in progress; an idle session
  is what is left when none of the other three applies. Prompts come before
  background work because a session can hold both — an agent can park on a task
  and then ask something — and the person is the one being kept waiting.
- **Only the idle row reads "when did anything last happen".** For every other
  row silence is the normal condition of the wait, so recent silence says "busy"
  and "abandoned" in exactly the same words.
- **A zero budget means "no budget", not "expire immediately".** Read literally
  it says the opposite, since every wait is older than zero the instant it
  starts.

**An expiry produces a signal, never a state.** It sends whatever the equivalent
real event would have sent and lets the reducer decide what that means — so the
reaper cannot invent a state the rest of the model does not know about, and the
work layer sees an expiry as an ordinary turn ending rather than as a fifth kind
of event.

**Two of the four expiries are requests rather than decisions.** Interrupting is
a message to the CLI, and the turn ends when the CLI says so — deliberately, so
that a CLI winding down finishes properly. A CLI that ignores the interrupt is
what the grace backstop is for: asked once and still there a short while later,
the process is ended outright. Without that, a stuck CLI would leave a
permanently expired lease and an uncollectable process, which is the exact
failure the table exists to remove.

Why each number is what it is, and why there is no cap on *how many* processes
may exist, are in
[agent-integration.md § Where the numbers come from](code/agent-integration.md#where-the-numbers-come-from)
and [§ Why There Is No Cap](code/agent-integration.md#why-there-is-no-cap-on-how-many-processes-exist).

## Work: four intentions

| Status | Means |
|---|---|
| `open` | Never started. No session, nothing to drive. |
| `active` | The engine drives it. |
| `stopped` | The engine does not touch it; a person has to act. |
| `closed` | Finished. |

**Every status is an intention, and nothing else.** What the agent is *doing* is
not here — it is derived. That is the whole repair of the old enum: the three
values this replaces (`in_progress`, `needs_input`, `waiting`) were exactly
`active` crossed with a wait, which is why converting the stored ones needed no
guessing and no migration script.

Beside the status, an active work carries a **`wait`** — `user`
(`work_needs_input`) or `child` (`work_wait`) — which only the agent can
declare, with free text of its own saying why. A waiting work is still
`active`: the engine still
owns it, it simply must not be nudged to carry on. Both waits are cleared by
something that arrives from *outside* the session, which is what lets them
survive a restart when a work with no wait cannot — and is also why a wait is
only accepted while something that could end it still exists (below).

**Every transition into or out of `active` clears the wait and the nudge count.**
No path leaves a stale wait for the next one to trip over, and no status says
"waiting for a person" twice — `stopped` already says that, and a wait kept
beside it would be a second way to say the same thing, free to disagree as soon
as one went stale.

**A wait must have something that could still end it, and that is checked at
both ends.** A `child` wait is ended by one event only — a subtask closing — so
`work_wait` is refused when no subtask is running, and a wait whose last running
subtask leaves *without* closing is cleared by the engine, which tells the agent
what became of it. Neither half is optional, because the failure is silent: a
work stuck `active` on a wait nothing can end is never nudged (that is what a
wait means), its process goes at the idle lease, and `waiting_children` is
deliberately outside the attention dot — it would wait forever and tell nobody.
The refusal is the exact complement of the `step_done` that would close a work
whose subtasks are still running, so the way out each of those two errors names
is one the other admits. A `user` wait needs no such check: a person can always
be asked.

**The engine has five inputs and no special cases beside them**: a turn ended, a
user handed the session something to go on, a child work left `active`, a session
was deleted, the server started. Everything the old `AutoResumer` and `StatusSyncer`
did with process state changes turned out to be a rule about a turn ending,
which is what the engine reads instead.

Two of them decide more than the rest:

- **An aborted turn stops the work; a completed one with no wait gets nudged**,
  up to a bounded allowance kept on the work record itself, so a restart hands a
  stuck agent no fresh allowance. An aborted turn was taken away rather than
  finished, and carrying on is the one thing nobody asked for.
- **At startup, a work with a wait is preserved and a work without one is
  stopped.** What a wait is waiting for — a person, a child work — outlives the
  process by construction; a work with no wait was being carried by a process
  that no longer exists, and nothing is left to end its turn. This is the
  distinction the old model had no way to draw, which is why every paused work
  used to come back from a restart stopped.

  Those stops are also what can empty a `child` wait, since the subtask they
  stop may be the last one running — so **startup re-examines the waits as a
  condition once its own stops are done**, and stops the parents nothing is left
  to wake. Written as a reaction to the stops it would depend on the order they
  happened in, which is how the failure got in: the engine is not yet listening
  to the work store while recovery runs, so recovery's own stops reach nobody.
  A running server *wakes* such a parent instead and lets the agent decide; that
  presumes an agent, and at startup there is none. The same fallback covers the
  running server's own dead end — a parent whose session cannot be reached at
  all is stopped rather than left waiting, because a wait nobody was told about
  is the failure, not the cure.

**A work that has left `active` has no lease on its session's process.** The rule
hangs on the transition rather than on each command, so it holds for the
engine's own stops as much as for a user's Stop: `stopped` ends the process now,
`closed` retires it — it may finish the sentence it is in the middle of and
nothing more. What is terminated is the *process*; the session id and the
transcript stay, which is what makes Restart and Reopen resume rather than start
over.

**The agent is told these rules too, once.** A `wait` only exists because an
agent declared it, and an agent that does not know what a quiet turn costs
cannot declare one — so every system message carries one lifecycle passage
rather than each send site restating the half it remembers, which is exactly how
the old vocabulary survived in prompts after it had left the code. The one thing
in it an agent could never work out for itself is that a question asked in chat
holds a CLI process open while `work_needs_input` does not
([work-system.md § Prompt Format](code/work-system.md#prompt-format)).

Details: [work-system.md § Four Statuses and a Wait](code/work-system.md#four-statuses-and-a-wait),
[§ The Work Engine](code/work-system.md#the-work-engine), and
[§ The session lease](code/work-system.md#the-session-lease).

## Activity: one derived answer

"What is this doing" is one value, `Activity`, derived by one rule and stored
nowhere:

> The session says what is happening; the work's wait says what it is waiting
> for when nothing is happening.

The phase outranks the wait because a wait is a standing intention and a phase is
a fact about this second: an agent that calls `work_needs_input` and then keeps
writing for ten seconds *is* running, and the moment the turn settles the wait
takes over. The alternative needs a priority table between two kinds of waiting
that legitimately coexist, and every entry in such a table is an arbitrary choice
somebody later "fixes".

**The rule is evaluated in two places and written down in one.** The server
evaluates it for work rows, because a work list spans worktrees and a client does
not hold the turn state of a session in a worktree it has never opened; the
client evaluates it for session rows, which it has everything for. Go and
TypeScript cannot share an implementation, so the rule is written as a table of
cases both test suites read — a change made on one side and not the other fails
on the other side. This is the one thing in the lifecycle that could not be a
single implementation, and the shared fixture is what keeps "two
implementations" from meaning "two rules".

The ten leaves, their glyphs and where each is painted are
[lifecycle-ui.md § 1](lifecycle-ui.md#1-the-vocabulary); the server side is
[work-system.md § Activity](code/work-system.md#activity).

## An expired question is not a lost answer

The lease table can take a process away from an unanswered prompt, so the model
owes an answer to "what happens to the answer". It is different for the two
kinds, and the difference is not a preference:

- **A question can still be answered afterwards**, as an ordinary message that
  starts a new turn. The message carries the original question with it, because
  the agent's own record of having asked is gone.
- **A permission cannot.** A permission that was not granted is a denial,
  whichever way the waiting ended, so an expired permission request is read-only
  and states its outcome.

That asymmetry is what makes an hour affordable for the answer lease. Losing the
process costs one cold resume; it does not cost the answer.

Three things can end a prompt without anybody answering it — the process ended,
the answer lease ran out, the work above the session closed — and the client is
told which, on a record of its own, because "why did this stop waiting for me" is
one question with three quite different next steps. A fourth case is that the
server cannot say which happened, and that is an answer rather than a gap: the
card then states what is true of all three.

Details: [agent-integration.md § What Becomes of an Expired Prompt](code/agent-integration.md#what-becomes-of-an-expired-prompt)
and [lifecycle-ui.md § 5](lifecycle-ui.md#5-expiry).

## What was measured rather than assumed

The answer lease rests on a claim about somebody else's software: that a CLI
killed with an unanswered prompt outstanding can be resumed, and that a late
answer sent as an ordinary message is understood. That was **measured**, against
**claude 2.1.263** and **codex-cli 0.153.0** on Linux, by killing real sessions
through Pockode's own stop path — `SIGKILL` to the process group, no graceful
exit and no flush on the way out, which is exactly the shape of a crash or a
reap.

| Claim | What was observed |
|---|---|
| A killed CLI leaves a dangling tool call | Yes, and sometimes less than that: killed within a second of the prompt, the transcript holds no trace of the question at all. Both shapes have to be recoverable |
| Resume accepts it | Yes, with no error and no warning, on both CLIs. Claude's recovery ladder never escalated past a plain resume, and Codex came back on the same thread id |
| The CLI repairs it by supplying a result | **No.** Claude appends a pair of meta messages and leaves the dangling call exactly where it was |
| History before the dangling point survives | Yes, on both CLIs |
| A late answer sent as a plain message is understood | Yes — but the model is told the question was never asked, because the CLI drops the dangling call when it rebuilds the API request |
| A transcript truncated mid-line still resumes | Yes, on both CLIs; the partial trailing record is ignored |
| An unanswered Codex approval is re-offered after resume | No. That exec is simply void, which is what "a permission does not degrade" already assumes |

Four design decisions stand on this and would have to be revisited without it:
the answer lease may expire (the answer is not lost with the process), the
default path needs no fork fallback, the degraded answer must carry the question
text with it, and the authority on what became of a prompt is Pockode's own
history rather than the CLI's transcript.

**The boundaries of what was measured matter as much as the result.** These are
each CLI's current behaviour, not a protocol guarantee, and they expire the way
every finding in [tool-call-model.md](tool-call-model.md) and
[agent-integration.md § Protocol Baselines](code/agent-integration.md#protocol-baselines)
does — re-run them when a CLI is upgraded. Three things were specifically *not*
established:

- **Resume across a long wall-clock gap.** Only resume across a process death was
  tested. Whether a transcript is still there after a day, and whether the
  vendors' own retention applies, is unverified — which is why the answer budget
  is an hour rather than day-scale.
- **Two dangling tool calls in one turn**, as a parallel tool call killed midway
  would produce.
- **Whether Claude's interrupt releases a control request it is blocking on.**
  The grace backstop exists because this is unknown: either the CLI ends the
  turn or the process does, so the outcome is bounded rather than assumed.

## Known limits, kept on purpose

Each of these was found, weighed and left. They are written here so the next
reader recognises a decision rather than a gap.

- **Retirement withdraws prompts without a lock.** A closing work and the event
  stream can read the same blocker at once and cancel it twice. The second
  cancellation names a blocker that is already gone, and the client handles
  cancellation idempotently, so the entire cost is one extra line in a
  transcript. The lock would have to be reentrant, because injecting re-enters
  the same function — a structural change for a benign duplicate.
- **Refusing an answer nobody is waiting for is a check, not a lock**
  ([agent-integration.md](code/agent-integration.md#an-answer-nobody-is-waiting-for)).
  Two clients answering in the same instant can both pass it, exactly as before;
  making it a lock means holding one across a round trip to the CLI.
- **A restart has a theoretical window before a work's kickoff goes out**, in
  which the previous run's abort could stop a work that was just claimed. The
  settle delay already covers every case where the session comes back inside it —
  a new turn cancels the pending ending outright — and what is left is
  unreachable in practice: having a turn to abort at all means that worktree is
  loaded, and from a loaded worktree kickoff is a matter of milliseconds. Closing
  it properly would need a "when was this work last started" field, and the only
  field that could carry it also moves when somebody edits a title — which would
  swallow stops that should land, a worse bug than the one being fixed.
- **There is no cap on how many processes may exist.** Both available rules for
  what to do at the cap are worse than the problem
  ([agent-integration.md](code/agent-integration.md#why-there-is-no-cap-on-how-many-processes-exist)).
- **An expired permission card has no `Expired` chip**, only the muted glyph that
  distinguishes it from a denial, because a tool row's one chip slot is already
  the tool's summary ([lifecycle-ui.md § 5.2](lifecycle-ui.md#52-an-expired-permission-can-only-be-a-denial)).
  This predates the redesign, and what the redesign did owe the card — a banner
  stating the outcome — is there.

## Where to read further

| Document | Covers |
|---|---|
| [lifecycle-ui.md](lifecycle-ui.md) | The presentation layer: the ten activities, the blocker strip, expired cards, work list grouping, button rules |
| [code/agent-integration.md](code/agent-integration.md) | The process and session layers in code: the reducer, the lease table, expiry records, retirement, restart repair, and both CLI adapters |
| [code/work-system.md](code/work-system.md) | The work layer in code: statuses and transitions, the engine's five inputs, the command surface, prompts |
| [projects/workflow-engine.md](projects/workflow-engine.md) | The same engine from the project system's side, with the prompt builders |
| [agent-event.md](agent-event.md) | The event stream the reducer's signals are translated from |
