package agent

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/session"
)

// legacyHistory numbers lines as a version-2 file holds them: {"seq":N,"v":2,
// in front of each flat record, from 1.
func legacyHistory(lines ...string) []json.RawMessage {
	records := make([]json.RawMessage, len(lines))
	for i, line := range lines {
		records[i] = json.RawMessage(fmt.Sprintf(`{"seq":%d,"v":2,%s`, i+1, strings.TrimPrefix(line, "{")))
	}
	return records
}

// turnShape is a history as its turns read: one entry per record, "type@turn"
// with the turn's id, "null" for none and "-" for an untagged record, and a
// turn_started's origin and message after it.
func turnShape(t *testing.T, records []json.RawMessage) []string {
	t.Helper()
	shape := make([]string, len(records))
	for i, raw := range records {
		rec, err := DecodeRecord(raw)
		if err != nil {
			t.Fatalf("record %d does not decode: %v\n%s", i, err, raw)
		}
		turn := session.HistoryTurnOf(raw)
		where := "-"
		switch {
		case turn.ID() != "":
			where = turn.ID()
		case turn.Tagged():
			where = "null"
		}
		shape[i] = string(rec.Type()) + "@" + where
		if started, ok := rec.(TurnStartedRecord); ok {
			if started.TurnID != turn.ID() {
				t.Errorf("record %d: turn_started %q is tagged %q", i, started.TurnID, turn.ID())
			}
			shape[i] += " " + string(started.Origin)
			if started.MessageID != "" {
				shape[i] += " " + started.MessageID
			}
		}
	}
	return shape
}

func assertTurnShape(t *testing.T, got []json.RawMessage, want []string) {
	t.Helper()
	if shape := turnShape(t, got); !slices.Equal(shape, want) {
		t.Errorf("turns:\n  %s\nwant:\n  %s", strings.Join(shape, "\n  "), strings.Join(want, "\n  "))
	}
}

// TestInferHistoryTurns_ClaudeHistory is a Claude transcript as one was written
// before turns had ids, with the three shapes real ones hold that a terminal
// alone does not settle: a message sent mid-turn, which joins the open turn —
// Claude answering it after the done, in a turn its own output opens; a Stop
// that Claude acknowledges twice; and output after a done with no message in
// between, which opens a turn.
func TestInferHistoryTurns_ClaudeHistory(t *testing.T) {
	records := legacyHistory(
		`{"type":"message","content":"fix the test","message_id":"m1","observed_at":"2026-01-02T03:04:05Z"}`, // 1
		`{"type":"thinking","content":"..."}`,
		`{"type":"tool_call","tool_use_id":"t1","tool_name":"Bash"}`,
		`{"type":"message","content":"also the lint","message_id":"m2"}`, // 4: queued mid-turn
		`{"type":"message_ingested","message_id":"m2"}`,
		`{"type":"tool_result","tool_use_id":"t1","tool_result":"ok"}`,
		`{"type":"text","content":"fixed"}`,
		`{"type":"done"}`,
		`{"type":"text","content":"and the lint"}`, // 9: answers m2, in a turn of its own
		`{"type":"done"}`,
		`{"type":"message","content":"now refactor","message_id":"m3"}`, // 11
		`{"type":"text","content":"on it"}`,
		`{"type":"interrupted"}`,
		`{"type":"interrupted"}`,                             // Claude's second acknowledgement of one Stop
		`{"type":"thinking","content":"a subagent woke me"}`, // 15
		`{"type":"done"}`,
		`{"type":"process_ended"}`,
	)

	got := InferHistoryTurns(records, session.AgentTypeClaude)

	assertTurnShape(t, got, []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"thinking@legacy-1",
		"tool_call@legacy-1",
		"message@-",
		"message_ingested@legacy-1",
		"tool_result@legacy-1",
		"text@legacy-1",
		"done@legacy-1",
		"turn_started@legacy-9 output",
		"text@legacy-9",
		"done@legacy-9",
		"message@-",
		"turn_started@legacy-11 prompt m3",
		"text@legacy-11",
		"interrupted@legacy-11",
		"interrupted@null",
		"turn_started@legacy-15 output",
		"thinking@legacy-15",
		"done@legacy-15",
		"process_ended@null",
	})

	// Every record keeps its address; the turn_started records have none.
	var seqs []session.HistorySeq
	for _, seq := range session.HistorySeqs(got) {
		if seq.Valid() {
			seqs = append(seqs, seq)
		}
	}
	if want := session.HistorySeqs(records); !slices.Equal(seqs, want) {
		t.Errorf("seqs = %v, want %v", seqs, want)
	}

	var started TurnStartedRecord
	if err := json.Unmarshal(got[1], &started); err != nil {
		t.Fatal(err)
	}
	if started.ObservedAt == nil || started.ObservedAt.Format("2006-01-02T15:04:05Z") != "2026-01-02T03:04:05Z" {
		t.Errorf("turn_started observed_at = %v, want the message's", started.ObservedAt)
	}
}

// TestInferHistoryTurns_ClaudeStop is the shape most real Claude Stops leave:
// the interrupt's acknowledgement, the CLI refusing each call still in flight,
// and the aborted turn's result. The refusals belong to the turn that was
// stopped, the second interrupted to none, and no turn opens between them.
// Content after them is still Claude's way into a new turn.
func TestInferHistoryTurns_ClaudeStop(t *testing.T) {
	refused := `"tool_result":"The user doesn't want to proceed with this tool use.","is_error":true`
	records := legacyHistory(
		`{"type":"message","content":"run them","message_id":"m1"}`, // 1
		`{"type":"tool_call","tool_use_id":"t1","tool_name":"Bash"}`,
		`{"type":"tool_call","tool_use_id":"t2","tool_name":"Bash"}`,
		`{"type":"interrupted"}`,
		`{"type":"tool_result","tool_use_id":"t1",`+refused+`}`,
		`{"type":"tool_result","tool_use_id":"t2",`+refused+`}`,
		`{"type":"interrupted"}`,
		`{"type":"text","content":"a subagent woke me"}`, // 8
		`{"type":"done"}`,
	)

	assertTurnShape(t, InferHistoryTurns(records, session.AgentTypeClaude), []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"tool_call@legacy-1",
		"tool_call@legacy-1",
		"interrupted@legacy-1",
		"tool_result@legacy-1",
		"tool_result@legacy-1",
		"interrupted@null",
		"turn_started@legacy-8 output",
		"text@legacy-8",
		"done@legacy-8",
	})
}

// TestInferHistoryTurns_CodexStragglers: the same shapes mean something else
// for Codex. Codex names every turn before its content, so content after an
// ending is what the Stop did not kill finishing — it belongs to the turn that
// ended and opens none — until the process that ran it is gone.
func TestInferHistoryTurns_CodexStragglers(t *testing.T) {
	records := legacyHistory(
		`{"type":"message","content":"run the suite","message_id":"m1"}`, // 1
		`{"type":"tool_call","tool_use_id":"exec-1","tool_name":"exec"}`,
		`{"type":"interrupted"}`,
		`{"type":"tool_result","tool_use_id":"exec-1","tool_result":"killed"}`, // straggler
		`{"type":"done"}`, // a second ending for the same turn
		`{"type":"text","content":"late"}`,
		`{"type":"message","content":"again","message_id":"m2"}`, // 7
		`{"type":"text","content":"done now"}`,
		`{"type":"done"}`,
		`{"type":"process_ended"}`,
		`{"type":"text","content":"after the process"}`,
	)

	got := InferHistoryTurns(records, session.AgentTypeCodex)

	assertTurnShape(t, got, []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"tool_call@legacy-1",
		"interrupted@legacy-1",
		"tool_result@legacy-1",
		"done@null",
		"text@legacy-1",
		"message@-",
		"turn_started@legacy-7 prompt m2",
		"text@legacy-7",
		"done@legacy-7",
		"process_ended@null",
		"text@null",
	})

	// The same lines from Claude: the content after the ending opens turns —
	// all but the result, which answers a call of the turn that ended.
	assertTurnShape(t, InferHistoryTurns(records, session.AgentTypeClaude), []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"tool_call@legacy-1",
		"interrupted@legacy-1",
		"tool_result@legacy-1",
		"done@null",
		"turn_started@legacy-6 output",
		"text@legacy-6",
		"message@-",
		"text@legacy-6",
		"done@legacy-6",
		"process_ended@null",
		"turn_started@legacy-11 output",
		"text@legacy-11",
	})
}

// TestInferHistoryTurns_Prompts: a permission request's fate is tagged as
// process.recordExpiries tags it — Pockode's expiry after the ending belongs to
// no turn, the agent's own withdrawal mid-turn to the turn — and an answer to a
// request that outlived its turn opens one.
func TestInferHistoryTurns_Prompts(t *testing.T) {
	records := legacyHistory(
		`{"type":"message","content":"go","message_id":"m1"}`, // 1
		`{"type":"permission_request","request_id":"r1","tool_name":"Bash"}`,
		`{"type":"request_cancelled","request_id":"r1"}`, // the agent withdrew it
		`{"type":"permission_request","request_id":"r2","tool_name":"Bash"}`,
		`{"type":"interrupted"}`,
		`{"type":"request_cancelled","request_id":"r2"}`,                     // Pockode's expiry
		`{"type":"permission_request","request_id":"r3","tool_name":"Edit"}`, // raised after the ending
		`{"type":"permission_response","request_id":"r3","choice":"allow"}`,  // 8
		`{"type":"text","content":"edited"}`,
		`{"type":"permission_request","request_id":"r4","tool_name":"Bash"}`,
		`{"type":"process_ended"}`,
		`{"type":"request_cancelled","request_id":"r4","reason":"process_ended"}`,
		`{"type":"background_wait"}`,
		`{"type":"tool_result","tool_use_id":"bg","subtype":"background_result"}`,
	)

	assertTurnShape(t, InferHistoryTurns(records, session.AgentTypeClaude), []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"permission_request@legacy-1",
		"request_cancelled@legacy-1",
		"permission_request@legacy-1",
		"interrupted@legacy-1",
		"request_cancelled@null",
		"permission_request@null",
		"turn_started@legacy-8 answer",
		"permission_response@legacy-8",
		"text@legacy-8",
		"permission_request@legacy-8",
		"process_ended@null",
		"request_cancelled@null",
		// Nothing is open, and the end of background work is not the agent
		// coming back.
		"background_wait@null",
		"tool_result@null",
	})
}

// TestInferHistoryTurns_ReadsOnlyWhatIsOld: lines written with turns are taken
// as they are, wherever they sit — after the old ones in a session that
// started before the upgrade — and a history that has nothing old in it is
// returned untouched. Every stretch of old lines starts with nothing open.
func TestInferHistoryTurns_ReadsOnlyWhatIsOld(t *testing.T) {
	records := []json.RawMessage{
		// Version 1: no envelope at all.
		json.RawMessage(`{"type":"message","content":"hi","message_id":"m1"}`),
		json.RawMessage(`{"type":"text","content":"hello"}`),
		// The restart into the new version closes out the open run.
		json.RawMessage(`{"seq":3,"v":3,"turn":null,"type":"process_ended"}`),
		json.RawMessage(`{"seq":4,"v":3,"type":"message","content":"more","message_id":"m2"}`),
		json.RawMessage(`{"seq":5,"v":3,"turn":"T","type":"turn_started","turn_id":"T","origin":"prompt","message_id":"m2"}`),
		json.RawMessage(`{"seq":6,"v":3,"turn":"T","type":"text","content":"sure"}`),
		json.RawMessage(`{"seq":7,"v":3,"turn":"T","type":"done"}`),
		// A downgraded server's line, and its message.
		json.RawMessage(`{"seq":8,"v":2,"type":"message","content":"old again","message_id":"m3"}`),
		json.RawMessage(`{"seq":9,"v":2,"type":"text","content":"ok"}`),
		// The warning a damaged file gets is in no file, and is left alone.
		json.RawMessage(`{"type":"warning","message":"Skipped 1 history entry","seq":0}`),
	}

	got := InferHistoryTurns(records, session.AgentTypeClaude)

	assertTurnShape(t, got, []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"text@legacy-1",
		"process_ended@null",
		"message@-",
		"turn_started@T prompt m2",
		"text@T",
		"done@T",
		"message@-",
		"turn_started@legacy-8 prompt m3",
		"text@legacy-8",
		"warning@-",
	})
	for i, j := range map[int]int{3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 11: 9} {
		if string(got[i]) != string(records[j]) {
			t.Errorf("record %d was rewritten:\n got %s\nwant %s", j, got[i], records[j])
		}
	}

	current := records[2:7]
	if got := InferHistoryTurns(current, session.AgentTypeClaude); &got[0] != &current[0] {
		t.Error("a history with nothing to infer was copied")
	}
}

// TestInferHistoryTurns_ForkOfAnOldSession: a fork copies an old session's lines
// into the current envelope with the tags they had, which for an old line is
// none. They are still old lines.
func TestInferHistoryTurns_ForkOfAnOldSession(t *testing.T) {
	records := []json.RawMessage{
		json.RawMessage(`{"seq":1,"v":3,"type":"message","content":"hi","message_id":"m1"}`),
		json.RawMessage(`{"seq":2,"v":3,"type":"text","content":"hello"}`),
		json.RawMessage(`{"seq":3,"v":3,"type":"done"}`),
	}
	assertTurnShape(t, InferHistoryTurns(records, session.AgentTypeClaude), []string{
		"message@-",
		"turn_started@legacy-1 prompt m1",
		"text@legacy-1",
		"done@legacy-1",
	})
}

// TestTurnInference_AnyPrefix: read one record at a time, a history infers as
// InferHistoryTurns infers it whole — after every prefix, settled where it
// stops, and after the rest is pushed onto the inference that prefix left.
// The cuts that matter are the ones through a run of messages, which are held
// on the record after them: before an old line, before a new one, and with no
// record after them at all.
func TestTurnInference_AnyPrefix(t *testing.T) {
	histories := map[string][]json.RawMessage{
		"old into new and back": {
			json.RawMessage(`{"type":"message","content":"hi","message_id":"m1"}`),
			json.RawMessage(`{"type":"text","content":"hello"}`),
			json.RawMessage(`{"seq":3,"v":3,"turn":null,"type":"process_ended"}`),
			json.RawMessage(`{"seq":4,"v":3,"type":"message","content":"more","message_id":"m2"}`),
			json.RawMessage(`{"type":"warning","message":"Skipped 1 history entry","seq":0}`),
			json.RawMessage(`{"seq":5,"v":3,"type":"message","content":"and more","message_id":"m3"}`),
			json.RawMessage(`{"seq":6,"v":3,"turn":"T","type":"turn_started","turn_id":"T","origin":"prompt","message_id":"m2"}`),
			json.RawMessage(`{"seq":7,"v":3,"turn":"T","type":"done"}`),
			json.RawMessage(`{"seq":8,"v":2,"type":"message","content":"old again","message_id":"m4"}`),
			json.RawMessage(`{"seq":9,"v":2,"type":"message","content":"twice","message_id":"m5"}`),
			json.RawMessage(`{"seq":10,"v":2,"type":"text","content":"ok"}`),
			json.RawMessage(`{"seq":11,"v":2,"type":"message","content":"last","message_id":"m6"}`),
		},
		"old Codex": legacyHistory(
			`{"type":"message","content":"go","message_id":"m1"}`,
			`{"type":"permission_request","request_id":"r1","tool_use_id":"t1"}`,
			`{"type":"process_ended"}`,
			`{"type":"request_cancelled","request_id":"r1","reason":"process_ended"}`,
			`{"type":"text","content":"late"}`,
			`{"type":"message","content":"again","message_id":"m2"}`,
		),
	}
	raws := func(lines []InferredLine) []string {
		out := make([]string, len(lines))
		for i, line := range lines {
			out[i] = string(line.Raw)
		}
		return out
	}
	want := func(records []json.RawMessage, agentType session.AgentType) []string {
		var out []string
		for _, raw := range InferHistoryTurns(records, agentType) {
			out = append(out, string(raw))
		}
		return out
	}
	for name, records := range histories {
		for _, agentType := range []session.AgentType{session.AgentTypeClaude, session.AgentTypeCodex} {
			for cut := 0; cut <= len(records); cut++ {
				inference := NewTurnInference(agentType)
				var lines []InferredLine
				for _, raw := range records[:cut] {
					lines = inference.Push(lines, raw)
				}
				if got := raws(inference.Settle(slices.Clone(lines))); !slices.Equal(got, want(records[:cut], agentType)) {
					t.Errorf("%s (%s), cut at %d:\n  %s\nwant:\n  %s", name, agentType, cut,
						strings.Join(got, "\n  "), strings.Join(want(records[:cut], agentType), "\n  "))
				}
				for _, raw := range records[cut:] {
					lines = inference.Push(lines, raw)
				}
				if got := raws(inference.Settle(lines)); !slices.Equal(got, want(records, agentType)) {
					t.Errorf("%s (%s), rest pushed after a cut at %d:\n  %s\nwant:\n  %s", name, agentType, cut,
						strings.Join(got, "\n  "), strings.Join(want(records, agentType), "\n  "))
				}
			}
		}
	}
}
