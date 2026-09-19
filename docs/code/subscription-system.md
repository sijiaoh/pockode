# Subscription System

This document explains the design decisions behind Pockode's real-time subscription system. For the architecture overview and API reference, see [docs/watcher.md](../watcher.md).

## Opening a Subscription

### Why Nothing Is Lost While a Subscription Is Being Opened

A subscription is not open at a single instant. The server registers it, then
reads the snapshot it replies with; the client sends the request, then hears
back. A watcher that owes a snapshot deliberately registers *before* it reads
that snapshot, so a change landing in between is notified rather than skipped —
but for most of this system's life that notification still could not reach the
screen, for two separate reasons, and closing only one of them does not help.

**The routing gap.** The subscription id used to be minted by the server and
learned by the client from the reply. So a notification sent before that reply
was written named an id the client had never seen: `handleNotification` looked
it up in the callback map, found nothing, and dropped it. The registration order
the watchers were careful about bought nothing, because the receiver did not
exist yet.

**The ordering gap.** The reply and the notification are written by different
goroutines, with nothing sequencing them. Even once routing works, the
notification can be delivered *before* `onSubscribed` applies the snapshot the
reply carried — and that snapshot is the older of the two. Delivered straight
through, the change is applied and then overwritten by the staler snapshot; the
view ends up showing the state the server held a moment *before* the client
subscribed, with nothing left in flight to correct it.

The two have to be closed together because each one alone makes the other
invisible. While notifications are being dropped, the ordering gap cannot
manifest; fix routing on its own and a bug is traded for a quieter one — a view
that is silently one revision behind is harder to see than one that missed an
update, and both survive until something unrelated happens to refresh them.

So the contract inverts who names a subscription. **The client generates the id
and sends it with the request**; the server registers under it and never mints
one (replies carry the snapshot alone). The id therefore exists before the
request goes out, which is what lets `openSubscription` put the callback in the
map *first* — the routing gap does not close, it stops existing. On top of that
`useSubscription` holds every notification that arrives before `onSubscribed`
has run and replays them, in arrival order, immediately after. Notifications are
emitted in the order the server's store committed the writes, so replaying them
over the snapshot lands on the current state.

This is a contract, not a hook detail: anything subscribing outside
`useSubscription` is exposed to the ordering gap again, however correct the id
it sends. `useChatMessages` had its own subscribe effect and was exposed exactly
that way; it has been folded back into the hook rather than given a second copy
of the hold-and-replay.

**What the replay costs.** A record landing in the window has always been both
broadcast *and* present in the history page the reply carries. What is new is
that the broadcast now arrives, so replaying it puts a second copy of the
message in the transcript. `useChatMessages` drops a notification whose `seq` is
at or below the newest `seq` in the page it just applied — that is, only records
the page demonstrably already contains, since seqs grow monotonically within a
session. A notification with no `seq` is never dropped: it addresses nothing, so
it cannot be shown to be a duplicate, and losing a real message is much worse
than showing a rare one twice. The server's own "rare duplicates are
acceptable" comment in `chat_messages.go` still describes its side of the deal;
the client is simply now able to collect on it.

### Why a Throwing Snapshot Handler Is Reported Separately

Two different faults reach `doSubscribe`'s recovery: `*.subscribe` itself
rejecting, and `onSubscribed` (or a replayed notification) throwing while the
data is applied. They call for the same recovery — the caller's data is
untrustworthy either way, so `onError`, else `onReset` — but they are not the
same event, and the second one is the one a reader is likely to misread.

By the time the snapshot is applied the subscription is **open**: its id is
recorded, the hold is released, and every later notification is delivered
straight through. So the view recovers on the next change without anything
reconnecting, and there is nothing wrong at the network layer to find. A single
`"Subscription failed"` for both sends whoever reads the console looking there.
The two are caught in separate `try` blocks and reported in separate sentences
for that reason alone; splitting the recovery as well would be inventing a
distinction the caller has no use for.

### Why Only a Timeout Sends a Compensating Unsubscribe

If `*.subscribe` fails, the client deletes its callback — but the server may
have registered the subscription anyway, and one nobody listens to lives until
the connection dies. Cancelling it is possible at all only because the id is the
client's: previously the id came back in a reply that, in the case that matters,
never came.

`openSubscription` therefore sends `*.unsubscribe` for the id — **only when the
failure is a timeout**, and that restriction is part of the contract rather than
caution. A timeout is this client's own clock giving up; it says nothing about
what the server did, which is exactly why the subscription has to be assumed
alive and cancelled. Every other failure is an *answer*, and the answer that
matters is "id already in use": that id belongs to a live subscription, so
unsubscribing would kill a subscription that is working — turning a harmless
collision into a silently dead view.

### Why the Id Is Generated by Hand Without `crypto.randomUUID`

`crypto.randomUUID` is defined only in a secure context, and Pockode's ordinary
access path is not one: a phone opening `http://<LAN-IP>` against a server
running on a laptop on the same network. That is the normal way to use this
product, not an edge case, and without a usable id generator *no subscription
can be opened at all* — every live view in the app fails, not some corner of it.

`crypto.getRandomValues` carries no secure-context restriction, so `utils/uuid.ts`
falls back to laying out a v4 UUID from its bytes by hand. The fallback exists
for reachability, not for randomness: both paths are cryptographically random,
and the only thing the manual path adds is the version and variant bits.

### Why a Subscription Id Is Unique Only Within Its Watcher

Each watcher owns its own id space. `AddSubscription` refuses an id already
taken *in that watcher*, and nothing coordinates ids across watchers — a client
is perfectly entitled to call both its work-list and its settings subscription
`"1"`.

This was not true before: server-minted ids carried a per-watcher prefix, so
they happened to be globally unique, and the connection's bookkeeping quietly
relied on it by keying its subscription set on the id alone. Under the new
contract that map silently merged two unrelated subscriptions: the second
evicted the first, unsubscribing one cancelled the other, and the evicted one
was never given back on disconnect — it outlived the connection entirely.
`rpcConnState` therefore keys on the **pair** (watcher, id), and
`untrackSubscription` takes the watcher as well.

Our own frontend generates a fresh UUID every time and would never collide. That
is exactly why this has to be stated as a property of the wire contract instead
of left to hold by accident: correctness here cannot depend on the client being
well behaved.

### Adding a New Subscription

Every new watcher inherits this mechanism, and the ways to get it wrong are all
omissions:

1. **Take the id from the request.** Params are `rpc.SubscribeParams` when the
   id is all the request carries, otherwise a type with its own `ID` field
   beside the watcher's arguments; the handler passes it to `AddSubscription`.
   A missing id is invalid params, as is one already in use — both are the
   client's mistake.
2. **Reply with data only.** No subscribe result carries an id. A watcher with
   no snapshot to send replies `{}`.
3. **Register before reading the snapshot**, and do not undo a registration you
   did not make: on "id already in use" the handler must not call
   `RemoveSubscription`, which would cancel the subscription already holding it.
4. **Subscribe through `useSubscription`** on the client, via `openSubscription`
   / `closeSubscription`. Rolling a bespoke subscribe effect reopens the
   ordering gap for that view alone.
5. **Add the method to `ws/rpc_subscribe_test.go`.** That table drives every
   `*.subscribe` method through "no id → refused", "id → accepted", "same id
   again → refused"; a handler that forgets to forward the id cannot pass it. It
   is the checklist for this section, and it is meant to fail for the watcher
   that was left out.

### Release Note

`*.subscribe` now *requires* an id. A frontend build cached in a browser from
before this change connects fine and then fails every subscription it opens, so
no live view updates. Frontend and server ship as one binary, so a reload fixes
it — but the failure is total rather than partial, which is worth knowing when
the reports arrive.

## Core Design Decisions

### Why Channel-Based Event Processing?

Event-driven watchers (WorkList, SessionList, etc.) use async buffered channels instead of directly notifying subscribers in the store callback:

```go
// server/watch/work_list.go
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
// server/watch/work_list.go
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
// server/watch/fs.go — Subscribe
key := subscriptionKey(subPath)
if w.pathRefCount[key] == 0 {
    if err := w.watcher.Add(fullPath); err != nil {
        w.pathMu.Unlock()
        w.RemoveSubscription(id)
        return err
    }
}
w.pathToIDs[key] = append(w.pathToIDs[key], id)
w.idToPath[id] = key
w.pathRefCount[key]++
```

**Rationale:**

1. **OS resource efficiency**: Each fsnotify watch consumes a file descriptor. Multiplexing avoids hitting OS limits.

2. **Consistent behavior**: All subscribers to the same path receive identical notifications.

3. **Clean teardown**: Unsubscribe decrements the count; the watch is only removed when the last subscriber leaves.

Keys go through `subscriptionKey` (`filepath.ToSlash`) because the two sides of the map have different origins: subscribers name paths with `/`, as the rest of the API does, while filesystem events arrive with the platform's separator. On Windows the un-normalized spellings of `src/main.go` are two distinct keys, so every subscription below the work directory root would go unnotified — silently, with the client showing stale content.

### Why 100ms Debounce for FSWatcher?

File changes often come in bursts (editor save, build tools, git operations):

```go
// server/watch/fs.go
const debounceInterval = 100 * time.Millisecond

// server/watch/fs.go
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
// server/watch/git.go
const gitPollInterval = 3 * time.Second
```

**Rationale:**

1. **Reliability**: Git internal file changes are complex (packed refs, loose objects, index updates). fsnotify would require deep Git knowledge to interpret correctly.

2. **Cross-platform consistency**: Git behavior varies across platforms; polling `git status` works everywhere.

3. **Simplicity**: Two commands (`rev-parse HEAD` + `status --porcelain`) capture all relevant state.

4. **Skip when idle**: Polling only runs when there are subscribers, so no overhead when unused.

### Why Parallel Git Commands?

```go
// server/watch/git.go
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
// server/watch/fs.go
ids := append([]string{}, w.pathToIDs[changedPath]...)
if changedPath != "" {
    parent := path.Dir(changedPath)
    if parent == "." {
        parent = ""
    }
    ids = append(ids, w.pathToIDs[parent]...)
}
```

**Rationale:** Directory listings need to update when files inside them change. Instead of requiring separate watches on both file and directory, FSWatcher automatically notifies parent directory subscribers.

`path.Dir`, not `filepath.Dir`: subscription keys are slash-separated on every platform, so the parent has to be derived the same way.

### Why Stop Waits Instead of Just Cancelling?

Every watcher's `Stop` goes through `BaseWatcher.CancelAndWait`, which cancels the context *and* blocks until each loop started through `Go` has returned. Cancelling alone is the smaller implementation, and it is what the watchers did originally — as did `ProcessManager` and the work engine, both of which returned from teardown while their own goroutines were still running.

The shortcut is hard to see as wrong from inside any one of those files: a cancelled context does stop the loop, just not before the caller moves on. It only reads as a bug once you look at what the caller does next. Stopping a worktree, deleting a session, or ending a test means the directory those goroutines write into is about to disappear, so anything outliving `Stop` writes into a tree already being torn down. That is how this surfaced — never as something a user could see, but as CI failing intermittently, when the event stream of a process that `Shutdown` had cancelled without waiting for wrote the session index into a `t.TempDir()` mid-cleanup.

So teardown is synchronous on all three sides: watchers wait on their loops, the process manager on its event streams, the work engine on its follow-ups *and* on the inputs it answers inline — a settled turn ending arrives on a timer of the session layer's, so nothing else is holding it open while the engine writes the work store for it. The process manager's wait is the one with a deadline, because it is the only one waiting on something outside the process: an agent CLI that refuses to close its output would otherwise hold the whole server's shutdown open, so it is reported and abandoned instead. FSWatcher's debounce timers are the one deliberate exception — `time.AfterFunc` callbacks are not tracked, so `Stop` can return with one still in flight. They are exempt because of what they do rather than for convenience: they only notify subscribers, never write to a store, and `notifyPath` re-checks the context before it does even that.

### Why a Session Is Two Subscriptions

A session is reported by two subscriptions: `session.list` draws the rows in the
sidebar, `session.detail` describes the one session that is open. Originally
there was only the list, and it embedded the whole `session.SessionMeta` in every
row — so the chat panel got the open session's model and effort by `find()`ing
its own id in the session list store.

That lookup is the tell. It says the list is the primary record and a session's
own metadata is a crop of it, which is backwards: the list answers *which
sessions exist and what do their rows look like*, and a row has no use for a
model id. The cost was not only conceptual. The list goes to **every**
subscriber on **every** change, so a model chosen in one session went out to
clients reading a different one — and since `AppShell` holds that subscription
for the whole app, every connected client learned every session's settings
whether or not it ever showed them.

So the split follows what each answer is *about*: rows for the list, the session
itself for the detail. What is worth writing down is where the line falls when a
fact could plausibly go in either.

**One mutable fact, one source.** What the session is doing used to be volatile
state owned by `process.Manager`, and the rule then was that it stayed in the
list and never appeared in detail: two notifications carrying the same fact
arrive in an order nobody guarantees — different watchers, different channels —
and nothing on the wire tells the client which of the two it is holding is the
current one.

The fact stopped being volatile. `session.TurnState` is stored with the session,
so both watchers read it from the same record and both send the same value; the
rule is satisfied at its source rather than by keeping the field on one side.
That is why `turn` may be on both when a setting may not — and why the chat panel
reads the turn from the *detail* subscription, which is the live one for the
session it has open. The chat subscription's own copy is not a second live copy:
it is a snapshot used to settle the page it arrived with, and held for the older
pages that page is scrolled back into
([agent-chat.md](../agent-chat.md#reading-a-page-on-the-client)).

**The test is "can the copies disagree", not "does the field appear twice".**
`forked_from` is in both, and that is fine: it is fixed when the session is born
and never changes again, so the two copies cannot drift apart no matter what
order they arrive in. They are also read for different questions — the list uses
it to draw a branch icon on a row, the chat panel uses it to know the open
session's own origin. A setting cannot pass that test; a birth fact cannot fail
it.

`work_id` passes the same test from the other direction: it is mutable, and it is
on both, but it is stored on neither — each side resolves it from
`work.Work.SessionID` as it builds the message, so there is one source and two
readings of it. Why the detail needs its own reading at all is
[above](#which-sessions-belong-to-work).

`title` and `unread` are on both sides and read from both, and they pass on the
same terms as `turn`: stored with the session, so both watchers read one record
and send one value. Each reader takes the copy that is about the thing it is
about — a row displays the row's, while the back-to-chat dot reads the detail's,
because the session that button is about is the one the list is allowed not to
have a row for ([above](#which-sessions-belong-to-work)). The chat's title does
choose between the two copies — the row first, the detail when there is no row —
and that is sound here for the reason `turn` is: two narrowings of one stored
record, not two accounts of it. A field that cannot say that much has to stay on
one side.

Detail's wire type carries them without listing them: `rpc.SessionDetail`
*embeds* `SessionMeta` rather than re-stating its fields, which is what keeps a
field added to a session from having to be added here too. Dropping a single
field would mean giving that up and listing them all.

**A deletion has to be said out loud.** A subscriber whose session is removed is
told `deleted: true`, rather than simply hearing nothing more — silence is
indistinguishable from an idle session. The same applies to the dirty-flag full
sync: a session the store no longer holds is reported as deleted rather than
skipped, because the sync exists precisely for not knowing which events were
dropped, and the dropped one may well have been the delete. A session the store
fails to *read* is the opposite case and is skipped: an I/O error is not news
about the session, and there is nothing truthful to say about it.

`SessionDetailWatcher`'s buffer is 64, matching `SessionListWatcher` — the two
are driven by the same store events, so a burst the list can absorb is a burst
detail must absorb too, or every burst would send detail alone into a full sync.

### Why a Watcher Sometimes Listens to a Second Store

A watcher's usual shape is one store, one kind of event: the work store changes,
work detail goes out. That breaks as soon as a payload includes something the
watcher's own store does not own. Two of the work watchers are in that position,
for the same reason and with the same shape:

- **Work detail** carries the usage of every session beneath the work item, and a
  session spending tokens changes no work item at all
  ([work-system.md](work-system.md#usage-aggregation)).
- **Work rows and the detail alike** carry the work's derived `activity`, which
  reads the turn state of the session it runs in — so a turn starting, blocking
  on a question or settling changes what a row says while the work record itself
  is untouched ([work-system.md](work-system.md#activity)).

So both also subscribe to every worktree's session store and re-send from there.

Two rules generalise out of it, and the case that produced them is written up
where the aggregation is. Both are about the second source rather than about the
payload, which is why they belong here and not there.

**Register on the instances that already exist, not only on the ones built
later.** The natural way to hook a listener onto a lazily-created collection is
from the code that creates one, which skips everything created before the wiring
ran — and skips it silently, because the subscription still works and merely stops
hearing from that source. Registration therefore attaches to the existing
instances as well, inside the same critical section that admits new ones, so a
member created at that instant is registered exactly once.

**Judge the re-send on everything the second source can move.** The detail
suppressed a session-driven notification when the usage had not changed, which
was the whole of what a session change used to mean to it; once the activity
rode along, a turn starting — which spends nothing — became a change that has to
go out. A dedup keyed on one half of the payload silently stops sending the
other.

**"Already sent" is a fact about a subscription, not about the entity.** A watcher
that suppresses a re-send because nothing changed has to remember what *it sent to
whom*: recorded per entity, the second client to subscribe marks the value as sent
and the first one is never told. Per subscription id, then, and deleted on
`Unsubscribe`, or the record grows for as long as the connection lives.

Suppression is worth having only where the trigger is noisier than the news, and
never for the watcher's own store — there the payload *is* the news.

### Which Sessions Belong to Work

A session list row carries `work_id`: the work item that session runs, absent for
a plain chat session. It is what the sidebar links to the work page with, and
what the "hide task sessions" filter is decided from.

It used to be neither. The relation is stored on the work item
(`work.Work.SessionID`), so the client answered the question by holding the
*whole* work list and inverting it — every session id any work named was a work
session. That makes the session list wrong for exactly as long as the work list
is incomplete, and a work list that pages is never complete. It also put a
sidebar's correctness at the mercy of a subscription it has no other use for.

Two things follow, and they are one decision each:

**The row derives its work id; it does not store one.** `work.Work.SessionID`
*is* the relation. A copy of it on the session would be a second one, and the
copy is what a rollback or a cascade delete leaves behind — the session outlives
the work item in every failure path that matters. So `SessionListWatcher` looks
it up while it builds the row, from the work store, and re-resolves it on every
event rather than remembering an answer. The whole-list paths index the work
store once instead of once per row.

**The filter is the server's.** `session.list.subscribe` takes
`exclude_work_sessions`; the subscription keeps it and it governs the snapshot
and every notification after it. Where one subscriber is sent the row, a
subscriber that asked not to see work sessions is sent a *removal* — the only
way to retract a row already on its screen, which is what a session joining a
work item has to do. Only the first such push sends it: a running work session
is touched several times a turn, and none of those can put back a row that has
already gone, so the rest are not sent to that subscriber at all. "Already gone"
is read off the work id last broadcast for the session, and unknown counts as
maybe — a removal for a row the client never had is one it drops, the same as
any delete it cannot place.

The retraction is one-way, at both ends: the server sends the row back as an
`update`, and the client applies an update by replacing a row it already has.
Nothing reaches that path today — deleting a work deletes its sessions
(`worktree.Manager.DeleteSessions`), so a session does not outlive its work
except when that cleanup itself fails — but a feature that detaches a work from a
live session would need a `create` on one side and an upsert on the other.

The filter defaults to off, which is what this list did before it existed: a
client that says nothing gets every session, so the field could be added without
a client change landing first.

**And the re-send is judged on the relation, not on the work item.** A work is
written many times while it runs — a wait declared, a nudge counted, a step
advanced — and none of it moves the one thing a row takes from it. So the
watcher remembers the work id it last broadcast per session and skips an event
that would repeat it; otherwise every work transition re-pushes an unchanged row
to every subscriber, and to one filtering work sessions out, each is a
retraction of a row it never had. Per session rather than per subscription — the
exception to the rule above — and only sound because the record is written
solely with values that went to *every* subscriber: a snapshot built for one new
subscriber must not be recorded there, or it suppresses the notification that
would have told all the others.

**Both sides of a session carry it, because the filter hides one of them.**
`session.detail.subscribe` answers with `rpc.SessionDetail` — the whole of
`session.SessionMeta`, embedded so a field added to a session reaches the client
without being listed twice, plus the same derived `work_id`. That is not a
second copy of the relation: neither side stores it, both resolve it from
`work.Work.SessionID`, and a wrong answer on one is a wrong answer on the other.
The reason it has to be on both is the filter above: the sessions it hides are
exactly the ones that have a work id, so the session a client most needs the id
for — the one it has open — is the one with no row to read it off.

The detail is live on the same terms as the row, and by the same route: the
worktree manager hands a work change to both watchers, both re-resolve the
relation from the store rather than reading it off the event, and both skip an
event that would repeat the work id already sent for that session. The
bookkeeping is one type shared by the two (`watch.sessionWorkIndex`), because
"the work id last put on the wire for this session" is one piece of knowledge.

What the detail has to do differently is the subscribe. Its record of what was
sent is per session, and sound only while it names what *every* subscriber of
that session holds — so a new subscriber **drops** the entry rather than writing
its own snapshot into it. A relation that changed while nobody had that session
open was pushed to nobody, and recording the snapshot would let the next
identical work event be skipped, leaving an older subscriber holding a work id
nothing will ever correct. Forgetting costs one redundant push after a
subscribe; recording costs a push that never comes.

A snapshot that cannot resolve the relation is refused, not answered without it
— a detail with no `work_id` says the session belongs to no work, and a
subscriber has no reason to ask a second time. Mid-stream, the same failure
sends nothing at all: the client keeps what it had, and the next change to
either side resolves it again.

#### What the Client Gives Up by Letting the Server Filter

The "hide task sessions" toggle is a subscription parameter, so flipping it
resubscribes (`useSessionSubscription`). The list already on screen is kept
until the new snapshot replaces it — a filter the user flipped is not a reason to
blank the sidebar and lose their place in it.

The cost is paid somewhere else, and it is the interesting part: **`sessionStore`
can no longer be asked whether a session exists.** With the filter on, a session
missing from it is either deleted or merely hidden, and those are the same
absence. The app shell asked exactly that question twice — whether to redirect
off the session in the URL, and whether a worktree is empty enough to create one
in — and a work's *Chat* link points at precisely the session the filter hides,
so answering either from the list would bounce the user off the conversation the
link just opened.

So the question moved to the only source that speaks for one session:
`session.detail.subscribe`. `sessionDetailStore` carries a three-way `status`
alongside the detail, and each value earns its keep:

- **`ready`** — the snapshot arrived. The session exists.
- **`missing`** — positive evidence, and nothing weaker: the server pushed
  `deleted`, or answered the subscribe with a refusal of its own. Only this
  redirects.
- **`loading`** — nothing is known. A disconnect returns here rather than to
  `missing`, because the list subscription drops with it and a dropped
  connection must not navigate the user anywhere.

A failed subscribe is *not* by itself the middle case. A socket that dies with
the request in flight rejects it exactly as a refusal does, and so does a server
that could not read the session; only a reply the server wrote carries a
JSON-RPC code of its own, and only "invalid params" — which is what
`session.detail.subscribe` answers a session it does not have — says the request
was wrong about its subject. Anything else clears what is held and leaves the
question open, because a blinking connection would otherwise keep announcing
that the open session is gone.

Two consequences worth stating, because both are easy to undo by accident:

**A row in the list is still proof, and still the fast path.** A session the
sidebar shows resolves the moment the list lands; only a session the filter
hides waits a second round trip. Resolving everything through the detail would
put that round trip on every session switch.

**`AppShell` holds the detail subscription, not `ChatPanel`.** It used to be the
panel's, gated on the session having resolved — which, once resolution came from
the subscription itself, deadlocked every session the list has no row for: the
shell will not mount the panel until the session resolves, and the subscription
that would resolve it was inside the panel. The panel still reads the store and
nothing else, so there is still one holder for one session.

### Paging and Pushing on One List

The session sidebar and the closed archive are fetched a page at a time
([list-paging-ui.md](../list-paging-ui.md) is the interaction design; the wire
shape is [websocket-rpc.md](websocket-rpc.md#paging-a-subscribed-list)). Both
are also subscriptions that keep pushing, so each list has two sources at once,
and the decisions below are all about keeping them from contradicting each
other.

**A page is asked for by subscription id, not by repeating the query.** The
session list is narrowed per subscription, and a page fetched under a filter the
client restated is a page of whatever list the client named — which need not be
the list its snapshot came from. Binding the page to the subscription makes that
impossible to express. It also gives the one error worth distinguishing a
natural home: an id the server has dropped is `InvalidParams`, and a client
answers it by subscribing afresh rather than by offering a Retry over a request
that is going to be refused the same way forever.

**The cut happens after the narrowing, never before.** `SessionListWatcher.Page`
reads the list, filters it, and only then takes a page; reversed, a page of 30
arrives as however many of those 30 survived the filter — a list that thins out
as the user scrolls, for no reason they can see.

#### A cursor is a position, not a row

`session.ListCursor` is `<updatedAt.UnixNano>.<id>`, and what it names is a
place in the sort order rather than a row. That is the whole point. The session
list is sorted by `updated_at` and that key moves *while the user scrolls*, so a
page asked for by offset — "the next 30 after 60" — silently skips rows and
repeats rows as sessions bump to the top behind the request. A skipped row here
is a conversation the user cannot reach by scrolling and has no way to learn was
skipped.

Because it is a position, the row it was taken from may be deleted or may jump
to the top of the list, and the next page is still exactly the rows that follow
that place. The client dedupes by id on top of that: the cursor removes the
systematic error, not every race.

Two properties the order has to have for a cursor to mean anything:

- **It must be total.** Two sessions written in the same millisecond — a fork
  and its parent, a batch of work sessions — would otherwise come back in
  whichever order the sort left them, and a cursor into an order that is not
  total cannot say where it is. Hence the id as tiebreaker, in the cursor and in
  `session.ListOrder` alike.
- **It must be compared the way the cursor is written.** `ListOrder` compares
  `UnixNano` rather than using `time.After`, because the two disagree:
  `time.After` consults the monotonic clock when both values carry one, and a
  session read back from disk carries none. The cursor is a wall-clock instant,
  so the order has to be one too.

`rpc.SessionListItem.Cursor` and `rpc.WorkListItem.Cursor` are the only places
that build one, so a row and the record it came from cannot disagree about where
a row sits.

#### The two lists update live in opposite ways

They are not two instances of one rule, and treating them as one would break
whichever of them was second.

| | Session sidebar | Closed archive |
|---|---|---|
| Shape | One list that grows downwards | Discrete pages the user walks |
| A row on screen changes | Updated in place, **never moved** | Updated in place |
| Something new appears | Prepended — it genuinely is the newest | **Never inserted.** It belongs at the top of page 1; the page the user asked for is the page they keep |
| A row not held changes | Ignored; it lands in its right place the next time the order is computed | Ignored, with one exception: a **closed story**, which is the one thing the page would have held had it been cut now. That is recorded as the page being stale |
| A row is deleted | Removed at once — it is the answer to an action | Removed; the page stays one row short until the user moves |
| Refreshed on its own | Never | Never on an event. A stale page is re-fetched when the segment is looked at — see below |

Recency reordering therefore happens **on a load, never on an event**, which is
the rule `FileStore.AddUsage` already keeps on the server for its own reason:
moving a session to the top every time a turn is metered would reorder the list
behind the user's back. Paging turns that from good manners into a requirement,
because the reader may be two hundred rows down.

The archive's whole column follows from one fact the session list cannot claim:
**nobody is waiting on the archive.** So it earns none of the machinery for
staying current — `WorkListWatcher` remembers nothing about which page a
subscriber is on and pushes it nothing, and the exceptions in the table above
are a row staying accurate and a page admitting it is out of date, never a row
appearing, moving, or being announced.

##### "Nobody is waiting on it" is not "nobody ever looks at it"

Both exceptions in that column are client-side, and the second one was missing
for a while — with a consequence nobody would guess from the column, because it
is not about the archive at all. `Current` drops a work the moment it closes, so
for the seconds between a work finishing and the archive next being *fetched*,
that work is on neither half of the screen. If nothing ever re-fetches, those
seconds are the rest of the session: the user watches work disappear into a list
it never comes out of, and only a reload — which resubscribes, which resets the
paging state — brings it back. Every individual rule above was being kept.

So `workStore` carries `archiveStale`, set when a closed story is pushed that
the page on screen does not hold — and on the two moments that replace `Current`
wholesale, a snapshot and a resync, because neither of those says a word about
closed work either: a reconnect opens a new subscription over a page the old one
fetched, and a resync exists precisely because some event was dropped. The
Closed segment being on screen is what turns any of it into a request. Four
properties are load-bearing:

- **Only a closed story sets it.** That is the only kind of row the archive
  draws (`archiveSegment` on the server cuts exactly those). A running story is
  pushed on every turn of its session, and if those counted, the segment would
  re-fetch itself all day for the one list nobody is waiting on.
- **The page re-asked for is the one the reader is on**, not the first. A close
  lands at the top of page 1 and cannot move a window further down the same
  order, so page 3 comes back as page 3 — the promise in the table survives, and
  the refresh is free in every case except the one the user actually reported.
- **It is cleared when the request goes out, not when the answer lands.** The
  server cuts the page as it reads, so a work closing mid-flight is not in that
  answer; clearing on arrival would swallow exactly the event the mechanism
  exists for.
- **It never fires over a page that failed.** Starting a fetch clears the
  archive's error, and the Retry beside it is rendered from that error — so a
  refresh here would withdraw the one control answering the failure the reader
  is looking at, and silently re-point `archiveAttempt` at a page they never
  asked for. The reader's explicit Retry outranks a refresh nobody requested.

What this deliberately is *not* is an insert. A client that puts a row at the
top of page 1 by itself is holding 21 rows, a cursor that no longer names its
own end, and an order it had to invent.

#### What the server remembers, and what it only approximates

A resync re-sends the list, and replacing a reader five pages down with a first
page strands them past the end of a list that just got shorter under them. So a
session list subscription counts `loaded` — how many rows that subscriber holds
— and a resync hands back that many, floored at one page and capped at five
([why five](../list-paging-ui.md#34-a-resync-must-restore-what-the-user-had)).
It is counted on the server rather than asked of the client because a resync is
a push: there is nobody to ask at the moment it goes out.

`loaded` is deliberately approximate. A create or a delete moves what the client
holds by a row with no page being fetched, and a client can ask for the same
page twice. Both drift, both are corrected by the next snapshot or sync, and the
cap dwarfs either.

`stopped_hidden` and `open_hidden` — one per capped group of `Current`, because
each group's heading adds its own to the rows it received — are approximate in
the mirror-image way, and the frontend is the reason: a `work.list.changed`
update for a row the client does not hold is **upserted, not dropped**. A work
that was held back by a cap and then starts needing a person has to arrive —
dropping it is precisely how the project's attention dot would stay dark on a
project that needs one. That group's count then over-states by that row until
the next snapshot corrects it. A number that is one too high for a moment is a
cheaper error than a signal that never comes.

#### A page is a read, and must not be recorded as a push

A work list row carries the work's derived `activity`, which moves with the turn
of its session — and a session is touched several times a turn without that
value changing. So `WorkListWatcher` keeps `sentActivity`, the activity last put
on the wire per work item, and skips an event that would repeat one. That record
is per work item rather than per subscriber, which is sound only while it names
what *every* subscriber holds.

Hence the split: `listRows` (subscribe and sync, which do reach everyone) writes
it, and the paging methods read through `readRows`, which does not. Recording a
read that answered one client would suppress the very push that would have told
all the others.

This is the same rule, and the same failure, as the session work-index
([which sessions belong to work](#which-sessions-belong-to-work)): it goes wrong
silently, in a client that was simply never sent something.

#### "No page has loaded yet" belongs to a subscription

The archive is fetched on demand, so after a resubscribe something has to ask
for its first page again — and "the segment is open and no page has landed"
cannot be that trigger on its own. It is already true at the instant the dead
subscription is thrown away, so re-asking then fetches against the id that just
turned out to be dead, forever.

`workStore` therefore carries a `pagingGeneration`, bumped every time a
subscription is bound to the paging actions, and the effect that fetches the
first page depends on it. The fact that matters is not "nothing is loaded" but
"nothing is loaded *for this subscription*" — an unowned absence is not
actionable, and acting on one is a request loop.

## Frontend

`useSubscription` owns every subscription's lifecycle; the sections after it are
the store and panel decisions that follow from *when* a subscription's data
actually arrives.

### Why Generation Counter?

```typescript
// web/src/hooks/useSubscription.ts
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
// web/src/hooks/useSubscription.ts
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

`onReset` is now reserved for the cases where the data is genuinely untrustworthy — disable, disconnect, a failed (re)subscribe, or an `onSubscribed` that threw part-way through (see *Why a Throwing Snapshot Handler Is Reported Separately*: that last one leaves the subscription open, so the next notification refills what it cleared). Consumers that don't pass `onWorktreeSwitch` (git, git-diff, fs) simply keep their previous data until the new snapshot replaces it, turning the switch into a seamless refresh. This is a `keepPreviousData`-style trade-off: the placeholder briefly shows the old worktree's data, but it is data already on the client — no cross-worktree request is issued during the transition, so the security boundary (server-side `worktree.switch` validation) is untouched.

### Why Only One `worktree.switch` Is Ever in Flight

`onSwitchEnd` is what reopens every worktree-scoped subscription, so it must fire
only once the connection is bound to the worktree the app is actually showing.
That is not something the reply can be trusted to mean on its own.

A connection has exactly one bound worktree, and the server answers each request
on its own goroutine (`jsonrpc2.AsyncHandler`) — each bind is atomic, but nothing
orders two of them
([websocket-rpc.md](websocket-rpc.md#binding-a-worktree-vs-disconnect)). Two
switches in flight therefore complete in either order, and the connection keeps
whichever finished *last*, not whichever was requested last. Switching to a
worktree the server still has to open is slow; switching to one it already holds
is immediate. Move on while the first is still working and the order inverts: the
fast switch to C binds and replies, the subscriptions reopen and show C correctly
— and then B lands, rebinds the connection, and its switch-end refills the
session list with B's sessions under C's URL. Nothing recovers it, because every
later request, refresh included, is answered against B too.

`wsStore` therefore runs switches through a single-flight loop
(`runWorktreeSwitchLoop`) that re-reads `worktreeActions.getCurrent()` after each
reply. Serializing removes the overlap; the re-read is what catches up, issuing a
further switch whenever the reply arrived for a worktree the app has already left.
`notifyWorktreeSwitchEnd` — and the `workDir` update beside it — fire only on the
iteration that lands on target, so subscriptions are reopened once, against the
worktree on screen.

Only those two wait for that iteration. Clearing the worktree-scoped callback
maps and invalidating the worktree-dependent queries happen on *every* successful
reply, superseded ones included: the server binds before it answers, so by the
time the reply lands the old worktree's data is stale whether or not the worktree
that replaced it is still wanted — and the switch that supersedes it is about to
invalidate the same things again.

### Why the Session List Keeps a Placeholder During a Switch

The session list decides which chat `AppShell` renders, so "keep old data" is not enough on its own: the redirect / new-session recovery logic must also be prevented from acting on the stale list (which would hijack the URL toward a session that belongs to the old worktree). `useSessionSubscription` passes `onWorktreeSwitch: beginReload`:

```typescript
// web/src/lib/sessionStore.ts
beginReload: () => set({ isSuccess: false, isReloading: true }),
```

`beginReload` keeps `sessions` and — deliberately — leaves `isLoading` false, so the sidebar goes on rendering the retained list instead of dropping straight into a loading state. It only clears `isSuccess` (so redirect / new-session recovery waits for the new worktree's list) and raises `isReloading`.

`AppShell` treats `isReloading` — together with `worktreeSwitchInFlight`, a pending `redirectSessionId`, or `needsNewSession` — as an "in transition" state and, once a shell has been on screen, keeps it mounted through the transition instead of dropping to the loading blank. The same path smooths other transient renders, such as jumping to the next session after deleting the current one.

**What the placeholder may and may not be.** Only the *shell* is retained; the previous session's content is not. The destination's id is known from the URL from the first frame of a switch, so `AppShell` hands `ChatPanel` that id straight away, along with `isSessionResolved` — false until the connection is bound to the worktree the URL names and that session is known to exist there ([how it is known](#what-the-client-gives-up-by-letting-the-server-filter)). While it is false the panel shows `ChatSkeleton` and disables the input.

Retaining the previous *session* instead was the original implementation, and it meant a cross-worktree chat link showed the conversation the user had just left — including a send box wired to it — until the new list arrived. The retained sidebar list is stale in the same way, so for the duration it is barred from interaction — keyboard included, not just the pointer — then swapped for `SessionListSkeleton`, and its highlight follows the destination id rather than the list it is drawn from. Creating a session is blocked for the same stretch, since the connection is still bound to the worktree being left.

Refreshing the list is barred there too, and that guard rests on something no single file shows: `isSuccess` is not merely a loading flag; it is the last gate standing in front of redirect recovery, and it does not lift at the same moment as `worktreeSwitchInFlight` — the store worktree catches up before the resubscription does, leaving a window in which `isSuccess` is the only thing still holding. Anything that raises it there hands recovery the list of the worktree being left, which is all it takes to navigate the user off the session they were heading for. A refresh is such a thing, and opening the sidebar onto the session list performs one.

The previous session's messages can reach the screen with no worktree switch involved at all, which is why `useChatMessages` resets during render rather than in an effect: an effect would let them be committed for one frame under the new session's identity.

During a switch both skeletons wait 150ms (`useDelayedFlag`), so one that lands quickly shows no indicator at all. What gets timed has to be the whole gap — resolving the session, then loading its history. `enabled` happens to make that a single flag: with no subscription allowed yet, `isLoadingHistory` is still true, so the second phase never starts the clock over. Timed as two waits they would each restart the delay and blank the screen for longer than no delay at all.

### Why App-Level Subscriptions Survive Worktree Switches

Not every subscription is worktree-scoped. Work list/detail, agent role list, settings, and the worktree list are backed by Manager-level watchers that keep pushing across worktree switches. Their hooks set `resubscribeOnWorktreeChange: false`, so they never re-subscribe on switch — and they don't need to.

This is why wsStore separates its callback maps into two groups and, on switch, clears only the worktree-scoped ones (`clearWorktreeWatchSubscriptions`), reserving the full clear (`clearAllWatchSubscriptions`) for disconnect. Clearing app-level callbacks on switch would leave the server pushing to a connection whose local handlers are gone, silently dropping `work.list.changed` and similar notifications. Keeping the local teardown aligned with the server's watcher lifetime is what keeps the global work list live after a worktree switch.

### Why the Open Session's Metadata Is Keyed by Session Id

`sessionDetailStore` holds `{ sessionId, detail, status }` together and is read
only through `selectSessionDetail(sessionId)` / `selectSessionDetailStatus(...)`,
which answer solely when the id matches. Both halves exist for the same instant:
the route changes, so the open session's id changes immediately, but its snapshot
is a round trip behind. A store holding the detail alone would spend that instant
answering the new session's name with the previous session's model and effort —
and nothing about the value would reveal it. Keeping the id beside the data turns
that instant into `null`, which is the truth: nothing is known about this session
yet.

The same instant is why `status` is keyed the same way, and it matters more than
the detail does: `missing` is what the app shell redirects off, so a verdict
about the session just left, read under the id of the one just opened, would
navigate the user away from a session that is perfectly fine. Asked about any
other id, the store says `loading`.

That the store holds exactly one session is not a cache decision, it is the
subject. One session is open at a time; this is what is on screen, not a record
of everywhere the user has been.

### Why session.detail Is Worktree-Scoped but Never Resubscribes

`useSessionDetailSubscription` passes `resubscribeOnWorktreeChange: false`, yet
its callback map is cleared by `clearWorktreeWatchSubscriptions` alongside the
worktree-scoped ones. That looks contradictory and is not — the two settings
answer different questions.

The callback map mirrors the *server's* watcher lifetime. `SessionDetailWatcher`
is owned by the worktree, so the switch ends the subscription server-side and the
local handlers must go with it; leaving them would be the same leak described in
[App-Level Subscriptions](#why-app-level-subscriptions-survive-worktree-switches),
in the other direction.

The hook flag answers what happens *after* the switch, and the answer is
nothing, because the switch takes the session with it. `AppShell` holds this
subscription: settings and fork origin are one snapshot of the session itself,
so one holder fills the store and everything below it — `ChatPanel` and
`useChatMessages` included — reads from there. The shell passes `canLoadSession`
as that subscription's `enabled` — the connection is bound to the worktree the
URL names and its session list has landed — and that drops at the start of a
switch just as the chat subscription's `isSessionResolved` does, so by the time
the new worktree is bound both have already ended. Resubscribing would ask the
new worktree about a session id it has never heard of, and buy a "session not
found" for it. The session the user lands on subscribes on its own once the new
worktree's list has landed.

**Why the shell and not the panel, which is where it used to live.** Whether the
open session exists is this subscription's answer to give
([above](#what-the-client-gives-up-by-letting-the-server-filter)), and the shell
does not mount the panel until it knows. Gating it on `isSessionResolved` inside
the panel — which was the arrangement, and was sound while the session list
could still be asked — deadlocks every session the list has no row for: the
subscription that would resolve it sits behind the resolution. `canLoadSession`
is the weaker flag that breaks the cycle, and it is weaker in exactly one way:
it does not ask whether the session exists.

### Why the Controls Wait for the Session to Describe Itself

Until the first `session.detail` snapshot arrives, `useChatMessages` — reading
the store the shell's subscription fills — reports placeholder settings; they
are type fillers, not claims, and `isSessionDetailLoaded` is what says so.
`ChatPanel` combines it into
`hasSessionSettings = isSessionResolved && isSessionDetailLoaded` and passes it
down under that same name to the engine and mode controls, which until it holds
both refuse input and show nothing.

**Refusing input**, because the placeholder can eat the correction. The
placeholder mode is `default`, and `ModeSelector.handleSelect` is a no-op when
the chosen mode equals the current one. So a session actually in `yolo` rendered
as Default, and a user pressing "Default" to get back to it was silently ignored:
the control believed nothing had changed.

**Showing nothing**, because a disabled control is still making a claim, and
every placeholder here is the reassuring one: `default` mode and `claude` agent
say, of a session nothing is known about, that it is a Claude session that asks
before it acts. The mode chip is the sharp case — its two states are a grey
shield and an amber bolt, so the gap read as "this session prompts you" for a
session running with no prompts at all. Both chips therefore draw a pulsing
placeholder where the glyph goes and name no value, on a `hasSessionSettings`
prop each (`EngineSelector`, `ModeSelector`).

Note which flag gates which, because the chip waits on two. The agent glyph
waits on `hasSessionSettings`, the agent being one of the settings the snapshot
brings. The model *name* waits again, on `hasLabel`: the option lists it is
named from load separately, and while they are the only thing outstanding the
agent is known and its icon is the one true thing on the chip. That second gate
is also why the chip skeletons the model rather than showing "Auto" — Auto is a
real setting, and a session set to Opus would claim to be on Auto until its
lists arrived.

The rule the two halves add up to: anything showing a value it does not have yet
has to refuse input too — and had better not show it.

The same reasoning is why nothing is applied optimistically: `applySetting` sends
and waits. The write lands in the server's session store, whose change event
necessarily reaches this subscription, so the new value arrives the one way every
other client's does. A rejected switch needs no rollback — the control was never
moved — and the reason reaches the user through `settingError`.

The global settings behind the Settings page follow the same rule one layer
lower, in `lib/rpc/settings.ts`. `settings.update` carries the whole settings
object and the server stores what it receives, so every write has to be composed
out of the caller's snapshot — and before the `settings` subscription delivers
one, there is nothing to compose it from. Merging the change into an empty
object, which is what the code used to do, wrote every field back as its zero
value and silently reset the ones the user never touched. `updateSettings`
now refuses in that state, naming the fields it was asked to change, rather than
sending a write that claims to know the current settings — the same rule as
above, applied to a write instead of a display: what is not known yet must be
refused, not filled in.

Keeping that contract means two clients editing at once are last-write-wins,
and that is a trade taken on purpose rather than an oversight. Every write is
composed from a snapshot the server itself pushed, and every write the server
accepts broadcasts `settings.changed` to all subscribers, so the window where
two clients can disagree is one broadcast round trip wide while the edits that
open it are made by hand, seconds apart. A write that loses inside that window
puts a field back to a value its client demonstrably observed, and the other end
is told, so a person can see it happen and redo it. Merging into an empty object
was none of that: the values had never been observed by anyone, the span was the
whole wait for the first snapshot rather than a round trip, and nothing said it
had happened. Getting rid of last-write-wins would take a version on
`settings.update`, or a patch the server merges — and the settings fields are
`omitempty` values, so a patch cannot tell "absent, leave it" from "empty, clear
it" without a second, pointer-shaped copy of the type, while clearing is exactly
what changing the default agent does
([Session Models](agent-integration.md#session-models)). Nor would either reach
the server's own read-modify-write callers, which do not go through this RPC at
all. Nobody edits the settings from two clients today, so neither is built.

The display half is the three call sites that compose those writes — the Engine
and Mode fields in Settings, the worktree base path, and the default-role star
in the agent role list. Each waits on the one question `useGlobalSettingsStatus`
answers, `settings !== null`, and never on whether the fields inside are filled:
an empty snapshot is a real answer, and the resolved defaults are the honest
thing to show for it. Until it arrives they draw a pulsing `Skeleton` where the
value goes and refuse input, because every resolved default here is a reassuring
one — Claude on Auto, Default mode, `../<repo>-worktrees`, "None (always ask)" —
and each says, of settings nobody has been told, exactly what a user who set
nothing would have. Only the part that claims a value is replaced: field names,
the static help text, and everything in the role list that answers to its own
subscription stay put.

These appear at once, without the `SKELETON_DELAY_MS` the worktree-switch
skeletons wait out. There the delay can spare a quick switch any indicator at
all; here the frame it would buy is a working control naming a value nobody set,
which is the whole thing being fixed. Nor is there a flash to hide: each
placeholder is the shape and place of the value that replaces it, so the arrival
moves nothing.

Waiting has to be able to end. `useSettingsSubscription` passes `onError`, so a
subscribe that fails on a still-open socket — where no banner appears and
nothing retries on its own — stops the pulse and names the reason it was given,
with a Retry, rather than pulsing forever with nothing behind it. The reason is
shown rather than only recorded, because the people reading it are the ones who
can act on it. Pressing it
goes back to waiting first — the message clears and the pulse returns — so a
retry that fails the same way reads as a retry that failed rather than as a
button that does nothing. That is also why the store holds the `refresh` this
hook gets back: the subscription is mounted at the top of the app, and the Retry
sits beside each waiting control. None of it mentions the connection: a
reconnect keeps the last snapshot on screen (`useSubscription` only invalidates
while reconnecting), so the controls stay usable, the refusal a click gets is
`Not connected`, and `ReconnectBanner` is the one telling that story.

What the three call sites read is therefore not a flag but the three-way
`ValueState` in `lib/valueState.ts` — `known`, `pending`, `unavailable`. The
last two are indistinguishable to a control, which can neither show the value
nor accept an edit for it, and differ only in whether a pulse is still telling
the truth; a boolean would have needed a second flag beside it and would have
admitted a combination that cannot happen. One word instead means the pulse, the
accessible name and the refusal all follow from the same answer in all three
places, and that the names never say "loading" where nothing is loading.

## Buffer Size Tuning

| Watcher | Buffer | Reasoning |
|---------|--------|-----------|
| ChatMessages | 256 | High frequency during active coding sessions |
| WorkList | 64 | Medium frequency; UI can tolerate small delays |
| SessionList | 64 | Medium frequency; similar to WorkList |
| SessionDetail | 64 | Same store events as SessionList; see [above](#why-a-session-is-two-subscriptions) |
| Settings | 16 | Low frequency; settings rarely change |

These values were chosen empirically. The key insight: buffer overflow triggers full sync, which is more expensive than the incremental update but still correct. Thus, buffers should be large enough to handle typical bursts, but not so large that they consume excessive memory.

## Testing Strategy

Each watcher has focused tests that verify:

1. **Subscription lifecycle**: Subscribe returns initial data, unsubscribe cleans up
2. **Change detection**: Notifications fire on relevant changes
3. **Backpressure**: Dirty flag triggers full sync after buffer overflow (see `TestWorkListWatcher_DirtyFlag_SyncsAfterDrop`)
4. **Concurrency**: No races under concurrent subscribe/unsubscribe

Tests use mock notifiers that capture notifications for assertion, avoiding actual WebSocket connections.
