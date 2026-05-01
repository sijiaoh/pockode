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
│  └─ worktreeStore + listeners                               │   │
├─────────────────────────────────────────────────────────────────┤
│  Domain Data Layer                                              │
│  ├─ sessionStore ◀──┬── wsStore notifications               │   │
│  ├─ workStore       │                                       │   │
│  ├─ agentRoleStore  │                                       │   │
│  ├─ settingsStore   │                                       │   │
│  └─ authStore       │                                       │   │
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
| sessionStore | Chat session list | State/Actions interface split |
| workStore | Work items | State/Actions interface split |
| agentRoleStore | AI roles | State/Actions interface split |
| settingsStore | App settings | State/Actions interface split |
| authStore | Auth token | localStorage init |
| inputStore | Draft text | persist middleware |
| worktreeStore | Current worktree | External listener pattern |
| themeStore | Theme mode/name | Registry subscription |

### Why wsStore is Large (858 lines)

wsStore manages WebSocket connection, JSON-RPC channels, and subscription callbacks in one place. This is intentional:

1. **Connection lifecycle is atomic** — connect/disconnect must be coordinated with all subscriptions
2. **RPC channel is a resource** — cannot be duplicated across stores
3. **Notification routing needs global view** — must know all callbacks to dispatch

The alternative (each store managing its own connection) would lead to duplicate connections and lifecycle conflicts.

### Store Patterns

**Pattern A: State/Actions Interface Split** — Most domain stores use this pattern for type safety:

```typescript
interface SessionState { sessions: SessionListItem[]; isLoading: boolean; }
interface SessionActions { setSessions(s: SessionListItem[]): void; }
export type SessionStore = SessionState & SessionActions;
```

**Pattern B: Listener Pattern** — worktreeStore uses external listeners for non-React contexts:

```typescript
// web/src/lib/worktreeStore.ts:16-21
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

wsStore subscribes to these listeners to clean up subscriptions before worktree switch completes — React's async rendering would be too late.

**Pattern C: Registry Subscription** — themeStore subscribes to themeRegistry changes:

```typescript
// web/src/lib/themeStore.ts:121-142
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

## Message Reducer

`messageReducer.ts` is a pure function (not a store) that transforms server events into message state. This separation enables history replay, unit testing, and flexible composition.

### Data Flow

```
ServerNotification (snake_case)
  → normalizeEvent() → NormalizedEvent (camelCase)
    → applyServerEvent() → Message[]
      → Component state (via useSubscription hook)
```

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
// web/src/lib/extensions.ts:26-45
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
// web/src/lib/extensions.ts:56-101
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
// web/src/lib/extensions.ts:146-150
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
// web/src/lib/registries/themeRegistry.ts:118-144
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
// web/src/lib/registries/chatUIRegistry.ts:40-67
export interface ChatUIConfig {
  UserAvatar?: ComponentType<AvatarProps>;
  AssistantAvatar?: ComponentType<AvatarProps>;
  InputBar?: ComponentType<InputBarProps>;
  ModeSelector?: ComponentType<ModeSelectorProps> | null;  // null hides it
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
// web/src/hooks/useSubscription.ts:45-52
export function useSubscription<TNotification, TInitial>(
  subscribe: (callback) => Promise<{ id: string; initial?: TInitial }>,
  unsubscribe: (id: string) => Promise<void>,
  onNotification: (params: TNotification) => void,
  options: SubscriptionOptions<TInitial>,
)
```

Key features:

1. **Generation counter** — prevents race conditions when multiple subscribes overlap
2. **Worktree switch handling** — server resets worktree-scoped subscriptions on switch, hook resubscribes automatically
3. **Connection state** — triggers reset on disconnect, resubscribes on reconnect

## Key Files

| File | Purpose |
|------|---------|
| `web/src/lib/wsStore.ts` | WebSocket + RPC + subscription management |
| `web/src/lib/messageReducer.ts` | Event → Message state transformation |
| `web/src/lib/extensions.ts` | Extension loading and context creation |
| `web/src/lib/registries/*.ts` | Runtime registries for themes, UI, settings |
| `web/src/lib/*Store.ts` | Domain data stores |
| `web/src/hooks/useSubscription.ts` | Subscription lifecycle hook |
