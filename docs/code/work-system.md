# Work/Project Management System

The Work system enables AI agents to coordinate complex tasks through a two-level tree structure. A coordinator agent breaks high-level stories into executable tasks, while worker agents implement each task and report back.

## Data Model

### Two-Level Tree Structure

```
Story: "Add dark mode support"
├── Task: "Create theme context"
├── Task: "Update components"
└── Task: "Add toggle UI"
```

**Design Decision**: Only two levels (Story → Task) are allowed. This constraint:
- Forces clear separation: Stories coordinate, Tasks execute
- Prevents recursion complexity while still enabling fine-grained work breakdown
- Simplifies the state machine and lifecycle management

```go
// server/work/types.go
type Work struct {
    ID          string     // UUID v7
    Type        WorkType   // "story" | "task"
    ParentID    string     // Empty for Story, required for Task
    AgentRoleID string     // The AI role that executes this work
    Title       string
    Body        string     // Detailed instructions (optional)
    Status      WorkStatus
    SessionID   string     // Active AI session, empty when not running
    CurrentStep int        // 0-indexed; used only when agent role has Steps
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

### Validation Rules

On creation (`server/work/store.go:157-193`):
1. **Type must be valid** — either "story" or "task"
2. **Title required** — non-empty string
3. **AgentRoleID required** — must exist in the role store
4. **Parent type match** — Tasks must have a Story parent, Stories cannot have parents
5. **Parent not closed** — Cannot create children under closed parents

## State Machine

### Six States

```
open ──────────────► in_progress
                         │
              ┌──────────┼──────────┬──────────┐
              │          │          │          │
              ▼          ▼          ▼          ▼
        needs_input   waiting   stopped    closed ─────► in_progress
              │          │          │                       (via Reopen)
              │          │          │
              └──────────┴──────────┴─────► (can return to in_progress)
```

| State | Meaning | SessionID | CurrentStep |
|-------|---------|-----------|-------------|
| `open` | Not started | empty | 0 |
| `in_progress` | AI session active | set | tracks current step |
| `needs_input` | Waiting for user input | preserved | preserved |
| `waiting` | Waiting for child work to complete | preserved | preserved |
| `stopped` | Session ended unexpectedly | preserved | preserved |
| `closed` | Work completed | preserved | preserved |

### Intent-Driven Transitions

The API exposes intent methods rather than raw status updates. Each method encapsulates business logic and validates transitions.

| Method | Transition | Purpose |
|--------|------------|---------|
| `Start(id, sessionID)` | open/stopped/needs_input → in_progress | Launch AI session |
| `Stop(id)` | in_progress/needs_input/waiting → stopped | Terminate session |
| `StepDone(id, totalSteps)` | in_progress → in_progress/closed | Advance work step or close work |
| `MarkNeedsInput(id)` | in_progress → needs_input | Pause for user input |
| `MarkWaiting(id)` | in_progress → waiting | Pause for child work completion |
| `Resume(id)` | needs_input → in_progress | Continue after user input |
| `ResumeFromWaiting(id)` | waiting → in_progress | Continue after child completes |
| `Reactivate(id)` | stopped → in_progress | Sync with running session |
| `Reopen(id)` | closed → in_progress | Reopen a closed item to add children or continue |
| `RollbackStart(id, wasRestart)` | in_progress → open/stopped | Undo failed start |

### Waiting vs NeedsInput

Both `waiting` and `needs_input` pause the agent's work, but serve different purposes:

| State | Purpose | Resumed By |
|-------|---------|------------|
| `needs_input` | Agent needs user confirmation or clarification | User sending a message |
| `waiting` | Agent waiting for child work to complete | Child work closure, or user message |

**Key difference**: `waiting` is used when a coordinator agent has created child tasks and wants to pause until they complete, while `needs_input` is used when the agent genuinely needs user input to proceed.

Both states can be resumed by user messages, allowing users to interrupt the wait if needed.

### Step Completion

Work items transition through `StepDone`; there is no intermediate `done` state. Any work item with remaining steps advances to the next step and stays `in_progress`. When no steps remain, the work item closes. Waiting for child work is handled explicitly through `work_wait` / `MarkWaiting`, not `StepDone`. When a child task closes, the system automatically resumes its parent story only if the parent is `waiting`. Already closed parents are not reopened, preserving the intentional completion of coordinated work.

## File-Based Storage

### Why Files Over Database

The Work system uses atomic file I/O instead of a database:

1. **No single point of failure** — No database process to manage
2. **Simple deployment** — Just files in a directory
3. **Inspectable** — Plain JSON on disk

The main server is the **sole writer** of work data: the frontend goes through
the WebSocket layer and the AI goes through the MCP API (see *MCP Server
Architecture*), and both mutate the in-memory store directly. Mutations are
serialized by a mutex and persisted atomically.

> Because the server is the sole writer, the work and agent-role stores do not
> run a file watcher: their change events are emitted directly from in-process
> mutations rather than reloaded after a cross-process write.

### Atomic Persistence

```
server/filestore/filestore.go
```

Writes take an exclusive flock and do write-temp → fsync → rename, so a crash or
a concurrent reader never sees a torn file; reads take a shared flock:

```go
lockFile := OpenFile(".lock", CREATE|RDWR)
Flock(lockFile, LOCK_EX)
defer Flock(lockFile, LOCK_UN)

tmpFile := CreateTemp(path + ".tmp")
tmpFile.Write(data)
tmpFile.Sync()        // fsync ensures durability
Rename(tmpFile, path) // POSIX atomic operation
```

The filestore primitive also offers fsnotify-based reload for callers that need
cross-process change detection (the settings store uses it); the work and
agent-role stores do not enable it, since the server is their only writer.

## MCP Tools

AI agents interact with the Work system through MCP (Model Context Protocol) tools, exposed via a stdio JSON-RPC 2.0 subprocess.

### Work Tools

| Tool | Purpose | Key Parameters |
|------|---------|----------------|
| `work_list` | List all works, optionally by parent | `parent_id?` |
| `work_create` | Create Story or Task | `type`, `title`, `agent_role_id`, `parent_id?` |
| `work_get` | Get full details including body | `id` |
| `work_update` | Modify title/body/role | `id`, fields to update |
| `work_delete` | Delete (cascades to children) | `id` |
| `work_start` | Begin execution | `id` |
| `work_needs_input` | Pause for user input | `id`, `reason` |
| `work_wait` | Pause for child work completion | `id` |
| `work_reopen` | Reopen a closed work item | `id` |
| `step_done` | Advance work step or close work | `id` |
| `work_comment_add` | Add progress note | `work_id`, `body` |
| `work_comment_list` | List comments | `work_id` |
| `work_comment_update` | Update comment text | `id`, `body` |

### Agent Role Tools

| Tool | Purpose |
|------|---------|
| `agent_role_list` | List available roles (without prompts) |
| `agent_role_get` | Get role details including system prompt |
| `agent_role_reset_defaults` | Reset to default roles |

### MCP Server Architecture

```
server/mcp/server.go    — stdio proxy (Server) + Client
server/mcp/executor.go  — server-side tool logic (Executor)
server/mcp/handler.go   — local HTTP API (APIHandler)
```

The MCP subprocess is a **thin client**. It opens no store and starts no
watcher; instead it forwards every tool call over HTTP to the running main
server, which executes it in-process against the same stores the WebSocket
layer uses:

```
AI CLI (claude / codex)
    │ spawn: `pockode mcp --data-dir <dir>`
    ▼
MCP stdio proxy (Server)
    │ reads <dir>/server.json → { local_url, token }
    │ tools/call ──HTTP POST /api/mcp/tools/call (Bearer token)──►
    ▼
Main server: APIHandler → Executor → work.Store / WorkStarter
```

**Why client mode** (rather than letting the subprocess write the store files
itself):

- **Single writer** — only the main server mutates work data, so there is no
  two-writer fsnotify sync to coordinate.
- **Direct side effects** — `work_start`/`work_reopen` run through the shared
  `work.Operations` (claim + kickoff, or reopen + nudge) and `step_done` sends its
  follow-up via the AutoResumer (`NotifyStepDone`), so a transition takes effect
  immediately instead of waiting for the main server to notice a file change.
- **One implementation per transport** — the WebSocket handler (user actions) and
  the MCP Executor (AI actions) call the same `work.Operations`, so a user start/
  reopen and an AI start/reopen behave identically.

**Authentication**: the server generates a random token at startup and writes
it to `server.json` (mode `0600`, since it is a credential) alongside the port.
It is distinct from the user-facing `--auth-token` (which is never written to
disk) and lives only for the lifetime of the process. `middleware.Auth` bypasses
the exact `/api/mcp/tools/call` route; the `APIHandler` verifies the local token
itself. The endpoint is loopback-only in practice — the relay explicitly refuses
to forward `/api/mcp/*`, so it is never reachable remotely.

All tool results are JSON (not formatted text) where structured data is
returned, to prevent prompt injection and ensure stable parsing. A tool whose
handler fails comes back as an `isError` result (the AI sees it); transport or
auth failures are surfaced to the AI rather than failing silently.

## AutoResumer

The AutoResumer watches for state changes and automatically manages work lifecycle.

### Triggers

**Trigger A: Process State Changes**

When an AI session's state changes, sync the work status:

| Process State | Work Transition | Purpose |
|---------------|-----------------|---------|
| running | stopped → in_progress | User message to stopped session |
| idle (first) | (ignored) | Initial process startup |
| idle (normal) | in_progress → in_progress | Send auto-continuation |
| interrupted | in_progress/waiting → stopped | User interrupt |
| ended | in_progress/waiting → stopped | Process exited |

**Trigger B: Child Closure**

When a child work closes, the system notifies its parent based on the parent's status. The logic separates two concerns: *state transition* and *message sending*.

| Parent Status | State Transition | Message Sent | Rationale |
|---------------|------------------|--------------|-----------|
| `open` | — | No | No agent session started yet |
| `in_progress` | — | Yes | Agent is running; notify it of child completion |
| `needs_input` | — | Yes | Agent is paused but active; deliver notification |
| `waiting` | → `in_progress` | Yes | Resume the waiting coordinator |
| `stopped` | — | Yes | Session can be restarted; preserve notification |
| `closed` | — | No | Parent was explicitly closed; stay closed |

```
Task: closed ──► Parent (waiting) → in_progress
                       │
                       ▼
            Send "Child completed" message

Task: closed ──► Parent (in_progress/needs_input/stopped)
                       │
                       ▼
            Send "Child completed" message (no state change)

Task: closed ──► Parent (open/closed) → (no message)
```

**Key distinction**: Only `waiting` parents undergo a state transition. Other active parents (`in_progress`, `needs_input`, `stopped`) receive the notification without changing status. This enables coordinators to receive multiple child completion messages when running with parallel subtasks.

### Step-Advance and Reopen Follow-ups

`work_start`, `step_done`, and `work_reopen` are driven in-process rather than by
the AutoResumer reacting to a file change. `work_start` and `work_reopen` live in
the shared `work.Operations`, called by both the WebSocket handler and the MCP
`Executor`:

- **work_start** — `Operations.StartWork` claims the work (`store.Claim`, which
  decides restart/session reuse atomically under the store lock) and calls
  `WorkStartHandler` to create the session and send the kickoff, rolling back the
  claim on failure. Runs detached from the caller's context.
- **work_reopen** — `Operations.ReopenWork` calls `store.Reopen`, then
  `AutoResumer.NotifyReopen` to send the reopen nudge.
- **step_done** (MCP-only) — after `store.StepDone` advances the step, the
  `Executor` calls `AutoResumer.NotifyStepDone`, which sends the next-step prompt
  (only while the work is still `in_progress`).

```
step_done ──► store.StepDone()
                   │
                   ▼
            hasMoreSteps?
              │        │
            yes        no
              │        │
              ▼        ▼
       CurrentStep++   Close work ──► Trigger B (parent reactivation, if any)
              │
              ▼
       Executor.NotifyStepDone() ──► send next-step prompt
```

The reopen message instructs the agent to review its previous work and determine what additional changes are needed, then call `step_done` when complete.

### Retry and Settle Delay

```go
maxRetries = 3        // Stop work after 3 auto-continuation failures
settleDelay = 2s      // Let an in-flight step_done's retry reset land first
```

An agent typically calls `step_done` right before its turn ends. The settle
delay gives that in-process transition's retry reset time to land before
`handleAutoContinuation` reads the retry count, so the stop-after-N accounting
stays correct (it does not by itself suppress a redundant continuation message —
that remains a rare worst case).

## Frontend Integration

```typescript
// web/src/lib/workStore.ts
interface WorkStore {
    works: Work[];
    isLoading: boolean;
    error: string | null;

    setWorks: (works: Work[]) => void;
    updateWorks: (updater: (old: Work[]) => Work[]) => void;
    setError: (error: string) => void;
    reset: () => void;
}

// Collect active session IDs for routing
export function collectWorkSessionIds(works: Work[]): Set<string> {
    const ids = new Set<string>();
    for (const w of works) {
        if (w.session_id) ids.add(w.session_id);
    }
    return ids;
}
```

The frontend subscribes to work changes via WebSocket and updates the Zustand store. Session IDs are collected to route chat messages to the correct work context.

## Multi-Step Execution

Agent roles can define a `steps` array to break task execution into sequential phases. This is useful for complex workflows like:
- Research → Plan → Implement → Test
- Design → Code → Document

### Step Lifecycle

```
Start (step 0)
     │
     ▼
┌─────────────────────┐
│ Agent works on      │
│ current step        │
└─────────┬───────────┘
          │
          ▼
    Is last step?
     │        │
    no       yes
     │        │
     ▼        ▼
 step_done   step_done
     │        │
     ▼        ▼
 CurrentStep++ Normal completion
     │        (→ closed; if parent is waiting, it resumes)
     │
     ▼
 AutoResumer sends
 next step prompt
     │
     └──────► (loop back to working)
```

**Key distinction**:
- `step_done`: Work items advance to the next step while more steps remain, or close when no steps remain.

### Prompt Format

Base prompts tell the agent to fetch its agent role and use that role's instructions. They also state the lifecycle rule in one place: call `step_done` when a step is complete, or when the work is done if the work item has no steps. Tasks with a parent story report results to that parent with `work_comment_add`. Story prompts tell coordinators to call `work_wait` after starting child tasks so the story waits for task completion reports.

**Initial kickoff with steps:**
```
[Base message]

## Current Step
Step 1 of 3

<step 1 instructions>

When you finish this step:
- Call step_done with ID xxx to proceed to the next step.
```

**Step advance message:**
```
[Base message]

Step 1 of 3 completed. Proceeding to the next step.

## Current Step
Step 2 of 3

<step 2 instructions>

When you finish this step:
- Call step_done with ID xxx to proceed to the next step.
```

**Step advance message (last step):**
```
[Base message]

Step 2 of 3 completed. Proceeding to the next step.

## Current Step
Step 3 of 3

<step 3 instructions>

When you finish this step:
- Call step_done with ID xxx to close the work item.
```

**Auto-continuation with steps:**
```
[Base message]

## Current Step
Step 2 of 3

<step 2 instructions>

Your session was interrupted while working on step 2 of 3.

Check if you have completed the current step:
- If YES and this is NOT the last step: Call step_done with ID xxx to proceed to the next step.
- If YES and this IS the last step: Call step_done with ID xxx to close the work item.
- If NO: Continue working on this step.
```

### Design Notes

- **Steps apply to both Stories and Tasks**: Any work item with an agent role that has steps defined will display step progress.
- **Step state persists**: `CurrentStep` is preserved through `stopped`/`needs_input` transitions.
- **Retry counter resets per step**: Each new step gets a fresh retry budget.
- **Explicit step control**: Agents call `step_done` to advance steps, giving them control over when steps complete.
- **step_done completion flow**:
  - All work items: increments `CurrentStep` while more steps remain.
  - All work items: marks the work as `closed` on the final step or when the role has no steps.

## Prompt Configuration

Prompt templates are externalized in `server/work/prompts.yaml`, embedded at compile time via `go:embed`. This separation enables:
- Non-programmers to review and modify AI instructions
- Clear separation between prompt content and rendering logic
- Easy diffing and tracking of prompt changes

### Configuration File

```yaml
# server/work/prompts.yaml

# Each key is a template name, value is the template string
# Uses Go text/template syntax: {{.FieldName}}

pockode_mcp_prefix: |
  All work_* and agent_role_* tools in this session...

role_reference: |
  Your agent role ID is {{.AgentRoleID}}. Use agent_role_get...

work_context: |
  You are working on: "{{.Title}}" (Work ID: {{.ID}})...
```

### Template Keys

| Key | Used In | Placeholders |
|-----|---------|--------------|
| `pockode_mcp_prefix` | All messages | (none) |
| `role_reference` | All messages | `AgentRoleID` |
| `work_context` | All messages | `Title`, `ID` |
| `story_behavior_rules` | Story kickoff | (none) |
| `story_rules_suffix` | Story kickoff | `ID` |
| `task_rules_with_parent` | Task with parent | `ParentID`, `ID` |
| `task_rules_without_parent` | Standalone task | `ID` |
| `story_restart_nudge` | Story restart | `ID` |
| `task_restart_nudge` | Task restart | `ID` |
| `story_auto_continue_nudge` | Story auto-continuation | `ID` |
| `task_auto_continue_nudge` | Task auto-continuation | `ID` |
| `step_auto_continue_nudge` | Step auto-continuation | `CurrentStep`, `TotalSteps`, `ID` |
| `child_completion_nudge` | Waiting parent resume | `ChildTitle`, `ChildID`, `ID` |
| `story_reopen_nudge` | Story reopen | `ID` |
| `task_reopen_nudge` | Task reopen | `ID` |
| `step_advance_section` | Step advance | `PrevStep`, `TotalSteps`, `CurrentStep`, `StepPrompt`, `ID` |
| `current_step_section` | Initial step display | `CurrentStep`, `TotalSteps`, `StepPrompt`, `ID` |

### Rendering

```go
// server/work/prompt.go

//go:embed prompts.yaml
var promptsYAML []byte

func render(tmplStr string, data any) string {
    tmpl := template.New("").Parse(tmplStr)
    var buf bytes.Buffer
    tmpl.Execute(&buf, data)
    return strings.TrimSuffix(buf.String(), "\n")
}
```

## Code Paths

| Component | Path |
|-----------|------|
| Data types | `server/work/types.go` |
| File store | `server/work/store.go` |
| State validation | `server/work/validation.go` |
| Auto resumer | `server/work/auto_resumer.go` |
| Prompt builder | `server/work/prompt.go` |
| Prompt templates | `server/work/prompts.yaml` |
| MCP stdio proxy + client | `server/mcp/server.go`, `server/mcp/client.go` |
| MCP tool definitions | `server/mcp/tools.go` |
| MCP tool executor + HTTP API | `server/mcp/executor.go`, `server/mcp/handler.go` |
| File I/O | `server/filestore/filestore.go` |
| Frontend store | `web/src/lib/workStore.ts` |
