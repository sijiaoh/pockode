# Agent Chat

Users interact with AI agents through natural language conversations. The system manages bidirectional communication with persistent agent processes (Claude CLI, Codex CLI) via WebSocket JSON-RPC.

## Architecture

```
React SPA ──WebSocket──▶ Go Server ──spawn──▶ AI CLI (subprocess)
                              │                     │
                         ChatClient            stream-json
                              │                     │
                         ProcessManager ◀───── AgentSession
```

- **ChatClient** (`server/chat/`) — Coordinates session/process management, persists messages to history, broadcasts events to all WebSocket subscribers.
- **ProcessManager** (`server/process/`) — Manages agent process lifecycle. Tracks state (`idle` / `running` / `ended`), runs idle timeout reaper.
- **Agent Session** (`server/agent/`) — Common `Session` interface implemented by each backend (`agent/claude/`, `agent/codex/`). Handles subprocess spawning, stream-json parsing, stdin messaging.

## Key Files

| Layer | Path | Role |
|-------|------|------|
| RPC handlers | `server/ws/rpc_chat.go` | `chat.message`, `chat.interrupt`, `chat.messages.subscribe` / `chat.messages.history` ([paging](#history-paging)), permission/question responses |
| Session config | `server/ws/rpc_session.go` | `session.set_agent_type` / `set_mode` / `set_model` / `set_effort`, each closing the running process because a CLI is told these only at launch; `session.models` and `session.efforts` list the choices ([models](code/agent-integration.md#session-models), [effort](code/agent-integration.md#session-effort)) |
| Chat client | `server/chat/client.go` | Session coordination, message persistence, event broadcast; `SendMessageExcluding` (user) and `SendSystemMessage` (system automation) share one persist+broadcast path |
| Agent interface | `server/agent/agent.go` | `Session` and `AgentEvent` interfaces |
| Claude impl | `server/agent/claude/claude.go` | Claude CLI subprocess, stream-json parsing, MCP server config |
| Process manager | `server/process/manager.go` | Process lifecycle, state machine, idle reaper |
| Frontend panel | `web/src/components/Chat/ChatPanel.tsx` | Message list, input bar, engine (agent + model + effort) and mode selectors |
| Chat hook | `web/src/hooks/useChatMessages.ts` | Message state, streaming, permission/question handling |
| RPC actions | `web/src/lib/rpc/chat.ts` | `sendMessage`, `interrupt`, `permissionResponse`, `questionResponse` |

## Data Flow

1. User sends message → `chat.message` RPC
2. ChatClient persists message to session history, forwards to `Process.SendMessage()`
3. Agent subprocess receives via stdin, processes, emits stream-json events
4. Events are parsed into typed `AgentEvent`s (Text, ToolCall, ToolResult, Error, PermissionRequest, AskUserQuestion, Done, etc.)
5. Events are broadcast to all WebSocket subscribers and persisted to session history
6. On `Done` event, process transitions to `idle`

Besides user-typed messages, the Work system pushes automatic prompts to the same session via `Client.SendSystemMessage`; these are tagged `origin: "system"` with a `meta` summary naming the work, so the frontend can render each as a one-line work event where it happened instead of as a user bubble. See [agent-event.md](agent-event.md#message-origin-user-vs-system) and [code/work-system.md](code/work-system.md#work-messages-in-chat).

## Agent Events

See [agent-event.md](agent-event.md) for the full event type catalog, data flow, and frontend processing pipeline.

An `AskUserQuestion` blocks the agent until it is answered, yet its card is easily pushed out of view by whatever the agent streams next. How chat keeps an unanswered question reachable is in [pending-question-entry.md](pending-question-entry.md).

## History Paging

Opening a session does not ship its whole transcript. `chat.messages.subscribe`
replies with the newest page of history and a cursor; scrolling up fetches the
pages before it with `chat.messages.history`. A long conversation is mostly tool
calls and their results, and a client only ever renders the tail of it — sending
the rest costs transport, parsing and memory for records nobody looks at.

| Method | Params | Result |
|--------|--------|--------|
| `chat.messages.subscribe` | `session_id`, `limit?` | `id`, `history`, `has_more`, `next_before_seq?`, `state`, `mode`, `agent_type`, `model`, `effort` |
| `chat.messages.history` | `session_id`, `before_seq?`, `limit?` | `history`, `has_more`, `next_before_seq?` |

- `history` is the page, **oldest record first**, each record stamped with its
  `seq` — its address in the session's history ([`session.HistorySeq`](../server/session/types.go)).
- `before_seq` is **exclusive**: the reply holds the records immediately older
  than the record it names. Omitted (or `0`) asks for the newest page.
- `has_more` says whether anything older than `history[0]` exists; `next_before_seq`
  is the cursor for that page and is absent once `has_more` is false. The server
  computes the cursor rather than letting the client read `history[0].seq`,
  because a record it could not stamp — one that is not a JSON object — carries
  no `seq` at all and would strand paging at that point.
- `limit` of `0` means `session.DefaultHistoryPageSize` (50); anything above
  `session.MaxHistoryPageSize` (500) is clamped. A negative `limit` and a
  `before_seq` naming no record are both refused with an invalid-params error —
  answering an unusable cursor with the newest page would silently restart the
  client's scrollback from the bottom.

`chat.messages.history` needs no subscription and cannot collide with one. An
older page is settled history: append-only, so it can never change, and every
record a live notification carries is newer than the page subscribing returned.
A client scrolled up therefore keeps paging with the cursor it already holds
while new records stream in below.

### Reading a page on the client

A page is a slice of the record stream, not a slice of the conversation. The
reducer's rules assume it can see the whole stream, and two of those assumptions
stop holding when it can only see a page. Both are repaired in `prependHistoryPage`
([`messageReducer`](../web/src/lib/messageReducer.ts)), where the rest of the
record-to-message rules already live — not in the list component, which would
otherwise have to know what a record means.

**A page does not know what happened after it.** A tool call whose result is one
page newer replays as still running; a question answered later replays as still
waiting. The client keeps every record that settles something recorded earlier —
tool results, permission and question responses, cancellations, process ends —
and replays them over each older page it pulls in. They are all "update it
wherever it is" operations, so replaying them costs nothing when the target is
not in that page either.

Order matters inside that repair: the page's trailing turn is closed *first*.
The records that ended it are in the page above, so left as it replayed it would
keep a spinner running in the middle of the transcript — and with nothing left
streaming, a later `process_ended` retires only the dialogs and Tasks this page
left open instead of also stamping its status onto a turn that was still running
at this point. A process killed by a restart writes no `process_ended` at all;
that the process is gone is passed in separately, so every page is retired the
same way the newest one already is.

The mirror of this is one record the page above has to hand *down*. A record
that only ends a turn — `done`, `error`, `interrupted`, `process_ended` — has
nothing to end when it opens a page, so replaying that page alone learns nothing
from it; the turn it ended is the one the page below trails off on. It is
therefore held as that page's *boundary terminal* and replayed against it, with
its `seq`, before the turn is closed. Without this an interrupted or failed turn
reappears as an ordinary finished one on the way back up — with its error text
gone and any Task it was running still spinning. Output that trails such a turn
cannot reopen it, at a page seam for the same reason it cannot in one stream.

**A page boundary can fall inside one turn.** The older page trails off
mid-answer and the page above opens on content that no `message` event preceded;
the reducer produces a leading assistant message in that one case only, which is
what makes joining the two halves safe. Text at the seam goes through the same
rule streaming uses, so a sentence — or a fenced code block — cut in two comes
back as one part.

A turn is the *only* thing a boundary can split. Nothing else in the transcript
spans more than one record: a Claude Task is one part where its call landed
([code/frontend-state.md](code/frontend-state.md#task-parts)) and a work event is
one message where it happened
([code/work-system.md](code/work-system.md#rendering-in-the-transcript)), so
neither can arrive as two halves needing to be folded back together. That is not
an accident of how they happen to be rendered, it is a reason for rendering them
that way: anything aggregated across records has to be found and re-anchored at
every seam, and an event left where it landed never does.

Reconnecting re-subscribes and so lands back on the newest page: pages already
scrolled in are dropped rather than stitched back together, since the cursor
chain would have to be replayed from the bottom anyway.

Scroll position is held by pinning to the message that was at the top when the
page was asked for, not by comparing scroll heights before and after — the agent
can go on writing at the bottom while the page is in flight, and that growth is
indistinguishable from the growth above that has to be compensated for.

A page that fails replaces the sentinel with the reason and a Retry button, so
nothing is left to ask for the next page until the user presses it. Saying nothing would
read as *this is where the conversation starts* — the one conclusion a failure
must not let the user draw — and retrying on a sentinel that has not moved would
loop out of sight. "Beginning of conversation" is therefore said only on the
server's word that nothing older exists, and only to a user who has actually
scrolled back far enough to wonder.

Whatever has been paged in stays rendered: `MessageList` does not virtualize,
and a collapsible body it has opened once stays mounted so that reopening is
free (`web/src/components/ui/CollapsibleBody.tsx`). Scrolling back therefore
grows the DOM for as long as the session stays open. That is the trade the
cursor makes affordable — growth happens one page at a time and only because the
user asked for it, where replaying the whole transcript on open imposed it on
every session — and a reconnect starts over from the newest page.

## Session Persistence

Session metadata and chat history are stored under the session data directory. History is JSON Lines of `EventRecord`s appended on each event. Claude records its provider-side session ID in `claude_resume.json` as soon as the CLI reports it, and falls back through a recovery ladder (plain resume → fork → new session) when a launch turns out to be unresumable, so a session cannot be permanently stuck by a first turn that failed ([code/agent-integration.md](code/agent-integration.md#session-recovery-ladder)). Codex never resumes — its CLI keeps a thread only in the memory of the process that created it, so a restarted session gets a new thread and a warning that the agent no longer has the earlier turns ([code/agent-integration.md](code/agent-integration.md#no-session-recovery)). Pockode's own transcript survives either way; what a resume decides is whether the *agent* still has the context.

A session can also be **forked**: `session.fork` starts a new session from a copy of the source's transcript, cut to the moment before the message the user picked — which keeps that message when the agent said it, and drops it when the user did, because the fork returns to before they sent it ([session-fork-ui.md](session-fork-ui.md#the-rule)). The source is left untouched. Whether the agent comes along is that agent's own declared answer, and it is a stronger question than resuming: Claude can follow a fork to a chosen message inside a conversation, while a Codex session cannot be forked at all and the request is refused rather than handing back a session whose agent has never seen the conversation filling its screen ([code/agent-integration.md](code/agent-integration.md#session-forking), UI in [session-fork-ui.md](session-fork-ui.md)).
