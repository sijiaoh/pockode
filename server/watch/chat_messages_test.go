package watch

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/rpc"
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

// chatEnv is a watcher over a store holding session "sess", records written
// the way the sequencer writes them: appended, then enqueued with their seq.
type chatEnv struct {
	t     *testing.T
	store *session.FileStore
	w     *ChatMessagesWatcher
}

func newChatEnv(t *testing.T) *chatEnv {
	t.Helper()
	return newChatEnvWrapping(t, nil)
}

// newChatEnvWrapping is newChatEnv with the projections read through wrap
// when it is not nil.
func newChatEnvWrapping(t *testing.T, wrap func(ChatProjections) ChatProjections) *chatEnv {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("new store: %v", err)
	}
	t.Cleanup(func() { store.Close() })
	if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	var source ChatProjections = projection.Track(store)
	if wrap != nil {
		source = wrap(source)
	}
	w := NewChatMessagesWatcher(source)
	if err := w.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(w.Stop)
	return &chatEnv{t: t, store: store, w: w}
}

// write appends record to the history in turn and enqueues it; "" is no
// turn.
func (e *chatEnv) write(turn string, record agent.Record) session.HistorySeq {
	e.t.Helper()
	tag := session.NoTurn
	if turn != "" {
		tag = session.InTurn(turn)
	}
	seq, err := e.store.AppendToHistory(context.Background(), "sess", record, tag)
	if err != nil {
		e.t.Fatalf("append: %v", err)
	}
	e.w.Enqueue("sess", record, seq)
	return seq
}

func (e *chatEnv) live(event agent.LiveEvent) {
	e.w.Enqueue("sess", event, session.NoHistorySeq)
}

func (e *chatEnv) subscribe(id string, n Notifier) (projection.Page, rpc.ChatStreams) {
	e.t.Helper()
	start, err := e.w.Subscribe(context.Background(), id, n, "sess", 0, session.NoHistorySeq)
	if err != nil {
		e.t.Fatalf("subscribe %s: %v", id, err)
	}
	if start.Page == nil {
		e.t.Fatalf("subscribe %s: no page", id)
	}
	return *start.Page, start.Streams
}

// resume subscribes asking to continue from after.
func (e *chatEnv) resume(id string, n Notifier, after session.HistorySeq) ChatStart {
	e.t.Helper()
	start, err := e.w.Subscribe(context.Background(), id, n, "sess", 0, after)
	if err != nil {
		e.t.Fatalf("resume %s: %v", id, err)
	}
	return start
}

// writeTexts writes count texts in turn T1.
func (e *chatEnv) writeTexts(count int) {
	e.t.Helper()
	for range count {
		e.write("T1", agent.TextRecord{Content: "x"})
	}
}

func updateOf(t *testing.T, n Notification) updateParams {
	t.Helper()
	p, ok := n.Params.(updateParams)
	if !ok || n.Method != ChatUpdateMethod {
		t.Fatalf("%s carries %T, not an update", n.Method, n.Params)
	}
	return p
}

func deltaOf(t *testing.T, n Notification) deltaParams {
	t.Helper()
	p, ok := n.Params.(deltaParams)
	if !ok || n.Method != ChatDeltaMethod {
		t.Fatalf("%s carries %T, not a delta", n.Method, n.Params)
	}
	return p
}

// A subscriber receives updates in the order the records were written, and
// one that has stopped reading holds up neither the producer nor anyone
// else: the producer goes on past what the stuck queue can hold, and the
// other subscriber gets every update.
func TestChatMessagesWatcher_SlowSubscriberStallsNobody(t *testing.T) {
	e := newChatEnv(t)
	stuck := newGatedNotifier(false)
	healthy := newGatedNotifier(true)
	e.subscribe("stuck", stuck)
	page, _ := e.subscribe("healthy", healthy)

	// In batches the healthy subscriber can keep up with, past what the stuck
	// one's queue can hold. Each call returning is the producer not held up.
	total := chatQueueSize * 3
	batch := chatQueueSize / 2
	var got []Notification
	for done := 0; done < total; done += batch {
		e.writeTexts(batch)
		got = healthy.waitUntil(t, atLeast(done+batch))
	}
	if len(got) != total {
		t.Fatalf("healthy subscriber got %d notifications, want %d", len(got), total)
	}
	for i, n := range got {
		u := updateOf(t, n)
		if want := page.ThroughSeq + session.HistorySeq(i+1); u.ThroughSeq != want {
			t.Fatalf("update %d is through seq %d, want %d: delivered out of order", i, u.ThroughSeq, want)
		}
		if len(u.Items) != 1 || u.Items[0].Item.Seq != u.ThroughSeq {
			t.Fatalf("update %d = %+v, want the one text its record wrote", i, u.Update)
		}
	}
}

// Stream deltas are what gives way when a subscriber falls behind, and they
// give way early enough that an update behind them still gets in — no resync
// needed.
func TestChatMessagesWatcher_DeltasGiveWayToUpdates(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(false)
	e.subscribe("sub", n)

	for range chatQueueSize * 2 {
		e.live(agent.ToolActivityLiveEvent{ToolUseID: "call-1", OutputDelta: "chunk"})
	}
	e.write("T1", agent.TextRecord{Content: "after"})
	n.open()

	// The update is the last thing enqueued, so waiting for it waits for all.
	got := n.waitUntil(t, endsWith(ChatUpdateMethod))
	for _, g := range got {
		if g.Method == ChatResyncMethod {
			t.Fatal("dropping deltas alone must not ask for a resync")
		}
	}
	// Half the queue, one more admitted at the boundary, the one held in
	// delivery, and the update.
	if len(got) > chatQueueSize/2+3 {
		t.Errorf("%d deltas queued; the reserve did not engage", len(got)-1)
	}
}

// A subscriber that lost a piece of a stream is sent the whole of it in place
// of the next piece, so what it holds never has a hole in it.
func TestChatMessagesWatcher_ALostDeltaIsMadeGoodByTheNext(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(false)
	e.subscribe("sub", n)

	want := ""
	for range chatQueueSize {
		e.live(agent.ThinkingDeltaLiveEvent{ContentDelta: "a"})
		want += "a"
	}
	n.open()
	n.waitUntil(t, atLeast(chatQueueSize/2+1))
	// Room again: the next piece goes out whole.
	e.live(agent.ThinkingDeltaLiveEvent{ContentDelta: "b"})
	want += "b"
	got := n.waitUntil(t, func(got []Notification) bool {
		return len(got) > 0 && strings.HasSuffix(deltaOf(t, got[len(got)-1]).Thinking.Content, "b")
	})

	held := ""
	for _, g := range got {
		d := deltaOf(t, g).Thinking
		if d.Replace {
			held = d.Content
		} else {
			held += d.Content
		}
	}
	if held != want {
		t.Errorf("the client holds %d characters of thinking, want %d", len(held), len(want))
	}
	if last := deltaOf(t, got[len(got)-1]).Thinking; !last.Replace {
		t.Error("the delta after the loss was a piece, not the whole stream")
	}
}

// An update that cannot be queued is never silently missed: the subscriber
// is told to resync, and what it received before that is a gap-free run of
// the stream with nothing after the resync.
func TestChatMessagesWatcher_OverflowAsksForResyncAndEndsTheStream(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(false)
	page, _ := e.subscribe("sub", n)

	e.writeTexts(chatQueueSize * 2)
	n.open()
	n.waitUntil(t, endsWith(ChatResyncMethod))

	// Updates after the resync must not follow it. A stalled subscriber turns
	// them away as they are offered, so this is not racing its delivery.
	e.writeTexts(10)
	got := n.received()

	last := got[len(got)-1]
	if last.Method != ChatResyncMethod {
		t.Fatalf("%s followed the resync", last.Method)
	}
	if p, ok := last.Params.(resyncParams); !ok || p.ID != "sub" {
		t.Errorf("resync params = %#v, want the subscription id", last.Params)
	}
	for i, g := range got[:len(got)-1] {
		if u := updateOf(t, g); u.ThroughSeq != page.ThroughSeq+session.HistorySeq(i+1) {
			t.Fatalf("update %d before the resync is through seq %d: the stream has a gap", i, u.ThroughSeq)
		}
	}
}

// A history replaced under a subscription is one no update can describe: the
// subscriber is told to start again.
func TestChatMessagesWatcher_AReplacedHistoryAsksForResync(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(true)
	e.subscribe("sub", n)
	e.write("T1", agent.TextRecord{Content: "before"})
	n.waitUntil(t, atLeast(1))

	if err := e.store.WriteHistory(context.Background(), "sess", nil); err != nil {
		t.Fatal(err)
	}
	e.write("T1", agent.TextRecord{Content: "after"})
	n.waitUntil(t, endsWith(ChatResyncMethod))
}

// What one record changes is one update: the items it named or moved, each
// as it stands now, and the turns it started or ended. A nested call is an
// item of its own, after its parent, which is sent again for its last_seq.
func TestChatMessagesWatcher_UpdatesCarryWhatEachRecordChanged(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(true)
	e.subscribe("sub", n)

	e.write("T1", agent.TurnStartedRecord{TurnID: "T1", Origin: agent.TurnOriginOutput})
	callSeq := e.write("T1", agent.ToolCallRecord{ToolUseID: "task", ToolName: "Task"})
	childSeq := e.write("T1", agent.ToolCallRecord{ToolUseID: "read", ToolName: "Read", ParentToolUseID: "task"})
	e.write("T1", agent.InterruptedRecord{})
	got := n.waitUntil(t, atLeast(4))

	started := updateOf(t, got[0])
	if len(started.Turns) != 1 || started.Turns[0].Turn.ID != "T1" || started.Turns[0].Turn.Ended || len(started.Items) != 0 {
		t.Errorf("turn_started's update = %+v, want turn T1 open and no items", started.Update)
	}

	call := updateOf(t, got[1])
	if len(call.Items) != 1 || call.Items[0].TurnID != "T1" || call.Items[0].Item.Tool.Status != projection.ItemRunning {
		t.Fatalf("the call's update = %+v, want the call running in T1", call.Update)
	}
	parentID := call.Items[0].Item.ID

	child := updateOf(t, got[2])
	if len(child.Items) != 2 {
		t.Fatalf("the nested call's update has %d items, want its parent and itself", len(child.Items))
	}
	if p := child.Items[0]; p.Item.ID != parentID || p.Item.LastSeq != childSeq || p.Item.Tool.Children != nil {
		t.Errorf("parent in the update = %+v, want it without children and last_seq %d", p.Item, childSeq)
	}
	if c := child.Items[1]; c.Parent != parentID || c.TurnID != "" || c.Item.Seq != childSeq {
		t.Errorf("nested call = %+v, want it under %d", c, parentID)
	}

	ended := updateOf(t, got[3])
	if len(ended.Turns) != 1 || !ended.Turns[0].Turn.Ended || ended.Turns[0].Turn.Outcome != session.OutcomeAborted {
		t.Errorf("the interrupt's turns = %+v, want T1 aborted", ended.Turns)
	}
	interrupted := map[session.HistorySeq]bool{}
	for _, it := range ended.Items {
		interrupted[it.Item.Seq] = it.Item.Tool.Status == projection.ItemInterrupted
	}
	if !interrupted[callSeq] || !interrupted[childSeq] {
		t.Errorf("the interrupt's items = %+v, want both calls interrupted: no record names them", ended.Items)
	}
}

// A subscriber arriving mid-stream starts from the stream as it stands, is
// sent every delta after and none before, and is told when the item that
// records the stream ends it.
func TestChatMessagesWatcher_ASubscriberArrivingMidStreamMissesNothing(t *testing.T) {
	e := newChatEnv(t)
	e.write("T1", agent.TurnStartedRecord{TurnID: "T1", Origin: agent.TurnOriginOutput})
	e.write("T1", agent.ToolCallRecord{ToolUseID: "bash", ToolName: "Bash"})
	e.live(agent.ThinkingDeltaLiveEvent{ContentDelta: "Let me "})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "bash", Activity: "running", OutputDelta: "line 1\n"})

	n := newGatedNotifier(true)
	page, streams := e.subscribe("sub", n)
	if streams.Thinking == nil || streams.Thinking.Content != "Let me " {
		t.Errorf("thinking in the snapshot = %+v, want what was streamed so far", streams.Thinking)
	}
	if got := streams.Tools["bash"]; got.Activity != "running" || got.Output != "line 1\n" {
		t.Errorf("the call's stream in the snapshot = %+v", got)
	}

	e.live(agent.ThinkingDeltaLiveEvent{ContentDelta: "think."})
	e.write("T1", agent.ThinkingRecord{Content: "Let me think."})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "bash", OutputDelta: "line 2\n"})
	e.write("T1", agent.ToolResultRecord{ToolUseID: "bash", ToolResult: "line 1\nline 2\n"})
	got := n.waitUntil(t, atLeast(4))

	if d := deltaOf(t, got[0]); d.Thinking == nil || d.Thinking.Content != "think." || d.Thinking.Replace {
		t.Errorf("first delta = %+v, want the next piece of thinking only", d)
	}
	thought := updateOf(t, got[1])
	if thought.ThroughSeq <= page.ThroughSeq || thought.StreamsEnded == nil || !thought.StreamsEnded.Thinking {
		t.Errorf("the thinking record's update = %+v, want it to end the thinking stream", thought)
	}
	if d := deltaOf(t, got[2]); d.Tool == nil || d.Tool.ToolUseID != "bash" || d.Tool.Output != "line 2\n" {
		t.Errorf("second delta = %+v, want the call's next output", d)
	}
	if u := updateOf(t, got[3]); u.StreamsEnded == nil || !reflect.DeepEqual(u.StreamsEnded.Tools, []string{"bash"}) {
		t.Errorf("the result's update ended %+v, want the call's stream", u.StreamsEnded)
	}

	_, after := e.subscribe("late", newGatedNotifier(true))
	if after.Thinking != nil || len(after.Tools) != 0 {
		t.Errorf("streams after they ended = %+v, want none", after)
	}
}

// A turn's end ends every call's stream but a backgrounded call's, whose
// work outlives the turn — including a stream naming a call no item is for,
// which nothing else would ever end.
func TestChatMessagesWatcher_ATurnsEndEndsAllButBackgroundStreams(t *testing.T) {
	e := newChatEnv(t)
	e.write("T1", agent.TurnStartedRecord{TurnID: "T1", Origin: agent.TurnOriginOutput})
	e.write("T1", agent.ToolCallRecord{ToolUseID: "bg", ToolName: "Bash"})
	e.write("T1", agent.ToolResultRecord{ToolUseID: "bg", ToolResult: "started", Subtype: agent.ToolResultBackgroundStarted})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "bg", Activity: "building"})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "stray", Activity: "no item for me"})

	n := newGatedNotifier(true)
	e.subscribe("sub", n)
	e.write("T1", agent.DoneRecord{})
	u := updateOf(t, n.waitUntil(t, atLeast(1))[0])
	if u.StreamsEnded == nil || !reflect.DeepEqual(u.StreamsEnded.Tools, []string{"stray"}) {
		t.Errorf("the turn's end ended %+v, want the stray stream only", u.StreamsEnded)
	}
	if _, streams := e.subscribe("late", newGatedNotifier(true)); len(streams.Tools) != 1 || streams.Tools["bg"].Activity != "building" {
		t.Errorf("streams after the turn = %+v, want the background call's alone", streams)
	}
}

// A call's kept output is bounded, to its tail, and says so.
func TestChatStreams_OutputKeepsItsTail(t *testing.T) {
	var b toolBuffer
	chunk := strings.Repeat("é", 1000) // two bytes each
	for written := 0; written < 3*maxStreamOutput; written += len(chunk) {
		b.appendOutput(chunk)
	}
	b.appendOutput("end")
	v := b.view()
	if !v.OutputTruncated || len(v.Output) > maxStreamOutput || !strings.HasSuffix(v.Output, "end") {
		t.Errorf("kept %d bytes, truncated %v; want at most %d ending on the newest output", len(v.Output), v.OutputTruncated, maxStreamOutput)
	}
	if !utf8.ValidString(v.Output) {
		t.Error("the kept tail starts inside a character")
	}
	if len(b.output) >= 2*maxStreamOutput {
		t.Errorf("the buffer holds %d bytes; it is trimmed at twice the bound", len(b.output))
	}
}

// A client that reconnects — its subscription gone, records and deltas
// written meanwhile — starts again from a page and streams that hold all of
// it, and the updates after carry on from that page.
func TestChatMessagesWatcher_AReconnectingClientPicksUpWhereThingsStand(t *testing.T) {
	e := newChatEnv(t)
	e.write("T1", agent.TurnStartedRecord{TurnID: "T1", Origin: agent.TurnOriginOutput})
	e.subscribe("first", newGatedNotifier(true))
	e.w.Unsubscribe("first")

	e.write("T1", agent.ToolCallRecord{ToolUseID: "bash", ToolName: "Bash"})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "bash", OutputDelta: "partial"})
	missed := e.write("T1", agent.TextRecord{Content: "while away"})

	n := newGatedNotifier(true)
	page, streams := e.subscribe("again", n)
	if page.ThroughSeq != missed {
		t.Errorf("page through %d, want the last record written while away, %d", page.ThroughSeq, missed)
	}
	if got := streams.Tools["bash"].Output; got != "partial" {
		t.Errorf("the call's output in the snapshot = %q, want what it streamed while away", got)
	}
	next := e.write("T1", agent.DoneRecord{})
	if u := updateOf(t, n.waitUntil(t, atLeast(1))[0]); u.ThroughSeq != next {
		t.Errorf("first update after reconnecting is through %d, want %d", u.ThroughSeq, next)
	}
}

// A client that reconnects holding the transcript through some seq asks to
// resume from it, and is sent what changed while it was away rather than a
// page: the items the records it missed changed, the streams as they stand,
// and from there the updates that follow.
func TestChatMessagesWatcher_AResumingClientIsSentWhatItMissed(t *testing.T) {
	e := newChatEnv(t)
	e.write("T1", agent.TurnStartedRecord{TurnID: "T1", Origin: agent.TurnOriginOutput})
	held := e.write("T1", agent.TextRecord{Content: "seen"})
	e.subscribe("first", newGatedNotifier(true))
	e.w.Unsubscribe("first")

	callSeq := e.write("T1", agent.ToolCallRecord{ToolUseID: "bash", ToolName: "Bash"})
	e.live(agent.ToolActivityLiveEvent{ToolUseID: "bash", OutputDelta: "partial"})
	missed := e.write("T1", agent.TextRecord{Content: "while away"})

	n := newGatedNotifier(true)
	start := e.resume("again", n, held)
	if start.Page != nil || start.Resumed == nil {
		t.Fatalf("start = %+v, want an update and no page", start)
	}
	if start.Resumed.ThroughSeq != missed {
		t.Errorf("resumed through %d, want the last record written while away, %d", start.Resumed.ThroughSeq, missed)
	}
	var seqs []session.HistorySeq
	for _, it := range start.Resumed.Items {
		seqs = append(seqs, it.Item.Seq)
	}
	if !reflect.DeepEqual(seqs, []session.HistorySeq{callSeq, missed}) {
		t.Errorf("resumed items at seqs %v, want only the two written while away, %v", seqs, []session.HistorySeq{callSeq, missed})
	}
	if got := start.Streams.Tools["bash"].Output; got != "partial" {
		t.Errorf("the call's output = %q, want what it streamed while away", got)
	}
	next := e.write("T1", agent.DoneRecord{})
	if u := updateOf(t, n.waitUntil(t, atLeast(1))[0]); u.ThroughSeq != next {
		t.Errorf("first update after resuming is through %d, want %d", u.ThroughSeq, next)
	}
}

// What cannot be resumed from is answered with a page, never refused: a seq
// past the history is not this history's, and one far enough behind is
// cheaper to start over from.
func TestChatMessagesWatcher_WhatCannotBeResumedGetsAPage(t *testing.T) {
	e := newChatEnv(t)
	first := e.write("", agent.TextRecord{Content: "x"})
	e.writeTexts(projection.MaxResumeGap + 1)
	newest := first + projection.MaxResumeGap + 1

	for _, tc := range []struct {
		name  string
		after session.HistorySeq
	}{
		{"past the history", newest + 1},
		{"too far behind", newest - projection.MaxResumeGap - 1},
	} {
		if !tc.after.Valid() {
			t.Fatalf("%s: seq %d is no seq; the history is too short for the case", tc.name, tc.after)
		}
		start := e.resume(tc.name, newGatedNotifier(true), tc.after)
		if start.Resumed != nil || start.Page == nil {
			t.Errorf("%s: start = %+v, want a page", tc.name, start)
			continue
		}
		if start.Page.ThroughSeq != newest {
			t.Errorf("%s: page through %d, want %d", tc.name, start.Page.ThroughSeq, newest)
		}
	}
}

// A warning standing in for a record that could not be written is in no
// history: it goes out as an item nothing will update.
func TestChatMessagesWatcher_AnUnwrittenRecordsWarningIsAnItemOfItsOwn(t *testing.T) {
	e := newChatEnv(t)
	n := newGatedNotifier(true)
	e.subscribe("sub", n)
	e.w.Enqueue("sess", agent.WarningRecord{Message: "not saved", Code: "history_write_failed"}, session.NoHistorySeq)

	u := updateOf(t, n.waitUntil(t, atLeast(1))[0])
	if len(u.Items) != 1 || u.Items[0].Item.ID != 0 || u.Items[0].Item.Seq.Valid() || u.Items[0].Item.Warning.Code != "history_write_failed" {
		t.Errorf("update = %+v, want the warning alone, with no id or seq", u.Update)
	}
}

// An update is one flat object: the routing id, then the update's own
// fields.
func TestUpdateParams_AreOneFlatObject(t *testing.T) {
	got, err := json.Marshal(updateParams{
		ID:           "sub",
		Update:       projection.Update{ThroughSeq: 3},
		StreamsEnded: &streamsEnded{Thinking: true},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"id":"sub","through_seq":3,"streams_ended":{"thinking":true}}`; string(got) != want {
		t.Errorf("got %s, want %s", got, want)
	}
}

// countingHolder counts the projection holds outstanding per session.
type countingHolder struct {
	ChatProjections
	heldMu sync.Mutex
	held   map[string]int
}

func (h *countingHolder) Hold(sessionID string) func() {
	h.heldMu.Lock()
	defer h.heldMu.Unlock()
	h.held[sessionID]++
	release := h.ChatProjections.Hold(sessionID)
	return func() {
		h.heldMu.Lock()
		defer h.heldMu.Unlock()
		h.held[sessionID]--
		release()
	}
}

func (h *countingHolder) count(sessionID string) int {
	h.heldMu.Lock()
	defer h.heldMu.Unlock()
	return h.held[sessionID]
}

// A session is held from its first subscriber until its last one leaves, once
// however many subscribe, and again when somebody subscribes after that.
func TestChatMessagesWatcher_HoldsTheProjectionWhileSubscribed(t *testing.T) {
	holder := &countingHolder{held: make(map[string]int)}
	e := newChatEnvWrapping(t, func(s ChatProjections) ChatProjections {
		holder.ChatProjections = s
		return holder
	})

	e.subscribe("a", newGatedNotifier(true))
	e.subscribe("b", newGatedNotifier(true))
	if got := holder.count("sess"); got != 1 {
		t.Fatalf("two subscribers: %d holds, want 1", got)
	}
	e.w.Unsubscribe("a")
	if got := holder.count("sess"); got != 1 {
		t.Fatalf("one subscriber left: %d holds, want 1", got)
	}
	e.w.Unsubscribe("b")
	if got := holder.count("sess"); got != 0 {
		t.Fatalf("no subscriber left: %d holds, want 0", got)
	}
	e.subscribe("c", newGatedNotifier(true))
	if got := holder.count("sess"); got != 1 {
		t.Fatalf("subscribed again: %d holds, want 1", got)
	}
}
