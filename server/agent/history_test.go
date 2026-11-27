package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// The session store writes one event record of its own: the process_ended that
// a run killed with the server never got to write, which is what tells a
// replayed transcript that the prompts it is showing can no longer be answered.
// It cannot import this package — this one is built on top of it — so the type
// name is spelled out on both sides, and this is what keeps them the same.
func TestProcessEndedRecordTypeMatchesTheSessionStores(t *testing.T) {
	if string(EventTypeProcessEnded) != session.HistoryTypeProcessEnded {
		t.Fatalf("agent writes %q, the session store writes %q",
			EventTypeProcessEnded, session.HistoryTypeProcessEnded)
	}
}

// The stamp is what lets a client measure a call or a reply: the records that
// start or end one carry the moment, and nothing else pays for a field it has no use
// for. A background_lost result is written whenever the next process starts,
// so a moment on it would measure the restart, not the call.
func TestObserveAt(t *testing.T) {
	at := time.Date(2026, 11, 27, 10, 0, 0, 0, time.UTC)

	stamped := []AgentEvent{
		ToolCallEvent{ToolUseID: "call-1"},
		ToolResultEvent{ToolUseID: "call-1"},
		ToolResultEvent{ToolUseID: "call-1", Subtype: ToolResultBackgroundResult},
		DoneEvent{},
		InterruptedEvent{},
		ProcessEndedEvent{},
		PermissionResponseEvent{RequestID: "req-1", Choice: "allow"},
		ErrorEvent{Error: "boom"},
		MessageIngestedEvent{MessageID: "msg-1"},
	}
	for _, event := range stamped {
		rec := NewEventRecord(ObserveAt(event, at))
		if rec.ObservedAt == nil || !rec.ObservedAt.Equal(at) {
			t.Errorf("%s %q: observed_at = %v, want %v", rec.Type, rec.Subtype, rec.ObservedAt, at)
		}
	}

	unstamped := []AgentEvent{
		TextEvent{Content: "hi"},
		ToolResultEvent{ToolUseID: "call-1", Subtype: ToolResultBackgroundLost},
		WarningEvent{Message: "careful"},
	}
	for _, event := range unstamped {
		raw := string(recordJSON(t, ObserveAt(event, at)))
		if strings.Contains(raw, "observed_at") {
			t.Errorf("record carries observed_at: %s", raw)
		}
	}
}

// Every record written before the field existed has none, and has to read back
// and go out again exactly as it was stored.
func TestEventRecord_WithoutObservedAtRoundTrips(t *testing.T) {
	old := `{"type":"tool_call","tool_name":"Bash","tool_input":{"command":"ls"},"tool_use_id":"call-1"}`

	var rec EventRecord
	if err := json.Unmarshal([]byte(old), &rec); err != nil {
		t.Fatal(err)
	}
	if rec.ObservedAt != nil {
		t.Fatalf("observed_at = %v, want none", rec.ObservedAt)
	}
	again, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != old {
		t.Fatalf("re-encoded as %s, want %s", again, old)
	}
}

// A subagent that made no tool calls made 0 of them, which a record has to keep
// saying; one written before the field existed says nothing and still loads.
func TestEventRecord_SubagentReportRoundTrips(t *testing.T) {
	zero := int64(0)
	event := ToolResultEvent{ToolUseID: "call-1", Subagent: &SubagentReport{AgentID: "a1", SubagentCounts: SubagentCounts{ToolUses: &zero}}}
	raw, err := json.Marshal(event.ToRecord())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"subagent":{"agent_id":"a1","tool_uses":0}`) {
		t.Fatalf("record = %s, want the zero count kept and the absent one omitted", raw)
	}

	var old EventRecord
	if err := json.Unmarshal([]byte(`{"type":"tool_result","tool_use_id":"call-1","tool_result":"ok","duration_ms":12}`), &old); err != nil {
		t.Fatal(err)
	}
	if old.Subagent != nil {
		t.Errorf("an old record grew a report: %#v", old.Subagent)
	}
}
