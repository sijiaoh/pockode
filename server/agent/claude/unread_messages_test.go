package claude

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
)

// stopAfter sends prompts, then a Stop, and returns the session's pending
// requests, the request id of the interrupt, and every line written to stdin.
func stopAfter(t *testing.T, prompts ...agent.Prompt) (*sync.Map, string, []string) {
	t.Helper()
	var buf bytes.Buffer
	pending := &sync.Map{}
	sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}, pendingRequests: pending, backgroundTasks: &backgroundTaskTracker{}}
	for _, p := range prompts {
		if err := sess.SendMessage(p); err != nil {
			t.Fatalf("SendMessage: %v", err)
		}
	}
	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(buf.String()), "\n")
	var interrupt controlRequestOut
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &interrupt); err != nil {
		t.Fatalf("unparseable interrupt %q: %v", lines[len(lines)-1], err)
	}
	return pending, interrupt.RequestID, lines
}

func interruptAck(requestID, cancelled string) []byte {
	return []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"` + requestID + `","response":{"still_queued":[],"cancelled":` + cancelled + `}}}`)
}

// A Stop's cancel_queued drops messages the turn had not read yet. The CLI
// names them only by the uuid they were sent with, so each message carries its
// record's id, and every one of ours the interrupt cancelled is reported —
// before the ending, inside the turn that was stopped.
func TestSession_StopReportsTheMessagesItDiscarded(t *testing.T) {
	pending, requestID, lines := stopAfter(t,
		agent.Prompt{Text: "run the long build", ID: "msg-1"},
		agent.Prompt{Text: "actually,\n  do X instead", ID: "msg-2"},
	)

	for i, want := range []string{"msg-1", "msg-2"} {
		var msg userMessage
		if err := json.Unmarshal([]byte(lines[i]), &msg); err != nil {
			t.Fatalf("unparseable message %q: %v", lines[i], err)
		}
		if msg.UUID != want {
			t.Errorf("message %d sent with uuid %q, want %q", i, msg.UUID, want)
		}
	}

	// The CLI may list uuids it enqueued itself; those are not Pockode's to report.
	events := parseTestLine(testLogger(), interruptAck(requestID, `["msg-2","cli-internal"]`), pending)

	want := []agent.AgentEvent{
		agent.WarningEvent{
			Message: `Stopping the turn discarded a message the agent had not read yet, so it will not be answered: "actually, do X instead"`,
			Code:    discardedMessageCode,
		},
		agent.InterruptedEvent{},
	}
	if !agentEventsEqual(events, want) {
		t.Errorf("got %#v, want %#v", events, want)
	}
}

func TestSession_StopThatDiscardsNothingReportsNothing(t *testing.T) {
	for _, tc := range []struct {
		name string
		ack  func(requestID string) []byte
	}{
		{"empty list", func(id string) []byte { return interruptAck(id, `[]`) }},
		// A CLI without interrupt_cancel_queued_v1 keeps the messages, and says nothing.
		{"no list", func(id string) []byte {
			return []byte(`{"type":"control_response","response":{"subtype":"success","request_id":"` + id + `"}}`)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pending, requestID, _ := stopAfter(t, agent.Prompt{Text: "hello", ID: "msg-1"})
			events := parseTestLine(testLogger(), tc.ack(requestID), pending)
			if !agentEventsEqual(events, []agent.AgentEvent{agent.InterruptedEvent{}}) {
				t.Errorf("got %#v, want only InterruptedEvent", events)
			}
		})
	}
}

// A message whose record failed to be written has no id, and must not go out
// claiming one.
func TestSession_SendMessage_NoIDNoUUID(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}}
	if err := sess.SendMessage(agent.Prompt{Text: "hello"}); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	if strings.Contains(buf.String(), `"uuid"`) {
		t.Errorf("message without an id sent a uuid: %s", buf.String())
	}
}

func TestExcerpt(t *testing.T) {
	long := strings.Repeat("あ", excerptRunes+5)
	for _, tc := range []struct{ in, want string }{
		{"  two\n\tlines ", `"two lines"`},
		{long, `"` + strings.Repeat("あ", excerptRunes) + `…"`},
		{"", "(attachments only)"},
	} {
		if got := excerpt(tc.in); got != tc.want {
			t.Errorf("excerpt(%q) = %s, want %s", tc.in, got, tc.want)
		}
	}
}
