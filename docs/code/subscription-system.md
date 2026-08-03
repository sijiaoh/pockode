# Subscription System

This document explains the design decisions behind Pockode's real-time subscription system. For the architecture overview and API reference, see [docs/watcher.md](../watcher.md).

## Core Design Decisions

### Why Channel-Based Event Processing?

Event-driven watchers (WorkList, SessionList, etc.) use async buffered channels instead of directly notifying subscribers in the store callback:

```go
// server/watch/work_list.go:135-143
func (w *WorkListWatcher) OnWorkChange(event work.ChangeEvent) {
    select {
    case <-w.Context().Done():
        return
    case w.eventCh <- event:
    default:
        w.dirty.Store(true)
        slog.Warn("work list change event dropped...")
    }
}
```

**Rationale:**

1. **Deadlock prevention**: Store callbacks may be called while holding the store's mutex. If the watcher tried to notify subscribers synchronously, and notification involves acquiring other locks, deadlock could occur.

2. **Non-blocking stores**: Store operations should be fast. Offloading notification to a separate goroutine keeps write latency predictable.

3. **Backpressure isolation**: When notification is slow (network issues), the store isn't affected.

### Why Backpressure via Dirty Flag Instead of Blocking?

When the event channel is full, we drop events but set a `dirty` flag:

```go
// server/watch/work_list.go:40-52
func (w *WorkListWatcher) eventLoop() {
    for {
        select {
        case <-w.Context().Done():
            return
        case event := <-w.eventCh:
            if w.dirty.Swap(false) {
                w.notifySync()  // Full sync
            } else {
                w.notifyChange(event)  // Incremental
            }
        }
    }
}
```

**Rationale:**

1. **Eventual consistency over ordering**: For UI state, having the correct final state matters more than replaying every intermediate state. A full sync after buffer overflow guarantees clients converge to correct state.

2. **Bounded memory**: Fixed channel buffers (16–256) prevent unbounded growth during bursts.

3. **Self-healing**: No manual intervention needed. The system automatically recovers by sending a full state snapshot.

### Why Reference Counting in FSWatcher?

Multiple subscriptions can watch the same path, but fsnotify should only monitor it once:

```go
// server/watch/fs.go:84-94
if w.pathRefCount[path] == 0 {
    if err := w.watcher.Add(fullPath); err != nil {
        w.pathMu.Unlock()
        return "", err
    }
}
w.pathToIDs[path] = append(w.pathToIDs[path], id)
w.idToPath[id] = path
w.pathRefCount[path]++
```

**Rationale:**

1. **OS resource efficiency**: Each fsnotify watch consumes a file descriptor. Multiplexing avoids hitting OS limits.

2. **Consistent behavior**: All subscribers to the same path receive identical notifications.

3. **Clean teardown**: Unsubscribe decrements the count; the watch is only removed when the last subscriber leaves.

### Why 100ms Debounce for FSWatcher?

File changes often come in bursts (editor save, build tools, git operations):

```go
// server/watch/fs.go:14
const debounceInterval = 100 * time.Millisecond

// server/watch/fs.go:165-175
w.timerMap[relPath] = time.AfterFunc(debounceInterval, func() {
    w.notifyPath(relPath)
    w.timerMu.Lock()
    delete(w.timerMap, relPath)
    w.timerMu.Unlock()
})
```

**Rationale:**

1. **Noise reduction**: Editors often write to temp files then rename. Raw fsnotify events would trigger multiple notifications for a single logical change.

2. **Network efficiency**: Fewer notifications mean less WebSocket traffic, important for mobile clients.

3. **100ms balance**: Fast enough for interactive response, slow enough to coalesce burst writes.

### Why Polling for Git Instead of fsnotify?

GitWatcher uses 3-second polling instead of watching `.git` directory:

```go
// server/watch/git.go:14
const gitPollInterval = 3 * time.Second
```

**Rationale:**

1. **Reliability**: Git internal file changes are complex (packed refs, loose objects, index updates). fsnotify would require deep Git knowledge to interpret correctly.

2. **Cross-platform consistency**: Git behavior varies across platforms; polling `git status` works everywhere.

3. **Simplicity**: Two commands (`rev-parse HEAD` + `status --porcelain`) capture all relevant state.

4. **Skip when idle**: Polling only runs when there are subscribers, so no overhead when unused.

### Why Parallel Git Commands?

```go
// server/watch/git.go:101-115
var head, status string
var wg sync.WaitGroup
wg.Add(2)

go func() {
    defer wg.Done()
    head = w.runGitCmd(ctx, "rev-parse", "HEAD")
}()

go func() {
    defer wg.Done()
    status = w.runGitCmd(ctx, "status", "--porcelain=v1", ...)
}()

wg.Wait()
```

**Rationale:** Each git command may take 50–200ms on large repos. Running them in parallel halves the polling latency.

### Why Parent Directory Notification in FSWatcher?

```go
// server/watch/fs.go:186-193
ids := append([]string{}, w.pathToIDs[changedPath]...)
if changedPath != "" {
    parent := filepath.Dir(changedPath)
    if parent == "." {
        parent = ""
    }
    ids = append(ids, w.pathToIDs[parent]...)
}
```

**Rationale:** Directory listings need to update when files inside them change. Instead of requiring separate watches on both file and directory, FSWatcher automatically notifies parent directory subscribers.

## Frontend: useSubscription Hook

### Why Generation Counter?

```typescript
// web/src/hooks/useSubscription.ts:78-98
const doSubscribe = useCallback(async () => {
    const generation = ++generationRef.current;
    const isStale = () => generationRef.current !== generation;

    if (subscriptionIdRef.current) {
        await unsubscribe(subscriptionIdRef.current);
    }

    if (isStale()) return;

    const result = await subscribe((params) => {
        if (isStale()) return;
        onNotificationRef.current(params);
    });

    if (isStale()) {
        await unsubscribe(result.id);
        return;
    }
    // ...
}, [subscribe, unsubscribe]);
```

**Rationale:**

1. **React strict mode**: Component may mount/unmount rapidly during development.
2. **Worktree switches**: User can switch worktrees while a subscription is in flight.
3. **Connection changes**: Reconnection may trigger re-subscription while old one is pending.

The generation counter ensures only the latest subscription attempt succeeds. Stale subscriptions are immediately cleaned up.

### Why Worktree Switch Is a Soft Refresh, Not a Reset

```typescript
// web/src/hooks/useSubscription.ts:153-164
const cleanupSwitchStart = resubscribeOnWorktreeChange
    ? worktreeActions.onWorktreeSwitchStart(() => {
        // Soft refresh: drop the old subscription but keep data on screen.
        // onSubscribed replaces it once the new worktree's data arrives.
        invalidate();
        onWorktreeSwitchRef.current?.();
    })
    : undefined;

const cleanupSwitchEnd = resubscribeOnWorktreeChange
    ? worktreeActions.onWorktreeSwitchEnd(doSubscribe)
    : undefined;
```

**Rationale:** Server-side worktree-scoped subscriptions (file, git, session) are invalidated when the client switches worktrees, so the hook must resubscribe. The naive teardown — `invalidate()` + `onReset` on switch start, resubscribe on switch end — made the switch feel heavy: clearing worktree-scoped data mid-switch dropped every affected view to a loading state until the new worktree's snapshot arrived.

The most damaging case was the session list. Clearing it made `currentSession` disappear, which sent the whole `AppShell` into its full-screen "Loading..." branch — so every switch flashed the app blank and re-rendered from scratch.

So switch start no longer calls `onReset`. Instead:

1. **onSwitchStart**: `invalidate()` cancels the stale subscription (bumps the generation counter so late notifications are ignored) but leaves the previous data on screen. The optional `onWorktreeSwitch` callback lets a consumer mark that data as "reloading" without clearing it.
2. **onSwitchEnd**: `doSubscribe()` resubscribes; `onSubscribed` swaps in the new worktree's snapshot when it arrives.

`onReset` is now reserved for teardown where the data is genuinely untrustworthy — disable, disconnect, or a failed (re)subscribe. Consumers that don't pass `onWorktreeSwitch` (git, git-diff, fs) simply keep their previous data until the new snapshot replaces it, turning the switch into a seamless refresh. This is a `keepPreviousData`-style trade-off: the placeholder briefly shows the old worktree's data, but it is data already on the client — no cross-worktree request is issued during the transition, so the security boundary (server-side `worktree.switch` validation) is untouched.

### Why the Session List Keeps a Placeholder During a Switch

The session list decides which chat `AppShell` renders, so "keep old data" is not enough on its own: the redirect / new-session recovery logic must also be prevented from acting on the stale list (which would hijack the URL toward a session that belongs to the old worktree). `useSessionSubscription` passes `onWorktreeSwitch: beginReload`:

```typescript
// web/src/lib/sessionStore.ts:49
beginReload: () => set({ isSuccess: false, isReloading: true }),
```

`beginReload` keeps `sessions` and — deliberately — leaves `isLoading` false, so the sidebar keeps rendering the retained list instead of flashing a spinner. It only clears `isSuccess` (so redirect / new-session recovery waits for the new worktree's list) and raises `isReloading`.

`AppShell` treats `isReloading` — together with `worktreeSwitchInFlight`, a pending `redirectSessionId`, or `needsNewSession` — as an "in transition" state and reuses the last resolved session as a placeholder (`displaySession`) instead of dropping to the loading blank. The same placeholder path smooths other transient renders, such as jumping to the next session after deleting the current one.

### Why App-Level Subscriptions Survive Worktree Switches

Not every subscription is worktree-scoped. Work list/detail, agent role list, settings, and the worktree list are backed by Manager-level watchers that keep pushing across worktree switches. Their hooks set `resubscribeOnWorktreeChange: false`, so they never re-subscribe on switch — and they don't need to.

This is why wsStore separates its callback maps into two groups and, on switch, clears only the worktree-scoped ones (`clearWorktreeWatchSubscriptions`), reserving the full clear (`clearAllWatchSubscriptions`) for disconnect. Clearing app-level callbacks on switch would leave the server pushing to a connection whose local handlers are gone, silently dropping `work.list.changed` and similar notifications. Keeping the local teardown aligned with the server's watcher lifetime is what keeps the global work list live after a worktree switch.

## Buffer Size Tuning

| Watcher | Buffer | Reasoning |
|---------|--------|-----------|
| ChatMessages | 256 | High frequency during active coding sessions |
| WorkList | 64 | Medium frequency; UI can tolerate small delays |
| SessionList | 64 | Medium frequency; similar to WorkList |
| Settings | 16 | Low frequency; settings rarely change |

These values were chosen empirically. The key insight: buffer overflow triggers full sync, which is more expensive than the incremental update but still correct. Thus, buffers should be large enough to handle typical bursts, but not so large that they consume excessive memory.

## Testing Strategy

Each watcher has focused tests that verify:

1. **Subscription lifecycle**: Subscribe returns initial data, unsubscribe cleans up
2. **Change detection**: Notifications fire on relevant changes
3. **Backpressure**: Dirty flag triggers full sync after buffer overflow (see `TestWorkListWatcher_DirtyFlag_SyncsAfterDrop`)
4. **Concurrency**: No races under concurrent subscribe/unsubscribe

Tests use mock notifiers that capture notifications for assertion, avoiding actual WebSocket connections.
