package agent

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func recordJSON(t *testing.T, event AgentEvent) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(NewEventRecord(event))
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
			Options:  []QuestionOption{{Label: "Postgres", Description: "the one we have"}},
		},
		AskedAt: time.Unix(1700000000, 0).UTC(),
	})
}

func gotIDs(t *testing.T, records []json.RawMessage) []string {
	t.Helper()
	questions := UnansweredQuestions(records)
	ids := make([]string, len(questions))
	for i, q := range questions {
		ids[i] = q.RequestID
	}
	return ids
}

func wantIDs(t *testing.T, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("unanswered = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("unanswered = %v, want %v", got, want)
		}
	}
}

// TestUnansweredQuestions_CarriesTheWholeQuestion: a fork inherits something the
// user can actually answer, so the options and the header have to survive the
// round trip through the record.
func TestUnansweredQuestions_CarriesTheWholeQuestion(t *testing.T) {
	questions := UnansweredQuestions([]json.RawMessage{postedRecord(t, "req-1")})
	if len(questions) != 1 {
		t.Fatalf("questions = %d, want 1", len(questions))
	}
	q := questions[0]
	if q.Header != "Database" || q.Question != "Which database?" {
		t.Errorf("question = %+v, want the posted text", q)
	}
	if len(q.Options) != 1 || q.Options[0].Label != "Postgres" || q.Options[0].Description != "the one we have" {
		t.Errorf("options = %+v, want the posted options", q.Options)
	}
	if q.AskedAt.IsZero() {
		t.Error("asked_at is zero, want the moment the question was posted")
	}
}

// TestEventRecord_CarriesNoEmptyTimestamps: `omitempty` does nothing for a
// struct, so a plain time.Time on EventRecord would put a zero timestamp on
// every record of every transcript and on every notification. Two fields that
// mean something on two event types must not be paid for by all of them.
func TestEventRecord_CarriesNoEmptyTimestamps(t *testing.T) {
	raw := string(recordJSON(t, TextEvent{Content: "hi"}))
	for _, field := range []string{"asked_at", "resolved_at"} {
		if strings.Contains(raw, field) {
			t.Errorf("a text record carries %s: %s", field, raw)
		}
	}

	posted := string(postedRecord(t, "req-1"))
	if !strings.Contains(posted, "asked_at") {
		t.Errorf("a question_posted record has no asked_at: %s", posted)
	}
	if strings.Contains(posted, "resolved_at") {
		t.Errorf("a question_posted record carries resolved_at: %s", posted)
	}
}

// TestUnansweredQuestions_ResolutionsInTheCopiedHistory is what makes fork
// inheritance right: what crosses is what was open *at the cut*, and each of the
// three ways a question leaves the list has to be read out of the records.
func TestUnansweredQuestions_ResolutionsInTheCopiedHistory(t *testing.T) {
	tests := []struct {
		name       string
		resolution json.RawMessage
	}{
		{"answered", nil},
		{"declined", nil},
		{"withdrawn", nil},
	}
	tests[0].resolution = recordJSON(t, MessageEvent{
		Content:   "Answering: Postgres",
		Answering: []QuestionAnswer{{RequestID: "req-1", Answers: []string{"Postgres"}}},
	})
	tests[1].resolution = recordJSON(t, MessageEvent{
		Content:   "Answering: not answering",
		Answering: []QuestionAnswer{{RequestID: "req-1", Declined: true}},
	})
	tests[2].resolution = recordJSON(t, RequestCancelledEvent{RequestID: "req-1"})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records := []json.RawMessage{postedRecord(t, "req-1"), postedRecord(t, "req-2"), tt.resolution}
			wantIDs(t, gotIDs(t, records), []string{"req-2"})
		})
	}
}

// TestUnansweredQuestions_OnlyWhatTheRecordsSay: a resolution that fell past the
// cut is not in the copied records, so the question is still open in the fork —
// which is the point. This is the case that a live read of the source's state
// would get wrong.
func TestUnansweredQuestions_OnlyWhatTheRecordsSay(t *testing.T) {
	kept := []json.RawMessage{postedRecord(t, "req-1")}
	wantIDs(t, gotIDs(t, kept), []string{"req-1"})
}

// TestUnansweredQuestions_IgnoresWhatItCannotUse: an ordinary message, an
// unparseable line, and a record naming no question all leave the list alone.
func TestUnansweredQuestions_IgnoresWhatItCannotUse(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage("not json at all"),
		recordJSON(t, MessageEvent{Content: "hello"}),
		recordJSON(t, QuestionPostedEvent{RequestID: "", Question: AskUserQuestion{Question: "?"}}),
		recordJSON(t, RequestCancelledEvent{RequestID: "never-asked"}),
		postedRecord(t, "req-1"),
	}
	wantIDs(t, gotIDs(t, records), []string{"req-1"})
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
	if len(kept) != 2 {
		t.Fatalf("kept %d records, want the posted question kept", len(kept))
	}
	wantIDs(t, gotIDs(t, kept), []string{"req-1"})
}
