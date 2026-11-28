package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func recordJSON(t *testing.T, event AgentEvent) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(event.Encode())
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	return raw
}

func postedRecord(t *testing.T, id string) json.RawMessage {
	t.Helper()
	return recordJSON(t, QuestionPostedEvent{
		RequestID: id,
		Question: AskUserQuestion{
			Question: "Which database?",
			Header:   "Database",
			Options:  []QuestionOption{{Label: "Postgres", Description: "the one we have", Recommended: true}, {Label: "SQLite"}},
		},
		AskedAt: time.Unix(1700000000, 0).UTC(),
	})
}

// TestRecords_CarryNoEmptyTimestamps: `omitempty` does nothing for a struct, so
// a plain time.Time on a record would put a zero timestamp on every record of
// its type that has no moment. Every event with a moment of its own, left
// without one, must write none.
func TestRecords_CarryNoEmptyTimestamps(t *testing.T) {
	momentless := []AgentEvent{
		QuestionPostedEvent{RequestID: "req-1"}, RequestCancelledEvent{RequestID: "req-1"},
		ToolCallEvent{}, ToolResultEvent{}, DoneEvent{}, InterruptedEvent{}, ProcessEndedEvent{},
		ErrorEvent{}, MessageEvent{}, MessageIngestedEvent{}, PermissionResponseEvent{},
	}
	for _, event := range momentless {
		raw := string(recordJSON(t, event))
		if strings.Contains(raw, "_at") {
			t.Errorf("%T with no moment carries one: %s", event, raw)
		}
	}

	if posted := string(postedRecord(t, "req-1")); !strings.Contains(posted, `"asked_at"`) {
		t.Errorf("a question_posted record has no asked_at: %s", posted)
	}
}

// TestTruncateHistory_KeepsAnUnansweredPostedQuestion: the cut drops a CLI
// prompt whose answer fell past it, because only the process that raised it
// could have taken that answer. A posted question is the opposite case — the
// fork can still answer it — so it has to survive the same cut.
func TestTruncateHistory_KeepsAnUnansweredPostedQuestion(t *testing.T) {
	records := []json.RawMessage{
		recordJSON(t, MessageEvent{Content: "go"}),
		postedRecord(t, "req-1"),
	}
	kept := TruncateHistory(records, len(records)-1)
	if len(kept) != 2 || string(kept[1]) != string(records[1]) {
		t.Fatalf("kept %s, want the posted question kept", kept)
	}
}
