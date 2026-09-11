package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// record builds one history line the way the store holds it.
func record(t *testing.T, rec EventRecord) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(rec)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	return raw
}

// TestForkSupport_CanFork: the answer is a whitelist of the levels that can
// fork, so a ForkSupport nobody set — a test double, a value read from an older
// server — refuses rather than sending a fork to an agent that cannot serve it.
func TestForkSupport_CanFork(t *testing.T) {
	for support, want := range map[ForkSupport]bool{
		ForkFromAnyMessage: true,
		ForkUnsupported:    false,
		"":                 false,
	} {
		if got := support.CanFork(); got != want {
			t.Errorf("ForkSupport(%q).CanFork() = %v, want %v", support, got, want)
		}
	}
}

// plainAgent implements no SessionForker, the way an agent that cannot be forked
// is written (see agent/codex).
type plainAgent struct{ Agent }

// forkingAgent implements it, which is the whole declaration. ForkSession is
// never called here; having to write it is the point.
type forkingAgent struct{ Agent }

func (forkingAgent) ForkSupport() ForkSupport { return ForkFromAnyMessage }

func (forkingAgent) ForkSession(context.Context, ForkOptions) (bool, error) { return true, nil }

// TestForkSupportOf: implementing SessionForker is the declaration, so an agent
// that does not is unforkable without having to say so anywhere. Nothing else may
// ask the question, and this is what keeps "declared" and "implemented" from
// being two facts that can drift apart.
func TestForkSupportOf(t *testing.T) {
	if got := ForkSupportOf(plainAgent{}); got != ForkUnsupported {
		t.Errorf("ForkSupportOf(an agent with no ForkSession) = %q, want %q", got, ForkUnsupported)
	}
	if got := ForkSupportOf(forkingAgent{}); got != ForkFromAnyMessage {
		t.Errorf("ForkSupportOf(an agent that can fork) = %q, want its own answer", got)
	}
}

// TestTruncateHistory covers the pairs a cut can split. A fork that keeps an
// opener whose answer fell on the other side of the cut shows a tool that never
// returns, or a prompt that can never be answered — the process that asked is
// gone.
func TestTruncateHistory(t *testing.T) {
	tests := []struct {
		name        string
		records     []EventRecord
		keepThrough int
		want        []EventType
	}{
		{
			name: "keeps a complete prefix untouched",
			records: []EventRecord{
				{Type: EventTypeMessage, Content: "hi"},
				{Type: EventTypeToolCall, ToolUseID: "t1"},
				{Type: EventTypeToolResult, ToolUseID: "t1"},
				{Type: EventTypeDone},
				{Type: EventTypeMessage, Content: "and again"},
			},
			keepThrough: 3,
			want:        []EventType{EventTypeMessage, EventTypeToolCall, EventTypeToolResult, EventTypeDone},
		},
		{
			name: "drops a tool call whose result is past the cut",
			records: []EventRecord{
				{Type: EventTypeText, Content: "let me look"},
				{Type: EventTypeToolCall, ToolUseID: "t1"},
				{Type: EventTypeToolResult, ToolUseID: "t1"},
			},
			keepThrough: 1,
			want:        []EventType{EventTypeText},
		},
		{
			// Parallel calls settle out of order, so the dangling opener is not
			// the last kept record.
			name: "drops a dangling call from the middle of the prefix",
			records: []EventRecord{
				{Type: EventTypeToolCall, ToolUseID: "a"},
				{Type: EventTypeToolCall, ToolUseID: "b"},
				{Type: EventTypeToolResult, ToolUseID: "b"},
				{Type: EventTypeToolResult, ToolUseID: "a"},
			},
			keepThrough: 2,
			want:        []EventType{EventTypeToolCall, EventTypeToolResult},
		},
		{
			name: "drops an unanswered permission request",
			records: []EventRecord{
				{Type: EventTypePermissionRequest, RequestID: "r1"},
				{Type: EventTypePermissionResponse, RequestID: "r1"},
			},
			keepThrough: 0,
			want:        nil,
		},
		{
			name: "keeps an answered permission request",
			records: []EventRecord{
				{Type: EventTypePermissionRequest, RequestID: "r1"},
				{Type: EventTypePermissionResponse, RequestID: "r1"},
				{Type: EventTypeDone},
			},
			keepThrough: 1,
			want:        []EventType{EventTypePermissionRequest, EventTypePermissionResponse},
		},
		{
			name: "drops an unanswered question",
			records: []EventRecord{
				{Type: EventTypeAskUserQuestion, RequestID: "q1"},
			},
			keepThrough: 0,
			want:        nil,
		},
		{
			// A withdrawn prompt is settled: the source shows it that way too.
			name: "keeps a cancelled request",
			records: []EventRecord{
				{Type: EventTypeAskUserQuestion, RequestID: "q1"},
				{Type: EventTypeRequestCancelled, RequestID: "q1"},
			},
			keepThrough: 1,
			want:        []EventType{EventTypeAskUserQuestion, EventTypeRequestCancelled},
		},
		{
			// Nothing could have paired it before the fork either, so dropping it
			// would remove history the source still shows.
			name: "keeps an opener that has no ID to pair on",
			records: []EventRecord{
				{Type: EventTypeToolCall, ToolName: "Bash"},
			},
			keepThrough: 0,
			want:        []EventType{EventTypeToolCall},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records := make([]json.RawMessage, len(tt.records))
			for i, rec := range tt.records {
				records[i] = record(t, rec)
			}

			got := TruncateHistory(records, tt.keepThrough)

			if len(got) != len(tt.want) {
				t.Fatalf("kept %d records, want %d: %s", len(got), len(tt.want), got)
			}
			for i, raw := range got {
				var rec EventRecord
				if err := json.Unmarshal(raw, &rec); err != nil {
					t.Fatalf("record %d does not parse: %v", i, err)
				}
				if rec.Type != tt.want[i] {
					t.Errorf("record %d is %q, want %q", i, rec.Type, tt.want[i])
				}
			}
		})
	}
}

// TestTruncateHistoryKeepsUnparsableRecords: losing history over a parse failure
// is worse than carrying a record forward that nothing can pair anyway.
func TestTruncateHistoryKeepsUnparsableRecords(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`"not an event record"`),
		record(t, EventRecord{Type: EventTypeDone}),
	}

	got := TruncateHistory(records, 1)

	if len(got) != 2 {
		t.Fatalf("kept %d records, want 2: %s", len(got), got)
	}
	if !strings.Contains(string(got[0]), "not an event record") {
		t.Errorf("first record = %s, want the unparsable one kept as-is", got[0])
	}
}

// TestHistoryActivatesSession pins what makes a copied history count as a
// started session: agent output, not the user's own messages.
func TestHistoryActivatesSession(t *testing.T) {
	tests := []struct {
		name    string
		records []EventRecord
		want    bool
	}{
		{
			name:    "agent output activates",
			records: []EventRecord{{Type: EventTypeMessage}, {Type: EventTypeText}},
			want:    true,
		},
		{
			name:    "a user message alone does not",
			records: []EventRecord{{Type: EventTypeMessage}},
			want:    false,
		},
		{
			name:    "empty history does not",
			records: nil,
			want:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records := make([]json.RawMessage, len(tt.records))
			for i, rec := range tt.records {
				records[i] = record(t, rec)
			}

			if got := HistoryActivatesSession(records); got != tt.want {
				t.Errorf("HistoryActivatesSession = %v, want %v", got, tt.want)
			}
		})
	}
}
