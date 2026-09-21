# Workflow Engine

The workflow engine manages work item lifecycles through status transitions and automatic session management.

The work item is the topmost of three layers that each own part of "what is going on", and the other two — the session's turn state and the process's lease — are what this engine reads. The model all three share is [lifecycle.md](../lifecycle.md).

## Statuses

| Status    | Meaning                                       |
| --------- | --------------------------------------------- |
| `open`    | Created, not yet started                      |
| `active`  | The engine drives it                          |
| `stopped` | The engine does not touch it; a person must act |
| `closed`  | Work completed                                |

Every one of them is an intention. What the agent is *doing* — running, waiting
on an answer, parked on a background task — is derived
([work-system.md](../code/work-system.md#activity)) from the status, the wait
below and the session's turn state, and is never stored.

### Wait

An active work may declare what it is waiting for. The wait is orthogonal to the
status: a waiting work is still active — the engine still owns it — it simply
must not be nudged.

| Wait | Set by | Cleared by |
|---|---|---|
| none | every transition into active | — |
| `child` | `work_wait` | a child work closing, or a user message — or the engine, when no child is left that could close |

**Waiting on a person is not a wait.** An agent that needs something from the
user posts a question (`question_post`); the question lives on the session, the
agent carries on working, and the answer arrives as an ordinary message. The
engine reads the session's unanswered list directly, so a turn ending with one
outstanding is not nudged either ([work-system.md](../code/work-system.md#input-1-a-turn-ended)).
The `user` wait and its `wait_reason` are gone.

`NudgeCount` is how many times in a row the engine has told the agent to carry on
with nothing to show for it.

A wait on children is ended by a child closing and by nothing else, so it is
checked at both ends: `work_wait` is refused when no child of the work is
running, and a wait whose last running child leaves *without* closing is cleared
by the engine with a message saying what became of it. Either case would
otherwise leave a coordinator waiting forever, and waiting quietly — the engine
does not nudge a waiting work
([work-system.md](../code/work-system.md#input-6-a-child-work-left-active)).

## Status Transitions

`active` and `stopped` — the **live** statuses — reach each other freely. Only
`open` and `closed` gate anything, so a stale status can never lock a work item
out of being advanced or finished. See
[work-system.md](../code/work-system.md#state-machine) for the diagram and for
why the pair is shaped that way.

### Transition Table

| From      | To        | Trigger                                    |
| --------- | --------- | ------------------------------------------ |
| `open`    | `active`  | `Store.Claim` (fresh start — no session yet) |
| `active` / `stopped` | `open`    | `Store.RollbackStart` (fresh start failed) |
| `active` / `stopped` | `stopped` | `Store.RollbackStart` (restart failed)     |
| live with an active child | `active` + `child` | `Store.SetChildWait` (`work_wait`; refused when no child is running) |
| live      | `stopped` | `Store.Stop` (user Stop, aborted turn, nudge limit, deleted session, startup recovery) |
| live      | `active`  | `Store.Activate` (a user message, a child closing) |
| `active`  | `active`  | `Store.ClearNudges` (an answer to a posted question — the allowance only) |
| `active` + `child` | `active`  | `Store.ClearChildWaitIfStranded` (the last child that could close left active without closing) |
| `stopped` | `active`  | `Store.Claim` (restart — the work already owns a session, which is reused) |
| live      | `active`  | `Store.StepDone` (steps remain — the advance also repairs a stale status) |
| live      | `closed`  | `Store.StepDone` (no steps remain)         |
| `closed`  | `active`  | `Store.Reopen` (reopen closed item)        |

Every transition into or out of `active` clears the wait and the nudge count, so
no path leaves a stale wait for the next one to trip over.

> Source: `server/work/validation.go` — `ValidateProgress` (may the agent move this work along?) and `ValidateStartable` (may a session be started for it?). The code holds no transition table of its own: with the live statuses mutually reachable, those two predicates say everything an edge list would, and a second copy would only be one more thing to keep in sync. The table above enumerates the *triggers*, which the predicates do not name.

### SessionID Management

SessionID changes are encapsulated in intent-based Store methods:

- **`Start`** — sets a new sessionID (fresh start or restart)
- **`RollbackStart`** — clears sessionID on fresh-start failure; preserves on restart failure (→ `stopped`). It takes the sessionID the failed start claimed, because that is what identifies the start being undone: a failed kickoff deletes its session and the engine stops the work of a deleted session, so the stop and the rollback race and both orders have to converge ([work-system.md](../code/work-system.md#intent-driven-transitions))
- **`Claim`** — reuses the work's existing sessionID when it has one (a restart preserves chat history); generates a fresh one otherwise
- **`Activate`** — preserves the existing sessionID
- All other transitions leave sessionID unchanged

A work leaving `active` loses its session's *process*, never its session: the id
and the transcript stay, which is what makes Restart and Reopen resume rather
than start over. See
[work-system.md](../code/work-system.md#the-session-lease).

> Source: `server/work/store.go` — intent-based transition methods.

## Step Completion

Work items transition through `StepDone`; there is no intermediate `done` state.
Any work item with remaining steps advances to the next step and stays `active`.
When no steps remain, the work item closes. Waiting for child work is handled
explicitly through `work_wait`, not `StepDone`.

When a child work closes, the engine tells its parent — and clears the parent's
wait if it was waiting on its children — so the coordinator can review results
and continue orchestration.

> Source: `server/work/store.go` — `StepDone`.

## The Work Engine

`work.Engine` is the only thing that moves a work item without being asked to. It
has eight inputs and no special cases beside them:

| Input | What it does |
|---|---|
| A turn ended | aborted → `stopped`; otherwise nudge, unless the work declared a wait or has a question nobody has answered; `stopped` once the allowance runs out |
| A user message | back to `active`, wait and nudges cleared |
| The user answered a posted question | nudges cleared, and a `child` wait deliberately left standing — no subtask closed |
| Another agent answered one (`question_answer`) | nudges cleared, and nothing else: only a person takes a `stopped` work off the shelf |
| An agent posted a question | passed up to an *active* parent story as `child_question`, which clears nothing and is never retried |
| A child work left `active` | a child that *closed*: tell an *active* parent and clear a `child` wait; a child that left any other way: clear a `child` wait nothing is left to end, and wake the parent to decide |
| The session was deleted | → `stopped` |
| Server startup | `active` with no wait → `stopped` + comment; a work with an unanswered question is preserved; a work waiting on children is preserved only while one of them is still `active`, and otherwise `stopped` + comment |

The full reasoning for each — including why a work with a question outstanding
survives a restart and a driven one does not, why a stranded wait stops the work
even so, and why startup *stops* the parent that a running server would *wake*
— is in [work-system.md](../code/work-system.md#the-work-engine). Two properties
worth naming here:

- **It hears a *settled* turn ending**, from `session.TurnSettler`, not a process
  state change. Every rule that used to read a process state turned out to be a
  rule about a turn ending.
- **The nudge count lives on the work record**, so a restart does not hand a
  stuck agent a fresh allowance. `DefaultMaxNudges` is 3, and the stop it ends in
  leaves a comment saying so.

> Source: `server/work/engine.go`.

## Commands

The six things a person or an agent can ask for live in `work.Operations`, and
both transports go through it — the WebSocket handler (user actions) and the MCP
`Executor` (AI actions) — so a user-triggered command and an AI-triggered one
have identical effects.

| Command | Store transition | Side effect |
|---|---|---|
| `StartWork` | `Claim` | `WorkStartHandler` creates the session and sends the kickoff; rolls back on failure. Detached context, so a caller timeout cannot orphan a half-created session |
| `StopWork` | `Stop` | the process ends with the transition |
| `ReopenWork` | `Reopen` | reopen nudge (`NotifyReopen`) |
| `StepDone` | `StepDone` | next-step prompt while steps remain (`NotifyStepDone`); an advance withdraws the questions posted during the step |
| `Wait` | `SetChildWait` | refused when no subtask of the work is running |

Process termination is deliberately not one of these side effects: it belongs to
the transition rather than to the command that caused it, so the engine's own
stops end a process exactly as a user's Stop does
([work-system.md](../code/work-system.md#the-session-lease)).

> Source: `server/work/operations.go`.

## WorkStarter

`WorkStarter` implements `WorkStartHandler` and performs the session initialization sequence for work items that have already been claimed (`status=active`, `sessionID` set).

**Fresh start sequence:**
1. Validate `agent_role_id` exists.
2. Acquire the work's worktree (`w.Worktree`; empty = main), so the session, its
   process, and cwd live in the worktree the work is bound to.
3. Check if a session with the `sessionID` already exists. If not (fresh start):
4. Create a new chat session on the role's engine, set its title (best-effort).
5. Send `BuildKickoffMessage`. On failure, the session is cleaned up (deleted).

**Restart sequence** (session already exists, e.g. stopped work restarted):
1–3 same as above, but the existing session is detected, so:
4. Send `BuildRestartMessage` to the existing session instead of creating a new one.

### Role Engine to Session Engine

A session started for a work item takes its engine from the work's agent role
([engine fields](data-model.md#engine-fields)):

| Session field | Comes from |
|---|---|
| `agent_type` | `role.agent_type`, or the global default agent if the role set none |
| `model` / `effort` | `role.model` / `role.effort`, or the global defaults — see below |
| `mode` | `settings.DefaultMode` — always global, never the role |

Mode is the one launch-time setting a role does not carry — it stayed global
when the other three moved onto the role, so there is no `role.mode` to look
for.

The model and effort fall back to `settings.DefaultModel` / `DefaultEffort` field
by field: a role that names a model but no effort keeps its model and takes the
global effort. Two branches are easy to miss:

- **Only while the session stays on the global agent.** A role naming a
  *different* agent than the global default gets neither the global model nor the
  global effort — both were picked from the global agent's lists and mean nothing
  in another's, so its empties go to the CLI. This is all-or-nothing: it is the
  agent that decides, not whether the individual value happens to exist on both.
- **An unset `DefaultAgentType` counts as the built-in default agent**
  (`session.DefaultAgentType`) for that comparison, since that is the agent these
  sessions will actually run on. So a role that explicitly picks that agent
  inherits the global model from a user who never touched the agent setting — the
  two agree, whatever the stored strings look like. (The role's own empty agent
  type is never resolved this way; see [Engine
  Fields](data-model.md#engine-fields).)

`settings.Settings.ResolveEngine` is the single implementation of all of this.
`handleSessionCreate` hands it an empty role engine, so a session created by hand
is the case where Settings supplies every field, and the two kinds of session are
born the same way.

All four go to `SessionStore.Create` as a `CreateSpec`, which checks the model
and the effort against the agent type before the session exists. A rejection
therefore means no session was made at all, and the error has a path all the way
out: `WorkStarter` wraps it with the role's name and id — adding *"with the
global defaults applied"* when the engine did not come from the role alone —
`Operations.StartWork` rolls the claim back, and the ws and MCP callers surface
the text. That chain is what makes a retired model a reportable failure rather
than a silent one, and the wrapping names every place the value could have to be
fixed: pointing only at the role would send the user looking for a model that
lives in Settings.

**Only a fresh start reads the role.** The restart path leaves the existing
session's engine alone, so editing a role changes what the *next* session gets,
never a conversation already running; the chat's engine selector is what changes
an existing one.

> Source: `server/worktree/work_starter.go`.

## Prompt Builders

The prompt builders generate messages for different lifecycle events. All share a common base structure:

**Base (`buildBase`):**
- Agent role reference (instructs agent to fetch its role via `agent_role_get`)
- Work context (title, ID, instruction to read full details via `work_get`)
- What differs by work type, and only that:
  - **Story:** Coordinator rules — break the story into tasks, start them, do not implement anything yourself, do not call `step_done` on a child, read a child's report as a comment on the story.
  - **Task with parent:** Read the parent's comments before starting, and report results back with `work_comment_add`, because the story agent does not read this chat.
  - **Task without parent:** nothing extra.
- The lifecycle rules (`lifecycle_rules`), identical for every work Pockode
  drives: what the four statuses mean, that `question_post` is how the agent
  reaches a person and that it waits for nothing, that a story waits for its
  subtasks with `work_wait`, that a story shown one of its subtasks' questions
  may answer it with `question_answer` without its own wait being touched, that a
  turn ends cleanly with `step_done` or with
  something outstanding, that a turn ending with neither is nudged and stops the
  work after the allowance, and that a long wait belongs to `question_post` rather
  than to a chat question holding the process open. It is written once here so no send site
  can drift into its own version of the rules — see
  [work-system.md](../code/work-system.md#prompt-format).

### BuildKickoffMessage

Returns the base message. Used when a work item is first started (without steps).

### BuildKickoffMessageWithSteps

Base + step section if the agent role has steps. Format:
```
[Base message]

## Current Step
Step 1 of N

<step instructions>
```

Used when a work item's agent role has `steps` defined. Falls back to `BuildKickoffMessage` if no steps.

### BuildStrandedWaitMessage

Base + the news that the wait on children has nothing left that could end it,
and what became of the last child: deleted (create a replacement — there is no
id left), stopped (restart it by id), or never started (start it by id). The
wait is already cleared by the time this
arrives, and the message says so — the work has no wait now and is nudged as
usual. It never left `active`; a waiting work is active, which is what the
lifecycle section in the same message says.

### BuildChildQuestionMessage

Base + one question a subtask posted, quoted whole — header, question, options,
and the `request_id` that `question_answer` takes. It is quoted rather than
referenced because the story cannot fetch it: the question lives on the
subtask's *session*, not on its work item.

The story is offered the two ways forward — answer it, or ask the user itself —
and told which one is not on offer: guessing. The last line says the message
changed nothing else, because an agent handed something to do otherwise assumes
its wait is over, and this one clears no wait.

### BuildRestartMessage

Base + a restart nudge appropriate to the work type:
- **Story:** "Your story was stopped and is now being restarted. While a story is stopped Pockode sends it nothing…" — the story has to re-read `work_list` and `work_comment_list`, and its tasks' unanswered questions with `work_get`, because a stopped parent is never told that a child closed or that one asked something.
- **Task:** "Your task was stopped and is now being restarted. Review what you have done so far…"

### BuildAutoContinuationMessage

Base + a nudge appropriate to the work type, which names the three things the
engine was looking for and did not get:
- **Story:** "Your last turn ended without moving this story along: no step_done, no work_wait, and no question waiting for an answer…"
- **Task:** "Your last turn ended without moving this task along: no step_done, and no question waiting for an answer…"

### BuildAutoContinuationMessageWithSteps

For work items with steps, base + current step section + step completion check:
```
[Base message]

## Current Step
Step N of M

<step instructions>

That turn ended on step N of M without saying where the work stands.
Check if you have completed the current step:
- If YES: Call step_done with ID xxx to proceed to the next step or close the work.
- If NO and you are blocked on the user: Ask them with question_post, then carry on or end the turn.
- If NO and you are a story blocked on your subtasks: Call work_wait with ID xxx.
- If NO: Continue working on this step.
```

Falls back to `BuildAutoContinuationMessage` for stories or when no steps are defined.

### BuildStepAdvanceMessage

Used when a step advance is sent (`NotifyStepDone`). Format:
```
[Base message]

Step N-1 of M completed. Proceeding to the next step.

## Current Step
Step N of M

<step instructions>
```

> Source: `server/work/prompt.go`.

### System-Origin Tagging

Every builder's output reaches the agent through `chat.Client.SendSystemMessage` (not the user path), tagging the `message` event with `origin: "system"`, a per-builder `subtype`, and a `{work_id, work_type, title, step?, child?}` meta summary. The frontend renders each prompt as a one-line work event at the point in the transcript where it was sent, rather than as a user bubble; `work_id` is what its *Details* link opens. See [code/work-system.md](../code/work-system.md#work-messages-in-chat) for the subtype catalog and rendering flow.
