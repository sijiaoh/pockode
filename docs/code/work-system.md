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
| `StepDone(id, totalSteps)` | in_progress → in_progress/waiting/closed | Advance task step, wait for pending story children, or complete work |
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

Work items transition through `StepDone`; there is no intermediate `done` state. Tasks advance to the next step or close when no steps remain. Stories close when they have no pending children, and move to `waiting` when they still have open child work. When a child task closes, the system automatically resumes its parent story only if the parent is `waiting`. Already closed parents are not reopened, preserving the intentional completion of coordinated work.

## File-Based Storage

### Why Files Over Database

The Work system uses atomic file I/O instead of a database:

1. **Multi-process support** — MCP servers (spawned by AI CLI) and the main server both need access
2. **No single point of failure** — No database process to manage
3. **Simple deployment** — Just files in a directory

### Concurrency Control

```
server/filestore/filestore.go
```

**Read path** (shared lock):
```go
lockFile := OpenFile(".lock", CREATE|RDWR)
Flock(lockFile, LOCK_SH)  // Allows concurrent reads
defer Flock(lockFile, LOCK_UN)
return ReadFile(path)
```

**Write path** (exclusive lock + atomic rename):
```go
lockFile := OpenFile(".lock", CREATE|RDWR)
Flock(lockFile, LOCK_EX)  // Blocks other writers and readers
defer Flock(lockFile, LOCK_UN)

tmpFile := CreateTemp(path + ".tmp")
tmpFile.Write(data)
tmpFile.Sync()  // fsync ensures durability
Rename(tmpFile, path)  // POSIX atomic operation

writeGen.Add(1)  // Increment version for stale detection
```

### Cross-Process Notification

When one process writes, others detect changes via fsnotify:

```
Process A (MCP)              Process B (Main Server)
     │                              │
     │ Write to works.json          │
     │ ─────────────────────────►   │
     │                              │ fsnotify: WRITE event
     │                              │ ─────────────────────►
     │                              │ debounce 100ms
     │                              │ reloadFromDisk()
     │                              │ notify listeners
```

### Stale Reload Prevention

A write-generation counter prevents TOCTOU races:

```go
// Before reload
genBefore := file.SnapshotGen()

// Read from disk (potentially slow)
data := readFromDisk()

// Before applying to memory
file.mu.Lock()
if file.IsStale(genBefore) {
    // Another write happened between our read and now
    // Discard this reload, wait for next fsnotify event
    file.mu.Unlock()
    return
}
// Safe to update in-memory state
applyData(data)
file.mu.Unlock()
```

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
| `step_done` | Advance task step, wait for pending story children, or close work | `id` |
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
server/mcp/server.go
```

The MCP server runs as a stdio subprocess spawned by the AI CLI:

```
AI CLI (claude)
    │ spawn
    ▼
MCP Server (pockode mcp)
    │ stdio JSON-RPC 2.0
    ▼
FileStore (shared with main server)
```

All tool results are JSON (not formatted text) to prevent prompt injection and ensure stable parsing:

```go
func handleToolCall(ctx, w, req) {
    result, err := tool.Execute(ctx, params)
    if err != nil {
        writeJSONRPCResult(w, req.ID, toolCallResult{
            Content: []content{{Type: "text", Text: err.Error()}},
            IsError: true,
        })
        return
    }

    jsonResult, _ := json.Marshal(result)
    writeJSONRPCResult(w, req.ID, toolCallResult{
        Content: []content{{Type: "text", Text: string(jsonResult)}},
    })
}
```

## AutoResumer

The AutoResumer watches for state changes and automatically manages work lifecycle.

### Five Triggers

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

When a task closes, the system checks its parent status:

- **Waiting parent**: Resumed via `ResumeFromWaiting` with a `child_completion_nudge` message
- **Closed parent**: Not reopened (intentional completion is preserved)

```
Task: closed ──► Parent Story (waiting) → in_progress
                       │
                       ▼
            Send "Child completed" message

Task: closed ──► Parent Story (closed) → (no change)
```

This design ensures that completed coordination work remains closed even if child tasks are created and completed afterward (e.g., via manual intervention or reopen workflows).

**Trigger C: External Work Start**

When MCP `work_start` is called from an external process:

```
MCP: work_start ──► fsnotify ──► AutoResumer
                                     │
                    handleExternalWorkStart()
                                     │
                    Call WorkStartHandler
```

**Trigger D: Reserved**

(Removed — step advance is now handled by Trigger E)

**Trigger E: External Step Done**

When MCP `step_done` is called from an external process and the step advances:

```
MCP: step_done ──► store.StepDone()
                        │
                        ▼
                 hasMoreSteps?
                   │        │
                 yes       no
                   │        │
                   ▼        ▼
            CurrentStep++   Close work
                   │
                   ▼
            fsnotify ──► AutoResumer
                              │
                              ▼
                  Detect CurrentStep change
                              │
                              ▼
                  handleExternalStepDone()
                              │
                              ▼
                  Send next step prompt
```

Unlike Trigger B (child closure waking a waiting parent), step advancement is agent-initiated via `step_done` rather than automatic upon completion.

**Trigger F: External Work Reopen**

When MCP `work_reopen` is called from an external process:

```
MCP: work_reopen ──► fsnotify ──► AutoResumer
                                       │
                      detect closed → in_progress
                                       │
                      handleExternalReopen()
                                       │
                      Send reopen message
```

The reopen message instructs the agent to review its previous work and determine what additional changes are needed, then call `step_done` when complete.

### Retry and Settle Delay

```go
maxRetries = 3        // Stop work after 3 auto-continuation failures
settleDelay = 2s      // Wait for MCP writes to propagate via fsnotify
```

The settle delay ensures that when checking retry counts, any pending `step_done` calls have propagated through fsnotify and reset the counter.

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
- `step_done`: Tasks advance to the next step or close when no steps remain. Stories wait while they have pending child work, or close when none remain.

### Prompt Format

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
- Call step_done with ID xxx to complete the task.
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
- If YES and this IS the last step: Call step_done with ID xxx to complete the task.
- If NO: Continue working on this step.
```

### Design Notes

- **Steps apply to both Stories and Tasks**: Any work item with an agent role that has steps defined will display step progress.
- **Step state persists**: `CurrentStep` is preserved through `stopped`/`needs_input` transitions.
- **Retry counter resets per step**: Each new step gets a fresh retry budget.
- **Explicit step control**: Agents call `step_done` to advance steps, giving them control over when steps complete.
- **step_done completion flow**:
  - Tasks: increments `CurrentStep` while more steps remain.
  - Tasks: marks the work as `closed` on the final step or when the role has no steps.
  - Stories: transitions to `waiting` while pending child work exists, or `closed` when no pending children remain.

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
| `task_step_auto_continue_nudge` | Task step auto-continuation | `CurrentStep`, `TotalSteps`, `ID` |
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
| MCP server | `server/mcp/server.go` |
| MCP tools | `server/mcp/tools.go` |
| File I/O | `server/filestore/filestore.go` |
| Frontend store | `web/src/lib/workStore.ts` |
