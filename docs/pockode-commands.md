# Pockode Commands

A Pockode command is a slash command that Pockode handles itself. The server
catches it before the agent sees anything, expands it into a fixed prompt, and
sends that prompt in its place. The first one is `/pockode-lead [instructions]`:
once the user and the agent have agreed in a chat on what to build, it hands
that agent the lead, and the agent drives the work through Pockode stories.

Commands exist because users kept sending the same instructions by hand — how to
split work into stories, how to start them, what to leave alone — and a prompt
typed from memory drifts each time. A template that Pockode maintains is the
same every time, and it means the same thing to every agent: it is only a prompt,
so Claude and Codex both read it.

## The prefix is Pockode's

Every message that starts with `/pockode-` belongs to Pockode. A name Pockode
knows is expanded. Any other name is refused with the list of available
commands. Neither kind is ever passed to the agent as typed. Owning the whole
prefix buys two things:

- A typo such as `/pockode-laed` cannot reach the agent as a prompt, where the
  agent would try to guess what it meant.
- A user's own command cannot hide one that Pockode adds later, because no name
  under the prefix was ever the user's to take.

There is deliberately no short alias like `/p-lead`. A prefix that short would
collide with commands users write for themselves.

Only a message that *starts* with the prefix counts. The name runs up to the
first whitespace. Everything after it, trimmed, is the arguments, which may
span several lines. Whitespace means the same characters on both sides — Go's
`unicode.IsSpace` — which is why the client does not use JavaScript's `\s`:
the two disagree on U+0085 and U+FEFF.

## Where it is caught

The command is caught on the server, in the `chat.message` handler
(`server/ws/rpc_chat.go`), not in the client:

- Expansion needs server-side context. `/pockode-lead` reads the current branch
  of the worktree the session runs in.
- Every client, and the agent, sees the same behaviour. A client too old to know
  about commands still sends `/pockode-lead` as text, and the server still
  expands it.

Expansion runs before anything is sent. A command that cannot be expanded
therefore leaves no trace: nothing is written to history, nothing reaches the
agent, no question is resolved, and the command palette does not record it as
used.

A command only produces a prompt. It never acts on the server. When a command
needs something done, the prompt tells the agent to do it through MCP. This
keeps a command's meaning the same for every agent, and keeps anything the
agent does on the ordinary, visible path.

## What is recorded

A command message is still **the user's message**. Its `origin` is the user's
(empty), not `system`, so it can be forked, and the work engine takes it as a
user message (`HandleUserMessage`) like any other. See
[agent-event.md](agent-event.md#message-origin-user-vs-system).

The `message` record carries two facts about the moment the command was sent:

| Field | Holds |
|---|---|
| `content` | The expanded prompt — exactly what the agent read |
| `command` | `{ "name": "pockode-lead", "args": "..." }` — what the user typed. `name` has no slash, and `args` is left out when nothing followed the name |

Neither field is state. The prompt is stored in full, not rebuilt from the
template when needed, because the template may have changed since. The record
says what the agent was sent then, not what the command would expand to now
(AGENTS.md, *Events are events, state is state*).

The sender is left out of the broadcast, so it learns both fields from the reply
to its own `chat.message` call: `rpc.MessageResult` carries `content` and
`command` beside `seq`; `command` only for a command message, `content` also for
a message carrying answers
([code/websocket-rpc.md](code/websocket-rpc.md#growing-a-reply)).

## How it is drawn

A command message is not drawn as a bubble. It is one collapsible line, in the
same row structure as a tool call (`PockodeCommandItem` in
`web/src/components/Chat/MessageItem.tsx`, built on `ToolRow`):

- **Collapsed** — the command and its arguments: `/pockode-lead  backend first…`.
  It starts collapsed. The template is the same every time; what a reader wants
  to know is which command was sent and what the user added.
- **Expanded** — *Sent to the agent*, followed by the prompt as plain text. It is
  not rendered as Markdown, which would change how it looks: this is the text
  the agent read.

A command message has no status and no chip, because it is an event that has
already happened. It keeps the message-action slot like the other full-width
lines (a work event, an agent's answer), so the row ends where the bubbles do
([session-fork-ui.md](session-fork-ui.md#which-rows-reserve-a-slot)).

**The local echo is the line from the first frame.** `sendUserMessage` parses
the text with `parsePockodeCommand`. When the text is a command, the echo
carries `command`, and its `content` stays empty until the reply arrives. The
reply then writes the server's `content` and `command` over the echo, together
with `seq`, in a single state update. The server's parse wins over the
client's. The client parses only so that the echo is not first drawn as a bubble
and then redrawn as a line. Until the reply comes, and permanently if the send
fails without one, the expanded body says *Not received from the server.*

What goes back when the user reuses the message is what they typed, never the
expanded prompt:

- The draft a fork hands back is `/name args`. Resending the prompt itself would
  skip the command.
- The fork sheet quotes `/name args`, because the prompt opens the same way every
  time and would not identify the message.

Both go through `formatPockodeCommand` (`web/src/utils/pockodeCommand.ts`).

## The command palette

`command.list` returns Pockode commands beside the CLI's builtins and the user's
custom commands. Each entry has `isBuiltin` and `isPockode`, and at most one of
them is true — neither means a custom command. Pockode commands also carry a
one-line `description`. The palette shows a `Pockode` chip and the description
on a second line. Custom commands keep their `(custom)` mark, and builtins look
as they always did.

Order (`command.Store.List`):

1. Recently used commands of every kind, newest first
2. Pockode commands not yet used
3. Builtins not yet used

A recently used name under the prefix that is no longer a Pockode command — one
sent before the prefix was reserved, or a command since removed — is left out.
So is a command that needs git, recently used or not, in a project that is not a
git repository ([below](#when-the-server-refuses)). Offering either would only
lead to an error. Because the list now depends on whether the project is a
repository, the client drops its cached copy when that answer changes
([frontend-state.md](code/frontend-state.md#store-patterns)); otherwise a
`git init` would leave `/pockode-lead` missing from the palette until the next
send.

Recording happens **only after the message has reached the agent**, for every
slash command. A command that was refused, or a send that failed because the
session was gone or the turn was waiting on a request, was not used, and would
otherwise rise to the top of the palette. The client's cached `command.list` is
dropped at the same point — when the send is accepted, not when Send is pressed
— so a list fetched while the send is still in flight is not kept.

## When the server refuses

The command's own refusals are `-32602` (`CodeInvalidParams`), and each message
is written to be shown to the user as-is:

| Case | Message |
|---|---|
| Unknown name | `Unknown Pockode command "/pockode-foo". Available: /pockode-lead` — only the commands the project could run, as the palette lists them; with none, the `Available:` part is left off |
| A command that needs a branch, in a worktree whose HEAD is detached | `/pockode-lead needs the current branch, but HEAD is detached. Check out a branch and send it again.` |
| A command that needs git, in a project that is not a git repository | ``/pockode-lead needs a git repository. Ask the AI to run `git init`, then send it again.`` |
| Sent together with `answering` | `Answers are sent on their own: the message the agent reads is written from them. Send the answers first, then the rest as a message of its own. If you did not type anything beside them, reload the page — this client is out of date.` |

The server refuses a command sent with `answering` because it refuses any
content beside answers: the message the agent reads is written by the server
from the answers, so the content has nowhere to go, and which of the two the
user meant is not the server's to guess. The web client cannot produce this
case — the answer panel sends empty content — so the check protects the server
from other clients and from a stale page.

Whether the project is a repository is the worktree registry's answer, the
same one the client hides its git UI on ([git.md](git.md#projects-without-a-repository)),
so "git is missing" lands in that refusal too: the registry counts a git that
cannot run as no repository. The palette leaves such a command out, so the
refusal is what answers one typed by hand or resent from a draft. A branch
that still cannot be read in a project the registry calls a repository — the
registry's answer is up to 3 seconds old — is a system error, not a user error.
It is answered as `-32603` with the cause, and logged
([code/websocket-rpc.md](code/websocket-rpc.md#error-replies)).

An expanded command can still be refused by the send itself, like any message:
no such session, a turn holding a permission request open, and the rest of the
client errors `replyErrorForChat` maps. Those are `-32602` too, and they too
mean that nothing reached the agent.

On the client, **only a `-32602` refusal takes the echo back**
(`isInvalidParamsRejection`), whichever of the two produced it. The echo and
its reply placeholder are removed, `sendUserMessage` throws, and
`ChatPanel.handleSend`:

- puts what was typed back into the input of the session it was sent from,
  unless the user has already started typing something new there;
- shows the server's reason in `ComposerErrorBar`, above the composer, and only
  while that same session is on screen. A refusal that arrives after the user
  has switched sessions is not shown in the wrong conversation;
- does not use a refused command to name a new session. Only a command the
  server accepted becomes the title, so a typo is not left behind as one.

Any other failure — a timeout, a dropped connection — takes the ordinary path.
The line stays, and the placeholder under it says the send failed. In that case
the server may already have given the command to the agent, and handing the
draft back would invite running `/pockode-lead` twice.

## `/pockode-lead`

The template is `pockode_lead_command` in `server/work/prompts.yaml`, rendered
by `work.BuildPockodeLeadPrompt(branch, args)`. It lives with the work prompts
because it is one: it tells an agent how to drive work through Pockode, and its
rules have to stay in step with those the engine gives the stories it starts.
It is fixed in code for now. Users cannot edit it.

What the agent is told, in short: split the agreed work into stories sized as
single units; create each with a role; start each with `story_start`, with
`watch` set and a new worktree; leave the stories' tasks alone; do not edit or
comment on a story once it has started; answer a story's questions when the
discussion or the project settles them, and otherwise leave them, since the
user is already being asked; merge each closed story into the branch; report
when all are merged. The template itself is the source of truth, and this
summary does not replace it.

- **The branch is injected at expansion time.** `{{.Branch}}` is the branch the
  invoking session's worktree is on, read with `git.CurrentBranch`. This works
  even before the branch's first commit, because it reads nothing but HEAD. Its
  only use is as the target finished stories are merged into, so without a
  branch there is no prompt worth sending, and the command is refused.
- **Arguments are appended as data.** When there are arguments, the prompt ends
  with `Additional instructions from the user:` followed by the arguments as
  parsed — trimmed, otherwise untouched. They are inserted as a value, never
  parsed as template, so `{{…}}` in them stays literal.
- **Rule 5 is temporary.** A running story is not told when its title or body
  changes or a comment is added, so the rule forbids doing either. A TODO next
  to the template says to remove it once a running story is notified of such
  changes.

### Known limitation: the rules live only in the lead's context

The lead's rules are in one message only: the expanded `/pockode-lead` prompt.
The messages that wake the lead later — a watched story closed, stopped, or
asked a question (the `watched_story_*` subtypes, see
[code/work-system.md](code/work-system.md#a-storys-watcher)) — say what
happened and how to act on that one event. They do not repeat the lead's rules.

So a lead that loses its context forgets how to lead. This happens when the
conversation is compacted, or when the session could not be resumed and a new
one was started in its place. It may then merge without judgement, re-review
work in detail, or start implementing the rest itself.

**The workaround is for the user to send `/pockode-lead` again** in the same
chat. The rules come back, and the discussion still in context — or restated in
the arguments — says what is left to do. This is accepted for now and not
handled in code.

## Adding a command

1. Add an entry to `PockodeCommands` in `server/command/pockode.go`: the name
   (with the `pockode-` prefix, without the slash), a one-line English
   description for the palette, and an `expand` function. Set `needsGit` if the
   command means nothing outside a git repository: the palette then leaves it
   out there, and `ExpandPockode` refuses it before `expand` runs, so `expand`
   never has to check.
2. `expand` receives `PockodeEnv` (what it may read about where it was invoked,
   today the worktree directory and whether the project is a git repository)
   and the arguments, and returns the prompt. A failure that is the user's to
   fix is returned as a `refusal` worded for them, wrapping a sentinel of its
   own (`ErrNoBranch`, `ErrNotGitRepo`, …) for tests and callers to tell kinds
   apart. The handler asks only `IsRefusal`, which makes any `refusal` a
   `-32602`, so a new kind needs no change there. Any other error is treated as
   a system error.
3. Put the template in `server/work/prompts.yaml` when it is about driving work,
   with its field in `promptTemplates` and a builder in `server/work/prompt.go`
   (a key with no field loads as an empty template), and add it to the
   [template keys](code/work-system.md#template-keys). A template about
   something else belongs with whatever it describes.
4. Nothing on the client changes. The palette, the line in the transcript and
   the local echo all work from `command.list`, the prefix and the record's
   `command` field, not from a list of names. The client never lists
   the commands. It learns them from `command.list`.

The prefix is defined once on each side — `PockodePrefix` in
`server/command/pockode.go`, `POCKODE_COMMAND_PREFIX` in
`web/src/utils/pockodeCommand.ts` — and each names the other.

## Where it lives

| Concern | Path |
|---|---|
| Registry, parsing, expansion | `server/command/pockode.go` |
| Palette order and recording | `server/command/store.go`, `server/ws/rpc_chat.go` (`recordCommandIfSlash`) |
| Catching, refusing, replying | `server/ws/rpc_chat.go` (`handleMessage`) |
| Sending with the record field | `server/chat/client.go` (`SendCommandExcluding`) |
| Record and reply fields | `server/agent/event.go` (`CommandInvocation`), `server/rpc/types.go` (`MessageResult`) |
| Branch reading | `server/git/branch.go` (`CurrentBranch`) |
| Template | `server/work/prompts.yaml` (`pockode_lead_command`), `server/work/prompt.go` |
| Client prefix and parsing | `web/src/utils/pockodeCommand.ts` |
| Echo, reply, take-back | `web/src/hooks/useChatMessages.ts`, `web/src/lib/rpc/chat.ts` |
| Refusal UI | `web/src/components/Chat/ChatPanel.tsx` (`ComposerErrorBar`) |
| Transcript line | `web/src/components/Chat/MessageItem.tsx` (`PockodeCommandItem`) |
| Palette | `web/src/components/Chat/CommandPalette.tsx` |
