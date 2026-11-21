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
**permission reviewer session** instead of a person. Its launch arguments are
`yolo`'s on both agents
([agent-integration.md](code/agent-integration.md#session-modes)); Codex under
`yolo` raises nothing today, so there it behaves as `yolo`.

This document is the server's contract for the frontend, and the user-facing
account of what the mode does and does not promise. How the server implements
it is in
[agent-integration.md](code/agent-integration.md#answers-that-are-not-a-persons).

## The contract at a glance

| What | Where | Section |
|---|---|---|
| Mode id `unattended` | `session.set_mode`, `settings.update`'s `default_mode`, a session's `mode` | [The mode](#the-mode) |
| `permission_reviewer_of` | `SessionListItem`, `SessionDetail` | [The permission reviewer session](#the-permission-reviewer-session) |
| `data.reason: "permission_reviewer"` | `InvalidParams` from the RPCs a person cannot send to a reviewer | [The permission reviewer session](#the-permission-reviewer-session) |
| `exclude_permission_reviewer_sessions` | `session.list.subscribe`, `session_view.list` params | [The permission reviewer session](#the-permission-reviewer-session) |
| `permission_reviewer: {claude, codex}` | `settings.subscribe` / `settings.update` | [Settings](#settings) |
| `message` with `origin: "system"`, `subtype: "permission_review"` / `"permission_review_nudge"` | The reviewer session's history | [How a request is reviewed](#how-a-request-is-reviewed), [Every request gets an answer](#every-request-gets-an-answer) |
| `permission_response` with `by: "permission_reviewer"` or `by: "pockode"`, and `review` | The main session's history, broadcast (a reviewer's own request: the reviewer's) | [agent-event.md](agent-event.md#permission-requests-and-their-answers) |
| `warning` codes `permission_review_auto_denied`, `permission_review_failed` | The reviewer's / the main session's history | [Every request gets an answer](#every-request-gets-an-answer) |

## The mode

`unattended` is accepted wherever a mode is: `session.set_mode`,
`settings.update`'s `default_mode`, and a stored session's `mode`.

## The permission reviewer session

A real, visible Pockode session, one per main session, created on the main
session's first permission request and reused for later ones.

| Field | On | Meaning |
|---|---|---|
| `permission_reviewer_of` | `SessionListItem`, `SessionDetail` | The main session this session reviews for. Absent on every other session. Fixed at creation. |

- **Same agent as the main session.** Its model and effort come from the
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
    "claude": { "model": "haiku", "effort": "low" },
    "codex":  { "model": "", "effort": "" }
  }
}
```

Part of the object `settings.subscribe` returns and `settings.update` replaces.
Each agent's `model` and `effort` are validated against that agent's lists, as
`default_model` / `default_effort` are (`session.models`, `session.efforts`);
empty, or absent, lets the CLI decide. The values are read when a review is
sent, so a change applies from the next review on, existing reviewer sessions
included.

## How a request is reviewed

When a session in `unattended` raises a permission request, on either agent, the
server finds or creates the session's reviewer and sends it the request as a
system message (`origin: "system"`, `subtype: "permission_review"`) in the
reviewer's history. Meanwhile the request is recorded and broadcast in the main
session as usual, and a person may answer it with `chat.permission_response`.
**The first answer wins**: whichever comes second is dropped, and a person's
late answer gets the usual "no longer waiting" error.

The review message holds one JSON object, which is all the reviewer sees of
the main session. It never sees the main session's transcript.

| Key | Meaning |
|---|---|
| `request_id` | The review id Pockode minted for this request, which `permission_verdict` names. Not the CLI's own request id: that is unique only within the process that raised it (Codex's fallback `approval-<n>` restarts with every process), and a verdict must never reach a different request |
| `tool_name`, `tool_input` | The call, as the request carries it |
| `cwd` | The main session's working directory (its worktree) |
| `project_root` | The project's main directory |
| `decision_reason`, `blocked_path` | Claude's own account of why it asked, with ANSI escapes stripped. Absent when the CLI gives none, which is always the case for Codex |

The reviewer runs on the main session's agent, with the model and effort from
`permission_reviewer` settings as they are at the time of the review. A
reviewer whose process runs on other values is restarted with the new ones once
it is idle.

| | Claude | Codex |
|---|---|---|
| Tools | `permission_verdict` alone: no built-in tools, no MCP servers of the user's own, no skills. It runs without asking (`--allowedTools`) | `permission_verdict` alone from Pockode, which runs without asking (`default_tools_approval_mode = "approve"` on Pockode's server); Codex cannot drop its shell, so it runs in a `read-only` sandbox with `on-request` approval |
| Instructions | `agent.PermissionReviewerInstructions`, appended to the CLI's system prompt | The same text as the thread's developer instructions, without the user's own |

The main agent can write the project's instruction files, settings and hooks,
and a reviewer that read them could be steered by the very agent it is there to
catch. So a reviewer reads none of them. What it is told about — `cwd` and
`project_root` in the review message — is still the main session's.

| | Claude | Codex |
|---|---|---|
| Working directory | A directory of Pockode's own, outside every project: `pockode/permission-reviewer` under the OS user's configuration directory, beside `cli-profiles.json`. It is shared by every Pockode server of the user and stays empty. | The same |
| Project's instruction files | None: `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` drops every `CLAUDE.md` (the user's, the project's, any in a parent directory) | None: the working directory has no `AGENTS.md`, and `project_doc_max_bytes = 0` stops discovery even if that directory ended up inside a git repository |
| Project's settings and hooks | None: `--setting-sources user` drops project and local settings | None: a project's `.codex/` layer is read only in that project |
| User's settings | Kept, including `env` and `apiKeyHelper`, which some sign-ins need to reach the model at all | Kept (`config.toml`): auth and the provider live there |
| User's MCP servers | None (`--strict-mcp-config`) | Switched off one by one (`mcp_servers.<name>.enabled = false`, names from `config/read`); a reviewer whose config cannot be read is not started |

Checked against a local fake API (claude 2.1.325, codex-cli 0.169.0): neither
CLI's request carried a planted `CLAUDE.md` / `AGENTS.md` from the project or
from a parent directory, no project hook ran, and Pockode's tool was still
offered. What remains is under [Known accepted risks](#known-accepted-risks).

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
  for itself (a Codex reviewer's approval beyond its read-only sandbox, say) is
  denied by Pockode at once, without stopping its turn (`reviewer_request`), so
  it never holds the reviews queued behind it.

These denies never interrupt the turn: the agent is told
`Pockode denied this call: <reason>` and carries on (on Codex without the text,
as for a reviewer's deny). They are recorded as the `permission_response` with
`by: "pockode"` and `review: {session_id, automatic, reason}`, where `automatic`
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
  rewrite the call. On Codex the reason does not reach the model
  ([agent-integration.md](code/agent-integration.md#answers-that-are-not-a-persons)).
  There is no cap on repeated denials.
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
- On Codex a deny's reason never reaches the main agent, only the fact that the
  call was declined
  ([agent-integration.md](code/agent-integration.md#answers-that-are-not-a-persons));
  it is still on the record for the user.
- A reviewer still reads what the user configured for themselves, which a
  main agent with a shell outside the project (`yolo`, `unattended`) could
  rewrite:
  - Claude: the user's own settings, hooks and plugins included. They are kept
    because settings-based sign-ins (Bedrock, Vertex, a proxy, `apiKeyHelper`)
    would otherwise fail every review. The hooks have little to act on, since
    the reviewer's one tool is `permission_verdict`.
  - Codex: `CODEX_HOME/AGENTS.md`, which it reads whatever the working
    directory and has no setting to skip, and the user's own hooks and skills.
- `permission_verdict`'s check of who is calling rests on the MCP caller
  identity, which is self-reported
  ([agent-integration.md](code/agent-integration.md#mcp-caller-identity)). A
  main agent with a shell (`unattended` has one) could read the local API's
  token and a review id from the reviewer's history and give its own verdict.
  It gains little: that agent can already run whatever it likes without
  asking.
- Sign-in settings kept only in the project (a project `.claude/settings.json`
  `env` or `apiKeyHelper`, a project `.codex/config.toml` provider) do not reach
  a reviewer, since project settings are exactly what it is kept from. Its
  launch or turn then fails, and every request is denied with
  `reviewer_failed`: loud, not silent. Put such settings in the user's own
  configuration to use unattended mode.
