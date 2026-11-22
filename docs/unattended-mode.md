# Unattended Mode

Even in `yolo`, Claude Code still raises permission requests for some commands —
its own safety checks (a `rm` whose target comes from command substitution or a
possibly empty variable, targets that could expand to `/` or a top-level
directory, commands it cannot fully parse), protected paths — and
`bypassPermissions` cannot skip them. Each one blocks the session until a person
answers, and in practice people allow without reading. `unattended` is for
sessions nobody is watching.

**Unattended is more permissive than YOLO, not a restriction of it.** It is
`yolo`, plus every permission request `yolo` still raises answered by a
**permission reviewer session** instead of a person. That definition is the
same for every agent, and so are its launch arguments: `yolo`'s
([agent-integration.md](code/agent-integration.md#session-modes)).

Which agents need a reviewer follows from it. Claude under `yolo` still raises
the requests above, so Claude has one. Codex under `yolo` (`approvalPolicy:
never`) never raises a permission request, so there is nothing for a reviewer
to answer and Pockode has no reviewer logic for Codex
(`session.AgentType.HasPermissionReviewer`). The mode is still offered and
accepted for Codex sessions; they simply never reach a review. Should a Codex
session in `unattended` raise one anyway, it stays the person's, as under
`yolo`, and the server logs a warning. A Codex reviewer session an earlier
version created stays in the store as an ordinary reviewer row that nothing
routes to.

This document is the server's contract for the frontend, and the user-facing
account of what the mode does and does not promise. How the server implements
it is in
[agent-integration.md](code/agent-integration.md#answers-that-are-not-a-persons);
how the web app presents it is
[unattended-mode-ui.md](unattended-mode-ui.md).

## The contract at a glance

| What | Where | Section |
|---|---|---|
| Mode id `unattended` | `session.set_mode`, `settings.update`'s `default_mode`, a session's `mode` | [The mode](#the-mode) |
| `permission_reviewer_of` | `SessionListItem`, `SessionDetail` | [The permission reviewer session](#the-permission-reviewer-session) |
| `data.reason: "permission_reviewer"` | `InvalidParams` from the RPCs a person cannot send to a reviewer | [The permission reviewer session](#the-permission-reviewer-session) |
| `exclude_permission_reviewer_sessions` | `session.list.subscribe`, `session_view.list` params | [The permission reviewer session](#the-permission-reviewer-session) |
| `permission_reviewer: {claude}` | `settings.subscribe` / `settings.update` | [Settings](#settings) |
| `message` with `origin: "system"`, `subtype: "permission_review"` / `"permission_review_nudge"` | The reviewer session's history | [How a request is reviewed](#how-a-request-is-reviewed), [Every request gets an answer](#every-request-gets-an-answer) |
| `permission_response` with `by: "permission_reviewer"` or `by: "pockode"`, and `review` | The main session's history, broadcast (a reviewer's own request: the reviewer's) | [agent-event.md](agent-event.md#permission-requests-and-their-answers) |
| `warning` codes `permission_review_auto_denied`, `permission_review_failed` | The reviewer's / the main session's history | [Every request gets an answer](#every-request-gets-an-answer) |
| `reviewing: true` on a `permission` blocker of a turn, and the activity `reviewing_permission` | A session's `turn` (`SessionListItem`, `SessionDetail`, turn updates); a work row's `activity` | [A request under review](#a-request-under-review) |

## The mode

`unattended` is accepted wherever a mode is: `session.set_mode`,
`settings.update`'s `default_mode`, and a stored session's `mode`.

## The permission reviewer session

A real, visible Pockode session, one per main session, created on the main
session's first permission request and reused for later ones.

| Field | On | Meaning |
|---|---|---|
| `permission_reviewer_of` | `SessionListItem`, `SessionDetail` | The main session this session reviews for. Absent on every other session. Fixed at creation. |

- **Same agent as the main session**, so a Claude session: only Claude has a
  reviewer ([above](#unattended-mode)). Its model and effort come from the
  server settings below, not from the main session; the session's own `model`
  and `effort` are written from them each time a review is sent, so they show
  what its reviews run on now. Its stored `mode` is `default` and means nothing:
  a reviewer launches with its own fixed restrictions whatever the mode says
  ([How a request is reviewed](#how-a-request-is-reviewed)). Its title starts as
  `Permission reviewer`.
- **Deleted with its main session** (`session.delete`, and every other way a
  session is deleted). Deleting the reviewer alone is allowed; the next request
  creates a new one.
- **Read-only to a person.** `chat.message`, `chat.html_action`,
  `chat.permission_response`, `session.set_agent_type`, `session.set_mode`,
  `session.set_model`, `session.set_effort` and `session.set_html_first` are
  refused with `InvalidParams` and `data.reason: "permission_reviewer"`
  (`rpc.ChatReasonPermissionReviewer`); the message says why and where to go
  instead. Reading it, `session.update_title`, `chat.interrupt` and
  `session.delete` are allowed. Forking it is allowed too: the fork is an
  ordinary session (no `permission_reviewer_of`) holding a copy of the
  reviewer's transcript, and a person can type into it.
- **Hidden from the list on request.** `session.list.subscribe` and
  `session_view.list` take `exclude_permission_reviewer_sessions`, the same way
  they take `exclude_work_sessions`: the snapshot, the pages, every notification
  and `has_unread` are all narrowed by it. Absent sends everything.

Server side, `session.Store.EnsurePermissionReviewer` finds or creates a main
session's reviewer in one step, `session.FindPermissionReviewer` only looks,
and `worktree.Worktree.DeleteSession` is the deletion that stops the reviewer's
process along with the main session's.

## Settings

```json
{
  "permission_reviewer": {
    "claude": { "model": "haiku", "effort": "low" }
  }
}
```

Part of the object `settings.subscribe` returns and `settings.update` replaces.
There is one key per agent that has a reviewer, so only `claude`. Its `model`
and `effort` are validated against Claude's lists, as `default_model` /
`default_effort` are (`session.models`, `session.efforts`); empty, or absent,
lets the CLI decide. A `codex` key, which an earlier version had, is ignored
rather than refused, in `settings.update` and in a stored settings file alike,
and is dropped on the next save. The values are read when a review is
sent, so a change applies from the next review on, existing reviewer sessions
included.

## How a request is reviewed

When a Claude session in `unattended` raises a permission request, the server
finds or creates the session's reviewer and sends it the request as a system
message (`origin: "system"`, `subtype: "permission_review"`) in the
reviewer's history. Meanwhile the request is recorded and broadcast in the main
session as usual, and a person may answer it with `chat.permission_response`.
**The first answer wins**: whichever comes second is dropped, and a person's
late answer gets the usual "no longer waiting" error.

The review message holds one JSON object, which is all the reviewer sees of
the main session. It never sees the main session's transcript.

| Key | Meaning |
|---|---|
| `request_id` | The review id Pockode minted for this request, which `permission_verdict` names. Not the CLI's own request id: that is unique only within the process that raised it, and a verdict must never reach a different request |
| `tool_name`, `tool_input` | The call, as the request carries it |
| `cwd` | The main session's working directory (its worktree) |
| `project_root` | The project's main directory |
| `decision_reason`, `blocked_path` | Claude's own account of why it asked, with ANSI escapes stripped. Absent when the CLI gives none |

The reviewer runs on the main session's agent, with the model and effort from
`permission_reviewer` settings as they are at the time of the review. A
reviewer whose process runs on other values is restarted with the new ones once
it is idle.

| What | The reviewer's |
|---|---|
| Tools | `permission_verdict` alone: no built-in tools (`--tools ""`), no MCP server but Pockode's (`--strict-mcp-config`, so neither the user's nor the project's `.mcp.json`), no skills (`--disable-slash-commands`). It runs without asking (`--allowedTools`) |
| Instructions | `agent.PermissionReviewerInstructions`, appended to the CLI's system prompt |
| Working directory | The main session's worktree, the same directory the main session runs in |
| Settings | Every source loads, as for any session there: the user's, the project's `.claude/settings.json` and `.claude/settings.local.json`. So the reviewer reaches the model exactly as the main session does, whichever of them holds the sign-in (`env`, `apiKeyHelper` — Bedrock, Vertex, a proxy) |
| Instruction files | None. `--settings` points at a file of the reviewer's own (`reviewer-settings.json` in its session directory) setting `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`, which drops every `CLAUDE.md` — the user's, the project's with what it imports, `CLAUDE.local.md`, `.claude/rules`, any in a parent directory — and the project's auto memory (`MEMORY.md`), which the reviewer would otherwise share with the main session, since both run in the same directory |

The main agent can write the project's instruction files, and a reviewer that
read them could be steered by the very agent it is there to catch; the reviewer
judges from the request alone and needs none of them. The variable is set
through `--settings` rather than the process environment because a settings
`env` outranks the process's: a project `.claude/settings.json` setting it to
`0` would otherwise turn the files back on. Flag settings outrank the user's,
the project's and local settings; only managed policy is above them. What the
reviewer still takes from the project — its settings and hooks — is under
[Known accepted risks](#known-accepted-risks).

Checked against a local fake API (claude 2.1.325) with the reviewer's exact
flags, in a project with a `CLAUDE.md` importing `AGENTS.md`, a
`CLAUDE.local.md`, `.claude/rules`, and settings holding the sign-in `env`, a
hook and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=0` (the process environment set to `0`
too): the request went to the project's endpoint, the hook ran, Pockode's tool
and the appended instructions were offered, and none of the instruction files
reached the request. The project's auto memory stayed out too, even with the
project's settings turning it on (`autoMemoryEnabled`,
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`), while a plain launch there read it.

### A request under review

A request the reviewer is answering is not waiting on a person, and the
session's turn says so: its blocker carries `reviewing: true`.

```json
"turn": {
  "phase": "blocked",
  "open": true,
  "blockers": [
    { "kind": "permission", "request_id": "toolu_01…", "raised_at": "…", "reviewing": true }
  ],
  "since": "…"
}
```

- **Set** as the request is raised, when routing reads the session and finds
  it `unattended` — the blocker never exists without it, so no surface calls
  the person even for the seconds it takes to find, create or start the
  reviewer. From then on every path answers the request (the reviewer's
  verdict or Pockode's deny, [below](#every-request-gets-an-answer)) or ends
  with its process, so the mark is never cleared: the blocker goes away with
  the answer.
- **Never set** on a request routing gives back to the person: when Pockode
  cannot read the session it records `permission_review_failed` with
  "… Answer it yourself." and leaves the request unmarked. Nor on a request of
  a reviewer's own, which is denied at once.
- **Absent** means `false`, and is what every other request reads.
- A person may still answer a request under review; the first answer wins.

What reads it: a work's `activity` is `reviewing_permission` while every
permission request of its turn is under review — a request waiting on a person
outranks it, and it outranks `background` — and that leaf is not one the
person is needed for (`work.Activity.NeedsUser`), so the work is not counted
under *Needs you*. A session row derives the same leaf from the same
`work/testdata/activity_cases.json`. Nor does a request under review mark the
session unread: raising one that waits on a person does, as in any mode, and
so does one routing hands back — the point of the mode is that nobody is
called for the rest. The session goes unread as any session does, when its
turn ends. The send path still refuses a message
while a request is pending (`chat.ErrTurnAwaitingAnswer`), reviewed or not:
the CLI would not read it.

## Every request gets an answer

A request routed to a reviewer is answered, by the reviewer or, failing that,
by Pockode itself — never left waiting for a person nobody told.

- **Nudges.** When a reviewer's turn ends (settled, as for the work engine's
  nudges) with requests it has not answered, Pockode sends it a system message
  (`subtype: "permission_review_nudge"`) listing them by review id. At most
  `MaxNudges` = 3 in a row; any verdict resets the count. The next ending after
  the third nudge denies what is still open (`no_verdict`).
- **Timeout.** No verdict 5 minutes after the request arrived denies it
  (`timeout`).
- **Failure.** A request that cannot be routed (the reviewer cannot be created,
  its agent no longer matches the main session's, it cannot be started or sent
  the request), a reviewer turn that fails, is stopped or cannot sign in, and a
  reviewer session deleted while it holds requests all deny them at once
  (`reviewer_failed`). A deleted reviewer's requests are not re-sent to a new
  one: the main agent learns why, and a retry is routed afresh. Server shutdown
  denies nothing; the requests end with their processes.
- **The reviewer's own requests.** Anything a reviewer session asks permission
  for itself is denied by Pockode at once, without stopping its turn
  (`reviewer_request`), so it never holds the reviews queued behind it.

These denies never interrupt the turn: the agent is told
`Pockode denied this call: <reason>` and carries on. They are recorded as the
`permission_response` with `by: "pockode"` and `review: {session_id, automatic, reason}`, where `automatic`
is one of the kinds above ([agent-event.md](agent-event.md#permission-requests-and-their-answers)).
For `timeout`, `no_verdict` and the failures after routing, the reviewer
session also gets a `warning` record (code `permission_review_auto_denied`)
naming the request, so its own chat shows why it was answered without it. If
the deny itself cannot be delivered (the CLI is on its way out), the main
session gets a `warning` with code `permission_review_failed`.

A reviewer turn ending only counts against the requests it was actually sent:
one still being delivered (the reviewer starting up, say) is neither nudged
about nor denied for it. A reviewer briefly held by a request of its own — the
moment before Pockode's deny of it lands — refuses messages, so a review
message that meets it is offered again until it goes through; the timeout bounds
the wait.

A person may still answer while a review is in flight. The first answer wins,
and a person's answer clears the request's timeout and takes it off the list the
reviewer is nudged about.

## The `permission_verdict` tool

```
permission_verdict(request_id, verdict, category?, reason?)
```

- **Only reviewers see it.** It is offered to permission reviewer sessions alone,
  and they are offered no other Pockode tool. It answers only requests that were
  sent to the calling reviewer. Any other `request_id` is refused, and so is a
  call from any session that is not a reviewer.
- **`verdict: "allow"`** approves that one request. It is never "always allow"
  and saves no permission rule. `category` is ignored.
- **`verdict: "deny"`** requires `category` to be one of `system_damage`,
  `prompt_injection` or `system_reach_unverifiable`. Anything else is refused,
  nothing is sent, and the reviewer has to resubmit. The deny does not interrupt
  the main session's turn. The main agent is told
  `Pockode's permission reviewer denied this call (<category>). <reason>` and may
  rewrite the call. There is no cap on repeated denials.
- **A request that is no longer pending** (a person answered it, Pockode denied
  it, it expired, the process ended) is not an error. The tool says so, and the verdict is dropped.
- Each result ends with the requests that are still waiting for this
  reviewer's verdict.

The answer lands in the main session's history as the `permission_response`
record, with `by: "permission_reviewer"` and `review: {session_id, category,
reason}` ([agent-event.md](agent-event.md#permission-requests-and-their-answers)).
Unlike a person's answer, it is also broadcast.

## Known accepted risks

- Deny-and-retry loops have no cap and may keep spending tokens: each rewritten
  call that still trips a check is a new request and a new review, on both
  sessions' bill.
- A reused reviewer session accumulates earlier requests in its context, so
  each review costs more than the last, and an earlier request (a
  prompt-injected one included) can colour a later verdict. Deleting the
  reviewer starts the next request on a fresh one.
- A reviewer loads the project's settings, which the main agent could have
  written, and so runs the project's hooks as well as the user's, and takes the
  project's `env`, `outputStyle` and the like. A hook's output (a
  `UserPromptSubmit` hook's, say) can add context to a review. This is accepted
  because the sign-in may live only in the project's settings, and dropping
  them would fail every review there; and because adding a hook means writing
  the project's `.claude` settings, a protected-path write that raises a
  permission request even under `yolo` — one this reviewer reviews.
  The hooks have little to act on, since the reviewer's one tool is
  `permission_verdict`. A main agent with a shell outside the project could
  likewise rewrite the user's own settings, hooks and plugins, which a reviewer
  reads as every session does.
- `permission_verdict`'s check of who is calling rests on the MCP caller
  identity, which is self-reported
  ([agent-integration.md](code/agent-integration.md#mcp-caller-identity)). A
  main agent with a shell (`unattended` has one) could read the local API's
  token and a review id from the reviewer's history and give its own verdict.
  It gains little: that agent can already run whatever it likes without
  asking.
