# Frontend State Management

Pockode uses Zustand for state management, pure reducers for event processing, and a registry pattern for runtime extensibility. This document explains why these patterns were chosen.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Extension Layer                                                │
│  ├─ themeRegistry ──────────────────────────────────────────┐   │
│  ├─ chatUIRegistry                                          │   │
│  ├─ headerUIRegistry           useSyncExternalStore         │   │
│  ├─ sidebarUIRegistry     (React subscription)              │   │
│  └─ settingsRegistry                                        │   │
├─────────────────────────────────────────────────────────────────┤
│  UI State Layer                                                 │
│  ├─ themeStore ◀─────── subscribeThemeRegistry              │   │
│  ├─ inputStore (localStorage)                               │   │
│  ├─ filesSearchStore (localStorage)                         │   │
│  ├─ gitPanelStore                                           │   │
│  ├─ gitSyncStore                                            │   │
│  └─ worktreeStore + listeners                               │   │
├─────────────────────────────────────────────────────────────────┤
│  Domain Data Layer                                              │
│  ├─ sessionStore ◀───┬── wsStore notifications              │   │
│  ├─ workStore        │                                      │   │
│  ├─ agentRoleStore   │                                      │   │
│  ├─ agentOptionsStore│ (one fetch per connection)           │   │
│  ├─ settingsStore    │                                      │   │
│  └─ authStore        │                                      │   │
├─────────────────────────────────────────────────────────────────┤
│  Transport Layer                                                │
│  └─ wsStore                                                     │
│     ├─ WebSocket lifecycle                                      │
│     ├─ JSON-RPC client                                          │
│     └─ Subscription callbacks                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Zustand Stores

### Store Inventory

| Store | Purpose | Key Pattern |
|-------|---------|-------------|
| wsStore | WebSocket, RPC, subscriptions | Single hub for all communication |
| sessionStore | Chat session list, as the server narrowed it | State/Actions interface split; an absence in it is not proof a session is gone ([why](subscription-system.md#what-the-client-gives-up-by-letting-the-server-filter)) |
| sessionDetailStore | The open session's own metadata, and whether it exists at all | One session at a time, read through a selector that checks whose it is |
| workStore | Work list rows | State/Actions interface split |
| agentRoleStore | AI roles | State/Actions interface split |
| agentOptionsStore | Selectable models and effort levels per agent | Fetched once per connection, not subscribed |
| settingsStore | App settings, and why they are missing when they are | Holds the subscription's `refresh` too: the Retry is far below the hook that owns it |
| authStore | Auth token | localStorage init |
| inputStore | Draft text, per session | persist middleware |
| filesSearchStore | File search options | localStorage init |
| gitPanelStore | Git panel UI state (History expanded) | Session-scoped override |
| gitSyncStore | The fetch/pull/push in flight in each worktree, and how the last one ended | Keyed by worktree; outlives the sheet that started the run |
| worktreeStore | Current worktree, and whether the server can run the setup hook | External listener pattern |
| themeStore | Theme mode/name | Registry subscription |

### Why wsStore is Large

wsStore manages WebSocket connection, JSON-RPC channels, and subscription callbacks in one place. This is intentional:

1. **Connection lifecycle is atomic** — connect/disconnect must be coordinated with all subscriptions
2. **RPC channel is a resource** — cannot be duplicated across stores
3. **Notification routing needs global view** — must know all callbacks to dispatch

The alternative (each store managing its own connection) would lead to duplicate connections and lifecycle conflicts.

Reconnect policy lives here too — an unbounded backoff retry rather than a fixed
attempt count, because the connection may be a relay tunnel the server itself
takes the better part of a minute to notice is dead. See
[websocket-rpc.md](websocket-rpc.md#auto-reconnect).

### Store Patterns

**Pattern A: State/Actions Interface Split** — Most domain stores use this pattern for type safety:

```typescript
interface SessionState {
  sessions: SessionListItem[];
  isLoading: boolean;
  // Set during a worktree switch: sessions are retained but marked stale, so the
  // sidebar can go on rendering them without letting the user act on a list that
  // belongs to the worktree being left.
  isReloading: boolean;
}
interface SessionActions { setSessions(s: SessionListItem[]): void; }
export type SessionStore = SessionState & SessionActions;
```

**Pattern B: Listener Pattern** — worktreeStore uses external listeners for non-React contexts:

```typescript
// web/src/lib/worktreeStore.ts (abridged)
const changeListeners = new Set<WorktreeChangeListener>();

export const worktreeActions = {
  setCurrent: (name: string) => {
    // Synchronously notify listeners before React re-renders
    for (const listener of changeListeners) listener(prev, name);
  },
  onWorktreeChange: (listener) => {
    changeListeners.add(listener);
    return () => changeListeners.delete(listener);
  },
};
```

wsStore subscribes to these listeners to clean up worktree-scoped subscriptions before worktree switch completes — React's async rendering would be too late. App-level subscriptions (work list/detail, agent role list, settings, worktree list) are preserved across switches because the server keeps pushing to them.

**Pattern C: Registry Subscription** — themeStore subscribes to themeRegistry changes:

```typescript
// web/src/lib/themeStore.ts — themeActions.init
subscribeThemeRegistry(() => {
  const { theme: current, mode } = useThemeStore.getState();
  if (isValidTheme(current)) {
    // Apply when pending custom theme becomes available
    applyThemeToDOM(mode, current);
    return;
  }
  // Fallback if active theme was unregistered
  useThemeStore.setState({ theme: "abyss" });
});
```

### Why a Store for Panel UI State

`gitPanelStore` holds one field — whether the Git panel's `History` group is
expanded — which looks like a case for `useState` in `DiffTab`. It is in the
store instead, because **the decision has to outlive the component, and how long
the component lives is not this panel's to decide.**

Today it usually survives: `TabbedSidebar` renders all four tabs at once and
each hides itself with a class, and the drawer form does the same (`Sidebar`
says why — CSS hiding preserves scroll position). But that is a layout
implementation detail, not a contract, and it does not hold everywhere:
crossing the `expanded` breakpoint (1024) swaps `Sidebar` between two structurally
different trees and remounts everything inside, and an extension that registers
`SidebarContent` replaces the tabbed sidebar outright. Component state would
quietly revert the user's explicit choice in exactly those cases, and would
break the moment someone changes a tab from `hidden` to conditional
rendering.

The field is `boolean | null`, not `boolean`. `null` means "still following the
change count" and a boolean means "the user has decided"; `useHistoryExpanded`
resolves it as `override ?? changeCount === 0`. Storing the resolved boolean
instead would erase the difference between a default that happens to be
collapsed and a user who chose collapsed — and a section that keeps re-deciding
for someone who has already decided is worse than one occasionally in the wrong
state.

It is deliberately **not** persisted. The default is derived from the working
tree, which is where the answer usually comes from; a stale choice restored
across restarts would outlive the situation that produced it. See
[git-ui.md](../git-ui.md#history).

### Why Scroll State Is Neither a Store nor State

The transcript's scroll decisions — whether the tail is being followed, whether
the last scroll was the user's, the anchor a page is being restored against,
whether paging has stopped — live in refs inside `MessageList`
(`web/src/components/Chat/MessageList.tsx`), and that is the exact opposite of
the reasoning above.

They are not in a store because **they must not outlive the component**. The
list is keyed by the session id and remounts on every switch, and every one of
these values describes a view that no longer exists once it does; a store would
carry "the user had scrolled up" into a session they have not looked at yet.
Where `gitPanelStore` holds a decision the user made, these hold facts about a
layout.

They are refs rather than `useState` because **nothing should re-render when
they change**, and more than that: they are read at moments a render cannot
reach. The follow intent is read inside a layout effect and inside a
`ResizeObserver` callback, against the DOM as it is at that instant. A state
update would deliver the new value a render later — after the frame whose scroll
position was the whole question — and would reflow the very list being measured.

What is state in that component marks the boundary. Whether the
scroll-to-bottom button is showing is state because it is something drawn;
`sentinelArmKey` is state for the less obvious version of the same reason — it
exists to re-run the effect that observes the paging sentinel, and a re-render
is the only way to get an effect to run again. Something is state when a render
has to happen because of it; the rest of this is bookkeeping the render must not
see.

## Server Cache vs Store

Not every piece of server data belongs in a store. Data the client fetches
request/response — directory contents, git status, commit diffs, file search
results — lives in the react-query cache instead, so staleness, in-flight state
and deduplication come with it rather than being re-implemented per store.
Stores hold what the app itself owns (UI preferences) and what arrives as a
stream of subscription notifications. A watcher notification and a cached query
compose: `*.changed` says something moved, and the query refetches.

One fetch sits outside both: `agent.list`, which reports what each registered
agent declares about being forked. Its answer comes from the implementations
compiled into the server, so it cannot change while that server runs — there is
no staleness to manage and nothing to invalidate, and `lib/rpc/agent.ts` caches
the promise for the tab instead. That hand-rolled cache is the price, and it is
only worth paying for a value that is constant by construction; anything that can
change server-side belongs in react-query with the rest.

The catch is scope: those caches are keyed by query key, not by worktree, so
`queryClient.ts` invalidates every key in `WORKTREE_DEPENDENT_QUERY_KEYS` once a
switch completes. A worktree-scoped query missing from that list keeps serving
the previous worktree's data — paths that look fine until they 404 on open —
and it is the easy step to forget when adding a query.

`agentOptionsStore` is the one store filled by a plain request/response call. The
per-agent model and effort lists are constants compiled into the server, so
nothing react-query manages applies to them: they cannot go stale, no
notification invalidates them, a single hook asks for them, and being server-wide
they are untouched by a worktree switch. The one thing that can change the answer
is a reconnect to a server upgraded in the meantime, which `useAgentOptions`
covers by fetching on every `connected` rather than once per app load.

The fetch hangs off `AppShell` rather than off the panel that needs it because
three screens now read the same lists: the chat's engine selector, the agent role
page, and the global defaults in Settings. Each of them also needs the lists of
the agent it is *about to* switch to, not only the current one, so per-panel
fetching would buy nothing and cost a round trip per open.

Both lists sit in that one store behind a **single** `error`, and
`useAgentOptions` fetches them in one `Promise.allSettled`, even though the
server answers them as two methods (`session.models`, `session.efforts`). That is
not tidying. *This agent has no effort levels* and *the effort list never
arrived* reach the selector as the same absence, and the only thing that tells
them apart is whether an answer arrived at all — so that question must have one
answer, not one per list. It does: *nothing has answered yet* is exactly
`models === null && error === null`, a failed fetch counting as an answer. A list
that did arrive is still kept when the other one failed; losing it would punish
the working half for the broken one.

## Message Reducer

`messageReducer.ts` is a pure function (not a store) that transforms server events into message state. This separation enables history replay, unit testing, and flexible composition.

### Data Flow

```
ServerNotification (snake_case)
  → normalizeEvent() → NormalizedEvent (camelCase)
    → applyServerEvent() → Message[]
      → Component state (via useSubscription hook)
```

### Message Variants

`Message` is exactly `UserMessage | AssistantMessage`. Pockode's own annotations
— the prompts the Work engine sends — are not a third variant: they are user
messages tagged `source: "system"`, rendered as a collapsed line instead of a
bubble (see
[work-system.md](work-system.md#rendering-in-the-transcript) for why the
transcript holds no aggregate of them).

The consequence to know before touching the reducer: **`status` is not a common
field.** Only assistant messages carry one, so anything asking about it has to
narrow on `role === "assistant"` first.

### Turn Boundaries and Late Events

A turn starts from a `message` event and ends on `done` / `interrupted` /
`error` / `process_ended`, leaving its message at the matching status
(`complete` for `done`). Every prompt is persisted and broadcast by the
server, so the client always sees the `message` that opens a turn — and a turn
cut short takes its pending permission and question dialogs down with it, so no
answer can resume it either. That makes the rule for content arriving after an
ending unambiguous: it belongs to the turn that just ended.

That matters because the CLI keeps talking for a moment after a turn is cut
short — a Task subagent's last output is the usual source. Such content is
appended to the ended message and leaves its status alone; without that it
would open a fresh `streaming` bubble under a turn the user has already stopped.
The composer no longer infers liveness from it — `turnOpen` reads the session's
own turn ([lifecycle-ui.md](../lifecycle-ui.md#23-chat-composer-and-stop)) — but
the transcript still shows what it is given, and two bubbles for one turn is a
transcript that disagrees with itself about when the turn ended.

The same lateness decides where a fork can cut. A message carries the `anchorSeq`
of the last history record folded into it, and the reducer stamps it on the
newest message only — `applyServerEvent` is the one path both replayed
history and live notifications take, so the two cannot disagree about where a
cut lands. A record that lands in an earlier message goes unstamped rather than
raise that message's anchor past the messages below it, which would quietly move
the cut past messages the user can see: they point at a bubble, and the fork
would cut somewhere later than the bubble they pointed at. The client is free
to leave records unaddressable because it only anchors on ones the server gave it
a seq for; what it must never do is number them itself, or do arithmetic on the
numbers it was given — where the cut falls relative to the anchor is the server's
answer, not the client's ([session-fork-ui.md](../session-fork-ui.md#the-rule),
[agent-integration.md](agent-integration.md#history-storage)).

`complete` is deliberately excluded from that rule: when a background wait runs
out of budget Pockode delivers the `done` itself
([agent-integration.md](agent-integration.md#background-waits)), and output
resuming afterwards is a genuinely live turn.

History arrives one page at a time, so a turn can also be cut in two by a page
boundary rather than by an ending. The halves are rejoined where the pages meet
([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client)), and the joined
message keeps the newer half's anchor: it names the later record, which is where
a fork of the joined message has to cut. The older half's anchor stands in only
when the newer one never got one, a message without an anchor being one the user
cannot fork from at all.

### Tool Runs

Every tool call in a turn — a `Bash`, a `Read`, a subagent — is one
`{ type: "tool_call" }` part holding a `ToolRun`, appended where its `tool_call`
landed, so a call reads at the point in the turn that made it. Nothing groups
them: a summary across several calls can only restate what the individual rows
already say, and it costs the one thing a transcript is for, which is knowing
when each thing happened.

A subagent call is not a second shape. It *is* a tool call — Claude even carries
its `tool_use_id` on the task lifecycle frames — and keeping a `TaskRun` beside
`ToolRun` meant two status machines and two settle-on-interrupt paths for one
thing. `TaskItem` stays, as the renderer for that category, and its three extra
fields (`description`, `subagent_type`, `prompt`) are derived from `input` the
way every other row's title is ([tool-call-model.md](../tool-call-model.md)).

**One part per `tool_use_id`.** A `permission_request` *takes the place* of the
`tool_call` part it names, rather than sitting beside it: while the user is
deciding, the machine is waiting for *them*, and a row spinning above the card
would say the opposite. The same join `ask_user_question` makes, for the same
reason — all of it describes one tool use.

**A card the user has not answered is that call's row**, whichever order the
two arrive in: Claude announces the call and then asks (the card replaces the
row), while Codex may ask before it announces the item at all (the call adds no
row of its own). Either way nothing about the call is drawn as running while it
is waiting for a person.

Taking the row's place means the reducer has to be able to give it back, and
that is the half worth reading before changing any of it. Measured against
claude 2.1.263: the `tool_call` arrives **before** the approval request, and is
**not** re-sent after approval. So once the card has replaced it, the card is
all that is left of the call — and a `tool_result` matching no row would be
dropped as an orphan, which is the command's entire output gone. So a record
naming a call with no row rebuilds one from what the card itself carries — the
same input the call announced, since that is where the server got it — and puts
it directly under the card, which is where it was. Two rules keep that honest:

- An existing row **anywhere** in the transcript wins over rebuilding one, so a
  call can never end up drawn twice.
- A result rebuilds from a card in any state — the engine has acted, and a
  denial's refusal text lands as an ordinary settled run under the card that
  already said why — but **progress only rebuilds from a card the user has
  answered**. Nothing about a call may spin while the card is still pending.

(Some CLIs do re-send the `tool_call` after approval. That path still draws one
row: the resend finds no part left to update and appends the row itself, and
everything after it behaves the same.)

The part holds the run's **current status** — `running` / `background` /
`success` / `error` / `interrupted` — and the reducer is its only author; the UI
renders that status and infers nothing of its own. The rules that keep it
honest:

- **Status is derived, never sent.** A call with no result is `running`;
  `success` / `error` come from the `is_error` already on the wire. No status
  field was added to `EventRecord`, because every input to the derivation is a
  record the client already has.
- **A backgrounded call is not a finished one.** Its first result is the
  placeholder the agent read, recorded with `subtype: "background_started"`, and
  a run whose newest result carries that subtype is `background` — running, with
  a badge. Without the subtype a replayed transcript would show work still going
  as successfully completed. The `background_result` record supersedes it and
  settles the run; both are kept, because the placeholder is what the *agent*
  read and the outcome is what *happened*. A third subtype, `background_lost`,
  is the outcome Pockode writes itself when the CLI process died with the work
  still running: it settles the run as `error` like any failed outcome, and the
  record says who authored it
  ([tool-call-model.md](../tool-call-model.md#a-third-subtype-with-a-different-author)).
- A turn that ended as `interrupted` / `error` / `process_ended` settles the
  runs still `running` in it: nothing can report back on them, and a spinner
  that never stops is a lie. The rule keys on the turn's resulting **status**,
  not on the event, so a call whose `tool_call` trails in after the ending is
  settled too rather than born spinning forever. `complete` is deliberately
  excluded — background work outlives the turn that started it
  ([agent-integration.md](agent-integration.md#background-waits)) — and so is
  `background`, for the same reason.
- Replay adds no settling of its own — it feeds history through this same
  reducer — so a call still running at the end of a history stays running,
  which is right while the session is live. A process killed while Pockode was
  down normally *is* in the history — the session store writes the
  `process_ended` the killed run never got to
  ([agent-integration.md](agent-integration.md#restart-repair)) — but the client
  does not rely on that record being there, because a session stored by a build
  from before that repair existed has none. The session's `turn` is the
  authority those records are missing: `settleAgainstTurn` runs over the page a
  subscription returns, and `retireAgainstTurn` — the half of it that claims
  nothing about *when* the turn ended — over every older page pulled in after
  ([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client),
  [lifecycle-ui.md](../lifecycle-ui.md#24-recovering-a-dangling-turn-after-a-restart)).
  It settles three things at once and each on its own condition: a bubble still
  `streaming` while the turn is not running, a pending card the turn does not
  list as a blocker — a card it *does* list is still answerable and is left
  alone — and a call still running once the turn is idle.
- An interrupted run whose result finally arrives keeps its `interrupted`
  status. The content is kept and readable; what it cannot do is make the UI
  claim the call finished normally. No flag records that it came back late —
  `interrupted` with a result *is* that case, and a second field saying so could
  only fall out of step. This is the "events are events, state is state" rule
  applied to a single part.

Failure comes from the CLI's `is_error` flag
([agent-integration.md](agent-integration.md#eventrecord-unified-event-format)),
never from the result text. So `error` means the *call* failed — an unknown
`subagent_type`, a command that exited non-zero. A subagent that ran fine and
reported that it could not do the job is `success`, and the report says the
rest; the UI does not get to grade it.

#### Live state on a run

Two of a run's fields do not come from history and cannot: `activity` (the
latest one-line status) and `output` (the deltas a streaming engine sends,
accumulated client-side). They arrive as `tool_activity`, which is broadcast and
never persisted — a progress line is a *latest value*, and a snapshot of one in
the transcript becomes a lie the moment the next one arrives
([agent-event.md](../agent-event.md#what-is-not-an-event)).

Three consequences the reducer encodes:

- **A replayed run has neither, and is still correct**, because `status` carries
  "still going" on its own. This is the whole reason status is derived from
  persisted records while progress is not.
- **Progress is ignored on a settled run.** `useChatMessages` coalesces updates
  to one animation frame — deltas can arrive faster than the screen refreshes —
  so one held back may be applied after the result. A progress line under a
  finished row is worse than a moment of missing liveness.
- **An empty update leaves the last line standing**, and the accumulation is
  capped at its last lines. A line that blinks in and out re-flows every row
  below it, and a build that printed ten thousand lines is not ten thousand DOM
  nodes.

A client that subscribes mid-run has missed everything it was not listening for,
and on a phone that is the normal case. `chat.messages.subscribe` therefore
returns the newest activity per call still in flight, which is applied over the
replayed transcript ([agent-chat.md](../agent-chat.md)).

`seenAt` is the third live-only field and exists for the same reason in reverse:
a history record carries no timestamp, so the only clock a client has is when it
received something. That is right for a call it watched start and meaningless
for one it replayed, so the reducer stamps it only for events that arrived live,
and an elapsed counter is drawn only where it is set. A duration that *replays*
is a different thing entirely: it is `durationMs`, reported as data by Codex and
not at all by Claude, and it is never inferred from arrival times.

### Why Pure Function Instead of Store

- **Reusable** — same reducer replays history and processes live events
- **Testable** — pure `(Message[], Event) → Message[]` tests
- **Composable** — integrates into any hook without store coupling

If message processing were a store, each session would need its own store instance, making history replay awkward.

### Immutability Optimization

The reducer avoids unnecessary copies — only changed messages get new references:

```typescript
// web/src/lib/messageReducer.ts (simplified)
function updatePermissionRequestStatus(messages, requestId, newStatus) {
  let anyChanged = false;
  const updated = messages.map((msg) => {
    // ... check if this message needs update
    if (!changed) return msg;  // Return original reference
    anyChanged = true;
    return { ...msg, parts: updatedParts };
  });
  return anyChanged ? updated : messages;  // Return original array if nothing changed
}
```

React.memo benefits from reference stability — unchanged messages don't trigger re-renders.

## Extension System

Extensions register capabilities at runtime via `ExtensionContext`:

```typescript
// web/src/lib/extensions.ts
export interface ExtensionContext {
  readonly settings: { register(config: SettingsSectionConfig): void };
  readonly chatUI: { configure(config: Partial<ChatUIConfig>): void };
  readonly headerUI: { configure(config: Partial<HeaderUIConfig>): void };
  readonly sidebarUI: { configure(config: Partial<SidebarUIConfig>): void };
  readonly theme: { register(name: string, info: ThemeInfo, css: string): void };
}
```

### Disposables Pattern

Each context tracks cleanup functions automatically:

```typescript
// web/src/lib/extensions.ts
function createContext(extensionId: string): InternalContext {
  const disposables: Array<() => void> = [];

  return {
    settings: {
      register(config) {
        const unregister = registerSettingsSection(namespaced);
        disposables.push(unregister);  // Auto-cleanup on unload
      },
    },
    dispose() {
      for (const fn of disposables) fn();
    },
  };
}
```

When `unloadExtension(id)` is called, all registered resources are cleaned up.

### Extension Loading

Extensions are auto-discovered via Vite's glob import:

```typescript
// web/src/lib/extensions.ts — loadAllExtensions
const modules = import.meta.glob<ExtensionModule>(
  "../extensions/*/index.ts",
  { eager: true },
);
```

## Registry Pattern

Registries provide runtime extensibility with React integration via `useSyncExternalStore`.

### Common Structure

All registries follow this pattern:

```typescript
let state = ...;
const listeners = new Set<() => void>();

function notifyListeners() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useXxxRegistry() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
```

### Theme Registry Example

```typescript
// web/src/lib/registries/themeRegistry.ts
export function registerTheme(name, info, css): () => void {
  // Immutable update for React change detection
  customThemes = new Map(customThemes);
  customThemes.set(name, info);
  injectThemeCSS(name, css);
  notifyThemeListeners();

  return () => {  // Unregister function
    customThemes = new Map(customThemes);
    customThemes.delete(name);
    removeThemeCSS(name);
    notifyThemeListeners();
  };
}
```

Built-in themes are typed (`ThemeName`), custom themes are runtime-registered.

### ChatUI Registry

Allows extensions to replace UI components:

```typescript
// web/src/lib/registries/chatUIRegistry.ts
export interface ChatUIConfig {
  UserAvatar?: ComponentType<AvatarProps>;
  AssistantAvatar?: ComponentType<AvatarProps>;
  InputBar?: ComponentType<InputBarProps>;
  ModeSelector?: ComponentType<ModeSelectorProps> | null;  // null hides it
  EngineSelector?: ComponentType<EngineSelectorProps> | null;  // agent + model + effort chip
  // ...
}
```

Components check the registry and fall back to defaults:

```tsx
const config = useChatUIConfig();
const Avatar = config.UserAvatar || DefaultAvatar;
```

## Subscription Hook

`useSubscription` manages WebSocket subscription lifecycle:

```typescript
// web/src/hooks/useSubscription.ts
export function useSubscription<TNotification, TInitial>(
  subscribe: (callback) => Promise<{ id: string; initial?: TInitial }>,
  unsubscribe: (id: string) => Promise<void>,
  onNotification: (params: TNotification) => void,
  options: SubscriptionOptions<TInitial>,
)
```

Key features:

1. **Generation counter** — prevents race conditions when multiple subscribes overlap
2. **Worktree switch handling** — the server invalidates worktree-scoped subscriptions on switch, so the hook resubscribes. Rather than clearing data (`onReset`), a switch is a soft refresh: previous data stays on screen and is swapped out by `onSubscribed` when the new worktree's snapshot arrives (see [subscription-system.md](subscription-system.md#why-worktree-switch-is-a-soft-refresh-not-a-reset))
3. **Connection state** — resets on disconnect, but deliberately keeps data during `reconnecting` and resubscribes once the connection is back
4. **Nothing lost while opening** — the callback is registered under the client-generated id before the request goes out, and notifications arriving before the initial snapshot is applied are held and replayed after it (see [subscription-system.md](subscription-system.md#why-nothing-is-lost-while-a-subscription-is-being-opened))
5. **A snapshot handler that throws is reported apart from a failed subscribe** — by the time `onSubscribed` and the replay run, the subscription is open and stays open, so an exception there recovers the same way (`onError`, else `onReset`) but is reported in its own sentence instead of as `Subscription failed`, which would send the reader looking for a network fault that is not there (see [subscription-system.md](subscription-system.md#why-a-throwing-snapshot-handler-is-reported-separately))

## Key Files

| File | Purpose |
|------|---------|
| `web/src/lib/wsStore.ts` | WebSocket + RPC + subscription management |
| `web/src/lib/queryClient.ts` | react-query setup + worktree-dependent invalidation |
| `web/src/lib/messageReducer.ts` | Event → Message state transformation |
| `web/src/lib/extensions.ts` | Extension loading and context creation |
| `web/src/lib/registries/*.ts` | Runtime registries for themes, UI, settings |
| `web/src/lib/*Store.ts` | Domain data stores |
| `web/src/lib/gitPanelStore.ts` | Git panel UI state that must outlive remounts |
| `web/src/lib/worktreeQuery.ts` | Worktree list query key + fetcher, kept together |
| `web/src/hooks/useSubscription.ts` | Subscription lifecycle hook |
| `web/src/lib/valueState.ts` | Stored / still coming / not coming, named once for every control that waits on a snapshot ([why three states](subscription-system.md#why-the-controls-wait-for-the-session-to-describe-itself)) |

`worktreeQuery.ts` exists because two hooks (`useWorktree`, `useWorktreeDisplay`)
read the same react-query cache entry. Key and fetcher living in separate files
let each hook write its own fetcher, and the moment the response shape changed the
two disagreed about what that cache entry holds. Keeping them in one module makes
"same entry, same shape" a property of where the code is, not of everyone
remembering.
