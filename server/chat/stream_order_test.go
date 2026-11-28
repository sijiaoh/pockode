package chat

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// What the agent says and what Pockode writes beside it reach a subscriber in
// the order the session's history holds them. They used to travel two ways —
// the process's records through an asynchronous queue, the client's straight
// out — so a record Pockode wrote could overtake agent output written before
// it, and a client paging or forking by seq was handed a higher number first.
func TestClient_ProcessAndServerRecordsShareOneOrder(t *testing.T) {
	f := newMidTurnFixture(t)
	sess := f.startTurn(t)

	const each = 40
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := range each {
			sess.events <- agent.TextEvent{Content: fmt.Sprint("agent ", i)}
			sess.events <- agent.ToolActivityEvent{ToolUseID: "call", Activity: fmt.Sprint(i)}
		}
	}()
	go func() {
		defer wg.Done()
		for i := range each {
			if err := f.client.RecordWarning(context.Background(), "sess", agent.WarningEvent{Message: fmt.Sprint("pockode ", i)}); err != nil {
				t.Errorf("RecordWarning: %v", err)
				return
			}
		}
	}()
	wg.Wait()
	// The first message, then both writers' records.
	total := f.waitForRecords(t, 1+2*each)

	history := f.records(t)
	var wire []session.HistorySeq
	var records []agent.Record
	for _, e := range f.stream.snapshot() {
		if rec, ok := e.record.(agent.Record); ok {
			wire = append(wire, e.seq)
			records = append(records, rec)
		}
	}
	if len(wire) != total {
		t.Fatalf("%d records enqueued, want all %d in history", len(wire), total)
	}
	for i := range wire {
		if wire[i] != session.HistorySeq(i+1) {
			t.Fatalf("record %d went out with seq %d, want %d: %v", i, wire[i], i+1, wire)
		}
		if records[i].Type() != history[i].Type() {
			t.Fatalf("record %d went out as %s, history holds %s there", i, records[i].Type(), history[i].Type())
		}
	}
}
