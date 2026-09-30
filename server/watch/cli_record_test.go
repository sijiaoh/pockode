package watch

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

type testRecord struct {
	Step int `json:"step"`
}

// fakeRecords is the latest record per CLI, as a Service holds it.
type fakeRecords struct {
	mu     sync.Mutex
	latest map[session.AgentType]*testRecord
}

func (f *fakeRecords) set(agentType session.AgentType, r *testRecord) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.latest[agentType] = r
}

func (f *fakeRecords) read(agentType session.AgentType) (*testRecord, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if agentType != session.AgentTypeClaude && agentType != session.AgentTypeCodex {
		return nil, errors.New("unknown agent")
	}
	r := f.latest[agentType]
	if r == nil {
		return nil, nil
	}
	c := *r
	return &c, nil
}

type recordParams struct {
	ID     string      `json:"id"`
	Record *testRecord `json:"record"`
}

func newTestRecordWatcher(t *testing.T, records *fakeRecords) *cliRecordWatcher[testRecord] {
	t.Helper()
	w := newCLIRecordWatcher("records", "test.changed", records.read,
		func(id string, r *testRecord) any { return recordParams{ID: id, Record: r} })
	if err := w.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Stop)
	return w
}

// awaitRecord waits for a notification that satisfies ok.
func awaitRecord(t *testing.T, n *captureNotifier, ok func(recordParams) bool) recordParams {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, raw := range n.all() {
			var p recordParams
			if err := json.Unmarshal(raw, &p); err != nil {
				t.Fatal(err)
			}
			if ok(p) {
				return p
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("no notification matched; got %d", n.count())
	return recordParams{}
}

// Each change reaches the subscribers of that CLI as the whole record, and a
// record that went away (a dismissed update) as null. The other CLI's
// subscribers hear nothing.
func TestCLIRecordWatcher(t *testing.T) {
	records := &fakeRecords{latest: map[session.AgentType]*testRecord{}}
	w := newTestRecordWatcher(t, records)

	claude, codex := &captureNotifier{}, &captureNotifier{}
	if r, err := w.Subscribe("c1", session.AgentTypeClaude, claude); err != nil || r != nil {
		t.Fatalf("Subscribe = %v, %v; want no record yet", r, err)
	}
	if _, err := w.Subscribe("x1", session.AgentTypeCodex, codex); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Subscribe("bad", "gemini", claude); err == nil {
		t.Error("subscribing to an unknown CLI succeeded")
	}

	records.set(session.AgentTypeClaude, &testRecord{Step: 1})
	w.changed(session.AgentTypeClaude)
	got := awaitRecord(t, claude, func(p recordParams) bool { return p.Record != nil && p.Record.Step == 1 })
	if got.ID != "c1" {
		t.Errorf("notification for %q, want c1", got.ID)
	}

	records.set(session.AgentTypeClaude, nil)
	w.changed(session.AgentTypeClaude)
	awaitRecord(t, claude, func(p recordParams) bool { return p.Record == nil })

	if n := codex.count(); n != 0 {
		t.Errorf("codex subscriber got %d notifications, want none", n)
	}
}
