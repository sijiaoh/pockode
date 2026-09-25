# Frontend Integration

How the Project system is integrated into the React frontend: state management, real-time sync, and UI.

## State Management

### Zustand Stores

Two Zustand stores hold entity state:

| Store | State | File |
|---|---|---|
| `useWorkStore` | `works: WorkListItem[]`, `isLoading`, `error` | `web/src/lib/workStore.ts` |
| `useAgentRoleStore` | `roles: AgentRole[]`, `workRefCounts: Record<string, number>`, `isLoading`, `error` | `web/src/lib/agentRoleStore.ts` |

Both stores expose the same action pattern:

- `set[Items]` — Replace entire list (used for initial load and sync)
- `update[Items]` — Apply a transform function to the list (used for incremental updates)
- `setError` — Set error state
- `reset` — Reset to initial loading state

### RPC Action Creators

Mutation operations are defined as RPC action creators, injected into `wsStore.actions`:

**Work** (`web/src/lib/rpc/work.ts`):
`createWork`, `updateWork`, `deleteWork`, `startWork`, `stopWork`

**AgentRole** (`web/src/lib/rpc/agentRole.ts`):
`createAgentRole`, `updateAgentRole`, `deleteAgentRole`, `resetAgentRoleDefaults`

Each creator takes a `getClient` thunk that returns the JSON-RPC requester. The creator calls `requireClient()` to throw if not connected, then delegates to `client.request()`.

### Subscription Wiring in wsStore

`wsStore` (`web/src/lib/wsStore.ts`) owns the WebSocket connection and exposes subscribe/unsubscribe methods:

- `workListSubscribe` / `workListUnsubscribe` — `work.list.*` RPCs, callbacks in `workListWatchCallbacks` map
- `workDetailSubscribe` / `workDetailUnsubscribe` — `work.detail.*` RPCs, callbacks in `workDetailWatchCallbacks` map
- `agentRoleListSubscribe` / `agentRoleListUnsubscribe` — `agent_role.list.*` RPCs, callbacks in `agentRoleListWatchCallbacks` map

Incoming notifications are routed by method name in `handleNotification()`:

- `work.list.changed` → dispatches to the callback registered for that subscription ID
- `work.detail.changed` → same pattern
- `agent_role.list.changed` → same pattern

wsStore splits its watch callbacks into two groups, mirroring where the server keeps the matching watchers:

- **Worktree-scoped** (file, git, git-diff, session list, session detail, chat messages) — the server tears down these watchers when the connection switches worktree. Which group a callback map belongs to follows the server's watcher, not the hook's `resubscribeOnWorktreeChange` — session detail is worktree-scoped and still does not resubscribe ([why](../code/subscription-system.md#why-sessiondetail-is-worktree-scoped-but-never-resubscribes)).
- **App-level / global** (work list, work detail, agent role list, settings, worktree list) — these watchers are Manager-level and keep pushing across worktree switches.

On worktree switch, `switchWorktreeRPC()` calls `clearWorktreeWatchSubscriptions()`, which clears only the worktree-scoped maps. App-level callbacks are deliberately preserved: Work and AgentRole subscriptions set `resubscribeOnWorktreeChange: false` (they never resubscribe on switch), so clearing their callbacks would leave the server pushing `work.list.changed` and similar notifications into a connection with no local handler — silently dropping updates.

On WebSocket close, `clearAllWatchSubscriptions()` clears every callback map (including app-level), since the connection and all its server-side subscriptions are gone. When the connection is re-established, `useSubscription` detects the `connected` status change and resubscribes automatically.

## Real-Time Sync

### useSubscription Hook

Both subscription hooks use the generic `useSubscription` hook (`web/src/hooks/useSubscription.ts`), which manages the full lifecycle:

1. **Subscribe** — On mount (when `enabled && connected`), calls the subscribe function — which registers the callback under the id it generated *before* sending the RPC — and invokes `onSubscribed` with the initial data, replaying anything that arrived in the meantime ([why](../code/subscription-system.md#why-nothing-is-lost-while-a-subscription-is-being-opened))
2. **Receive notifications** — Routes incremental changes through the notification callback
3. **Unsubscribe** — On unmount, disable, or disconnect, unsubscribes and calls `onReset`
4. **Race condition handling** — Uses a generation counter to discard stale responses
5. **Worktree change** — If `resubscribeOnWorktreeChange` is true, invalidates and resubscribes on worktree switch

### Notification Handling

Both `useWorkSubscription` and `useAgentRoleSubscription` follow the same update pattern:

| Operation | Behavior |
|---|---|
| `sync` | Replace entire store (full snapshot from server) |
| `create` | Append to list; deduplicate if item already exists (race between subscribe and initial fetch) |
| `update` | Replace item by ID |
| `delete` | Remove item by ID |

`useAgentRoleSubscription` handles one more, `ref_counts`, which replaces
`workRefCounts` wholesale. It is never patched and `sync` never clears it: the
counts belong to the work store and move while no role changes
([why](../code/subscription-system.md#why-one-channel-carries-two-stores-changes)).

## UI Structure

The information architecture of these screens — which work the list holds, how
it is grouped, what a row shows and where creating work lands — is
[project-ui.md](../project-ui.md), and the state vocabulary the rows paint is
[lifecycle-ui.md](../lifecycle-ui.md). This section is what each component is
and what it reads, and it does not restate either.

### Navigation Flow

```
ProjectTab
  ├── "Project"         → WorkListOverlay
  │                         ├── (tap row)     → WorkDetailOverlay
  │                         │                     ├── (tap task row) → WorkDetailOverlay
  │                         │                     ├── "Add Task"     → CreateWorkSheet → WorkDetailOverlay
  │                         │                     ├── (row chat icon)→ Chat session
  │                         │                     └── "Open Chat"    → Chat session
  │                         ├── (row chat icon)→ Chat session
  │                         └── "New Story"   → CreateWorkSheet → WorkDetailOverlay
  └── "Agent Roles"     → AgentRoleListOverlay
                             └── (tap role) → AgentRoleDetailOverlay
```

Creating work always ends on the new item's detail page: `CreateWorkSheet` hands
its caller the created `id` and the caller calls the `onOpenWorkDetail` it
already has. No component routes itself — `AppShell` owns every navigation in
this app ([project-ui.md §4](../project-ui.md#4-creating-work-lands-you-on-its-detail-page)).

`ProjectTab` is the sidebar entry point. It renders two buttons that open their respective overlay screens via callbacks (`onOpenWorkList`, `onOpenAgentRoleList`).

Opening a work's chat (the `Chat` / `Open Chat` shortcuts) navigates to the session URL of **the work's own worktree** (`/w/<worktree>/s/<sessionId>`), not the currently active one — the list is global across worktrees, so a shortcut may switch worktrees. See [work-system.md](../code/work-system.md#cross-worktree-chat-navigation) for the rationale.

### WorkListOverlay

Activates both `useWorkSubscription` and `useAgentRoleSubscription`.

**What it draws:**

1. A `Current` / `Closed` segmented control under the header and outside the scroll area. The chosen segment is a prop, read from the URL by `AppShell` and written back by tapping ([why](../project-ui.md#5-where-the-segment-lives)); this screen holds none of it
2. Inside `Current`, four inert sticky group headings — *Stopped*, *Needs you*, *In progress*, *Not running* — whose membership is the single `rowGroup()` function in the file, and whose order is the single `GROUP_ORDER` constant beside it. Every group is sorted `updated_at` newest first by `lib/workOrder.ts`, which is also the order the server cuts both its caps and the archive's pages along. `Closed` is the archive: closed stories, flat, same order, sorted by the server and never re-sorted here
3. Every row is `WorkRow` (below). The screen draws no row of its own, nothing expands and no group collapses
4. Loading, subscription failure and both empty states are the scroll area's; the segmented control and the bottom bar stay usable through all three
5. A fixed `BottomActionBar` with `New Story`, which opens `CreateWorkSheet`

**What the screen resolves for its rows**, because a row is given facts rather
than looking them up: the story's tasks (indexed by `story_id` into a
`Map<string, WorkListItem[]>`), the title of the story a task belongs to, the role name out of
`useRoleNameMap`, and `showUpdatedAt` in the `Closed` segment.

### WorkRow

One work as a row, and the only component that draws one: the project list and
the story detail's Tasks section both render it, so the glyph, the two icon
controls and the seven meta slots are decided once ([project-ui.md §3](../project-ui.md#3-the-row)).

`WorkRow` owns the row's lifecycle command: `useWorkCommand` is called here
rather than inside `WorkPrimaryAction`, because a failure has to be written
somewhere a glyph has no room for. The button is a pure control given
`{ action, busy, failed, errorId, workTitle }` and an `onActivate` — `workTitle`
because the name it is announced under is the only thing telling two rows'
identical glyphs apart, and `errorId` (the row's `useId`, passed only while
there is a message) because the button describes itself with a line the row
owns. The row renders both things the command can raise: the Stop confirmation,
and the error line that §3 calls line 3. The hook, the four-status table and
`StopConfirm` still live in `WorkPrimaryAction.tsx`, which `WorkDetailOverlay`
imports them from to write its own wider, labelled button — the hook itself
takes no title, because the title belongs to whichever control is being
announced rather than to the command.

The whole row opens the work — the title button covers it with an
`after:inset-0` overlay rather than the row taking an `onClick`, which would be
a second target over the same pixels and two `biome-ignore`s for the a11y rules
that say so. The two trailing controls and the `WorktreeBadge` lift themselves
back above that overlay with `relative z-10`, which is why `WorkListOverlay`'s
sticky group headings are `z-20`: at the same level, a control scrolling under
a heading would be drawn over it.

`WorktreeBadge` marks which worktree the work runs in — the list is global across
worktrees, so the badge is what tells rows apart; work whose worktree can still
change carries none. Whether it is visible is `useWorktreeBadgeVisible(work)`,
exported beside the badge because the meta line has to know whether the slot is
there before it can decide where the separator dots go.

### WorkDetailOverlay

Shows the detail view for a single work item (story or task).

**What changes goes above what does not.** It is the list page's rule — what
needs the user comes first ([project-ui.md §2.3](../project-ui.md#23-four-groups-and-why-four))
— applied to one work: a user opens a running work to see where it has got to,
and that is the questions it is asking and the tasks it is moving through, not
the brief they wrote and the role they picked before it started. The rule draws
one line rather than ranking every section: above the Description is what a user
opens a running work for; from the Description down is reference — Steps and
Usage do move, but checking them is not why the page was opened, and Comments
is a log, read from the end it grows at. A task's page is a story's without
Tasks, not an order of its own:

1. **Parent link** — If the item is a task, shows a tappable link to the parent story
2. **Title** — Inline-editable (tap pencil icon to enter edit mode)
3. **Status** — Read-only `ActivityBadge`, with a `WorktreeBadge` alongside it: the worktree binding isn't editable, but the badge is a link that navigates to that worktree's root (shown for both stories and tasks, since a task detail can be opened directly; hidden while neither the work nor its story has started, because only then can the worktree still change). Under them, the `child`-only wait line ([lifecycle-ui.md §6.2](../lifecycle-ui.md#62-detail-page))
4. **Unanswered questions** — A read-only block, present whenever `pending_questions` is non-empty, with one Answer button into the chat when the work has a session ([lifecycle-ui.md §6.2](../lifecycle-ui.md#62-detail-page))
5. **Tasks** (story only) — The story's child tasks as `WorkRow`s, the one place a story's tasks are listed, plus an `Add Task` control opening `CreateWorkSheet`. The rows differ from the list's in one slot only: the story name is left off, because every row here is a task of the story on screen. The heading carries `closed/total` and, whenever any child is `active`, an "{n} active" count — the same count that makes a refused `step_done` legible (docs/lifecycle-ui.md §6.2)
6. **Description** — Inline-editable textarea with Markdown rendering. Fully shown while the work is `open`, when the brief is still what the user is writing; once it has left `open` the brief is settled, and in full it would push everything below it off a phone's first screen, so it collapses to its first non-empty line (a leading heading, quote or list marker dropped — a brief usually opens with `## Goal`) and expands, through `CollapsibleBody`, from that line or the chevron beside the pencil.
7. **Role** — Inline-editable `RoleSelect` (tap to switch role)
8. **Steps** — Step progress indicator showing current step position (if agent role has steps defined). Each step's text renders as Markdown, like the role page's copy of it ([lifecycle-ui.md §6.3](../lifecycle-ui.md#63-steplist))
9. **Usage** — Tokens and cost, this item's own beside the total over it and its tasks, from the same `work.detail` subscription and updating live as its sessions spend ([usage-display-ui.md](../usage-display-ui.md), [aggregation](../code/work-system.md#usage-aggregation))
10. **Comments** — Loaded via `work.detail.subscribe` (real-time), and read-only: the list is the record agents and the engine write about what happened, and nothing here writes or edits one. A comment carries no author field ([data-model.md](data-model.md#comment)), so an edit would leave nothing to tell a user's wording from the agent's — and the next agent to read the story with `work_comment_list` would take the rewrite as its predecessor's report

The page is keyed by work id inside the component (`WorkDetailOverlay` renders
`WorkDetailPage key={workId}`). Moving to a parent or child, or between two
details in history, renders the same element with another id, and a reused page
would carry the last work's scroll position, expanded or half-edited brief, open
sheet and error line onto the next one. A notification about the same work keeps
the id, so the reader's place survives it.

**Bottom action bar:**

| Position | Action | Condition |
|---|---|---|
| Left (primary) | **Start/Restart** | `status === "open"` or `"stopped"` |
| Left (primary) | **Stop** | `status === "active"` |
| Left (primary) | **Reopen** | `status === "closed"` |
| Left (primary) | **Open Chat** | `session_id` exists |
| Right (secondary) | **Delete** (icon-only, 44x44px) | `status !== "closed"` |

Every status therefore offers a way forward — `open` starts, `active` stops,
`stopped` restarts, `closed` reopens — so no status leaves the bar empty. Keep it
that way: a status with no button is a work item the user cannot act on at all.

**Which buttons exist is decided by the status, never by the activity.** A button
that appears and disappears as turns settle is a button the user cannot aim at,
which is exactly how a work stuck in a stale live status became unstoppable.
Stop is shown for every `active` work, including one waiting on its subtasks,
one owing the user an answer and one parked on a background task: `active` means the engine is driving it, and Stop
means stop driving it. What a *confirmation* says may read the activity — by then
the user has aimed, and what they are about to lose depends on what is happening
(docs/lifecycle-ui.md §3).

The delete button uses a subtle style (`text-th-text-muted`) to avoid accidental taps, switching to red (`text-th-error`) on hover to confirm intent. Confirmation dialog appears before deletion.

### CreateWorkSheet

The one creation form, for both a story from the list and a task from a story's
detail. A shared `Sheet` holding the two fields the server requires — title and
role — and nothing else: the description is the brief the agent reads, and its
editor is on the page the user is about to land on.

Which of the two it is creating is the `type` prop, and that prop decides the
sheet's heading and placeholder and nothing more. It is not sent: the request
names a `story_id` or names none, and the server reads the kind off that
([api.md](api.md#method-reference)), so the sheet cannot ask for a kind that
contradicts the story it was opened from.

It reads the agent-role store as **three** states rather than one, because the
subscription is app-wide, starts out loading and returns to loading on every
reconnect: `error` reports the failure, `isLoading` says the roles are still
arriving, and only an empty list that is neither says "No agent roles
registered". Telling a user whose roles are in flight that they have none is the
kind of silent failure the project forbids.

On failure the sheet stays open with the error under the fields and the typed
title intact; on success it hands the new `id` to `onCreated` and leaves closing
and navigating to the caller. It stays `dismissible={false}` while the request is
in flight, and does not release its submit lock on success — the caller closes
it, and releasing early would allow a second work to be created.

### RoleSelect

The one control for choosing an agent role, used by all three places that ask
for one: `CreateWorkSheet`'s Role field, the work detail's Role field, and the
default-role footer of `AgentRoleListOverlay`. It reads the roles from
`useAgentRoleStore` itself, so a caller hands it the stored id and an
`onChange` rather than the list. `emptyLabel` adds a `""` choice under that
label — the `Select role...` placeholder while nothing is picked, or the footer's
`None`, which is a real answer there. An id with no role behind it is shown as
`Unknown role`, never as some other role
([agent-roles-ui.md §7](../agent-roles-ui.md#7-the-default-role-in-words-and-on-a-row)).

### AgentRoleListOverlay

The architecture of this screen and the detail page below it — what each slot
holds and why the controls sit where they do — is
[agent-roles-ui.md](../agent-roles-ui.md); this section describes the components.

Activates `useAgentRoleSubscription`. Each role is a two-line card — name and
default-role star on the first, then its engine, its step count and how many work
items use it — and the whole card opens the detail page. Deleting has one home,
at the bottom of that detail page, rather than a button per row.

Below the list, outside the scroll region so it survives an empty list, a footer
holds the three things that are about the set of roles rather than one of them:
the default-role `RoleSelect` with a line saying what a new story would start with,
the inline "Add Role" form (name only; `role_prompt` is set to empty string), and
Reset to defaults.

### AgentRoleDetailOverlay

Shows detail for a single agent role:
- **Name** — Inline-editable
- **Engine** — Collapsed summary row opening a `ResponsivePanel` with Agent /
  Model / Effort choices (`AgentRoleEngineSelector`)
- **Role Prompt** — Inline-editable textarea with Markdown rendering
- **Steps** — Reorderable list editor
- **Delete** — Confirmation dialog

#### AgentRoleEngineSelector

The summary row and its three-section panel are `components/ui/EngineField.tsx`,
shared with the global defaults in Settings' Session section. It is controlled:
the selected dot follows the value passed in, and the caller supplies the three
`onSelect` callbacks. What goes on the wire differs per caller and so stays out of
the component — a role sends the one field that changed and lets the server clear
the rest ([API](api.md#agent_roleupdate-engine-fields)), while the global defaults
go out as one object and must carry an emptied model and effort with a new agent
([why](../code/agent-integration.md#session-models)). So does what an empty model
means: on a role that sits on the global agent the server fills it in from
Settings, so its Auto row names the inherited value (`From Settings: Opus`)
instead of claiming the CLI decides.

`AgentRoleEngineSelector` is the role-shaped wrapper around it: the
`Follow settings` row that leaves the agent unset, which only a role has
somewhere to defer to, and the inherited descriptions above.

Both callers read the global engine through `hooks/useGlobalEngine.ts`, the
frontend twin of `settings.Settings.Engine` — one page to display it, the other to
tell whether it is on the same agent and therefore inheriting. *Empty agent type
means the built-in default agent* is a rule of the server's that the UI has to
restate to draw an honest row before any write happens; restating it once, in a
hook, is what keeps it from being spelled `?? "claude"` in every panel that asks.

The chat's `EngineSelector` stays separate, deliberately. It is shaped around a
resolved, possibly running session — an agent locked by activation, a CLI that
restarts on a switch — and is replaceable through `chatUIRegistry`, so its props
are an extension contract. Merging it in would mean a component driven by boolean
switches. What it shares is the presentation of a pick-one list,
`components/ui/ChoiceList.tsx` (`Section`, `ChoiceRow`, `SelectionDot`), so the
touch-target floor and the radio semantics of those rows have one definition
rather than several that drift.

All of them read their options from `agentOptionsStore` and none fetches; the
single fetch is `useAgentOptions`, called once in `AppShell`. Selecting applies
immediately — there is no draft to save — and failures are reported inside the
panel, these pages having no channel outside it.
