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

### Why Worktree Switch Handlers?

```typescript
// web/src/hooks/useSubscription.ts:133-142
const cleanupSwitchStart = resubscribeOnWorktreeChange
    ? worktreeActions.onWorktreeSwitchStart(() => {
        invalidate();
        onResetRef.current?.();
    })
    : undefined;

const cleanupSwitchEnd = resubscribeOnWorktreeChange
    ? worktreeActions.onWorktreeSwitchEnd(doSubscribe)
    : undefined;
```

**Rationale:** Server-side worktree-scoped subscriptions (file, git, session) are invalidated when the client switches worktrees. The hook listens to worktree events to:

1. **onSwitchStart**: Immediately invalidate to prevent processing stale notifications
2. **onSwitchEnd**: Re-subscribe to the new worktree

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
