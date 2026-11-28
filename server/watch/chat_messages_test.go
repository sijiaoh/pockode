package watch

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// gatedNotifier records what it is handed and, until opened, holds the first
// delivery — a subscriber that has stopped keeping up.
type gatedNotifier struct {
	gate chan struct{}

	gotMu sync.Mutex
	got   []Notification
	more  chan struct{}
}

func newGatedNotifier(open bool) *gatedNotifier {
	n := &gatedNotifier{gate: make(chan struct{}), more: make(chan struct{}, 1)}
	if open {
		close(n.gate)
	}
	return n
}

func (n *gatedNotifier) Notify(ctx context.Context, notif Notification) error {
	select {
	case <-n.gate:
	case <-ctx.Done():
		return ctx.Err()
	}
	n.gotMu.Lock()
	n.got = append(n.got, notif)
	n.gotMu.Unlock()
	select {
	case n.more <- struct{}{}:
	default:
	}
	return nil
}

func (n *gatedNotifier) open() { close(n.gate) }

func (n *gatedNotifier) received() []Notification {
	n.gotMu.Lock()
	defer n.gotMu.Unlock()
	return append([]Notification(nil), n.got...)
}

// waitUntil waits until what has arrived satisfies done.
func (n *gatedNotifier) waitUntil(t *testing.T, done func([]Notification) bool) []Notification {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		if got := n.received(); done(got) {
			return got
		}
		select {
		case <-n.more:
		case <-deadline:
			t.Fatalf("gave up waiting; got %d notifications", len(n.received()))
		}
	}
}

func atLeast(count int) func([]Notification) bool {
	return func(got []Notification) bool { return len(got) >= count }
}

func endsWith(method string) func([]Notification) bool {
	return func(got []Notification) bool {
		return len(got) > 0 && got[len(got)-1].Method == method
	}
}

func newStartedChatWatcher(t *testing.T) *ChatMessagesWatcher {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	w := NewChatMessagesWatcher(store)
	if err := w.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(w.Stop)
	return w
}

func subscribeChat(t *testing.T, w *ChatMessagesWatcher, id string, n Notifier) {
	t.Helper()
	if _, err := w.Subscribe(id, n, "sess", 0); err != nil {
		t.Fatalf("subscribe %s: %v", id, err)
	}
}

func enqueueRecords(w *ChatMessagesWatcher, from, to int) {
	for i := from; i <= to; i++ {
		w.Enqueue("sess", agent.TextRecord{Content: "x"}, session.HistorySeq(i), nil)
	}
}

func seqOf(t *testing.T, n Notification) session.HistorySeq {
	t.Helper()
	p, ok := n.Params.(notifyParams)
	if !ok {
		t.Fatalf("%s carries %T, not a record", n.Method, n.Params)
	}
	return p.Seq
}

// A subscriber receives records in the order they were enqueued, and one that
// has stopped reading holds up neither the producer nor anyone else: the
// producer goes on past what the stuck queue can hold, and the other subscriber
// gets every record.
func TestChatMessagesWatcher_SlowSubscriberStallsNobody(t *testing.T) {
	w := newStartedChatWatcher(t)
	stuck := newGatedNotifier(false)
	healthy := newGatedNotifier(true)
	subscribeChat(t, w, "stuck", stuck)
	subscribeChat(t, w, "healthy", healthy)

	// In batches the healthy subscriber can keep up with, past what the stuck
	// one's queue can hold. Each call returning is the producer not held up.
	total := chatQueueSize * 3
	batch := chatQueueSize / 2
	var got []Notification
	for from := 1; from <= total; from += batch {
		enqueueRecords(w, from, from+batch-1)
		got = healthy.waitUntil(t, atLeast(from+batch-1))
	}
	if len(got) != total {
		t.Fatalf("healthy subscriber got %d notifications, want %d", len(got), total)
	}
	for i, n := range got {
		if seq := seqOf(t, n); seq != session.HistorySeq(i+1) {
			t.Fatalf("notification %d has seq %d: delivered out of order", i, seq)
		}
	}
}

// Live progress is what gives way when a subscriber falls behind, and it gives
// way early enough that a record behind it still gets in — no resync needed.
func TestChatMessagesWatcher_ProgressGivesWayToRecords(t *testing.T) {
	w := newStartedChatWatcher(t)
	n := newGatedNotifier(false)
	subscribeChat(t, w, "sub", n)

	for range chatQueueSize * 2 {
		w.Enqueue("sess", agent.ToolActivityLiveEvent{ToolUseID: "call-1", OutputDelta: "chunk"}, session.NoHistorySeq, nil)
	}
	w.Enqueue("sess", agent.DoneRecord{}, 7, nil)
	n.open()

	// The done is the last thing enqueued, so waiting for it waits for all.
	got := n.waitUntil(t, endsWith("chat.done"))
	for _, g := range got {
		if g.Method == ChatResyncMethod {
			t.Fatal("dropping progress alone must not ask for a resync")
		}
	}
	// Half the queue, one more admitted at the boundary, the one held in
	// delivery, and the done.
	if len(got) > chatQueueSize/2+3 {
		t.Errorf("%d progress updates queued; the reserve did not engage", len(got)-1)
	}
}

// A record that cannot be queued is never silently missed: the subscriber is
// told to resync, and what it received before that is a gap-free run of the
// stream with nothing after the resync.
func TestChatMessagesWatcher_OverflowAsksForResyncAndEndsTheStream(t *testing.T) {
	w := newStartedChatWatcher(t)
	n := newGatedNotifier(false)
	subscribeChat(t, w, "sub", n)

	enqueueRecords(w, 1, chatQueueSize*2)
	n.open()
	n.waitUntil(t, endsWith(ChatResyncMethod))

	// Records enqueued after the resync must not follow it. A stalled
	// subscriber turns them away as they are offered, so this is not racing
	// its delivery.
	enqueueRecords(w, chatQueueSize*2+1, chatQueueSize*2+10)
	got := n.received()

	last := got[len(got)-1]
	if last.Method != ChatResyncMethod {
		t.Fatalf("%s followed the resync", last.Method)
	}
	if p, ok := last.Params.(resyncParams); !ok || p.ID != "sub" {
		t.Errorf("resync params = %#v, want the subscription id", last.Params)
	}
	for i, g := range got[:len(got)-1] {
		if seq := seqOf(t, g); seq != session.HistorySeq(i+1) {
			t.Fatalf("notification %d before the resync has seq %d: the stream has a gap", i, seq)
		}
	}
}

// The resync is a notification of its own, so no event type may take its name.
func TestChatResync_IsNoWireType(t *testing.T) {
	for _, w := range agent.WireTypes() {
		if "chat."+string(w.Type()) == ChatResyncMethod {
			t.Errorf("%T is notified as %s", w, ChatResyncMethod)
		}
	}
}
