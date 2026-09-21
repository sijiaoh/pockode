package claude

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
)

// declined records the control requests streamOutput answered on the CLI's
// behalf, in the order it answered them.
type declined struct {
	requestID string
	reason    string
}

// runStreamOutput feeds raw stdout through streamOutput and collects everything
// it reported.
func runStreamOutput(t *testing.T, stdout string) []agent.AgentEvent {
	t.Helper()
	got, _ := runStreamOutputWithDeclines(t, stdout)
	return got
}

func runStreamOutputWithDeclines(t *testing.T, stdout string) ([]agent.AgentEvent, []declined) {
	t.Helper()

	events := make(chan agent.AgentEvent, 32)
	var got []agent.AgentEvent
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range events {
			got = append(got, ev)
		}
	}()

	var declines []declined
	streamOutput(context.Background(), slog.Default(), strings.NewReader(stdout), events,
		&sync.Map{}, nil, &backgroundTaskTracker{},
		newUsageObserver(slog.Default(), agent.StartOptions{}),
		testRefusals(func(requestID, reason string) {
			declines = append(declines, declined{requestID, reason})
		}, nil), attachments.Store{})
	close(events)
	<-done
	return got, declines
}

// oversizedToolResult is the shape that stalls a session: a Read of an image
// answers with a tool_result whose base64 runs past any line buffer. The
// tool_use_id sits ahead of the payload, which is what makes it recoverable.
func oversizedToolResult(toolUseID string) string {
	return `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"` + toolUseID +
		`","type":"tool_result","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` +
		strings.Repeat("A", agent.MaxLineBytes) + `"}}]}]}}`
}

// The bug this covers: bufio.Scanner stops for good on an over-long line, so
// the result frame behind it never arrived, the turn never ended, and every
// tool call in it spun forever.
func TestStreamOutputKeepsReadingPastAnOversizedLine(t *testing.T) {
	got := runStreamOutput(t,
		oversizedToolResult("toolu_01")+"\n"+
			`{"type":"result","subtype":"success","is_error":false}`+"\n")

	var warning *agent.WarningEvent
	var result *agent.ToolResultEvent
	sawDone := false
	for _, ev := range got {
		switch e := ev.(type) {
		case agent.WarningEvent:
			warning = &e
		case agent.ToolResultEvent:
			result = &e
		case agent.DoneEvent:
			sawDone = true
		}
	}

	if !sawDone {
		t.Fatalf("the frame after the oversized line was never parsed; got %#v", got)
	}
	if warning == nil {
		t.Fatal("the dropped line was never reported to the user")
	}
	if warning.Code != "scanner_buffer_overflow" {
		t.Errorf("warning code = %q, want scanner_buffer_overflow", warning.Code)
	}
	if !strings.Contains(warning.Message, "too large") {
		t.Errorf("warning message = %q, want it to say the output was too large", warning.Message)
	}

	if result == nil {
		t.Fatal("the call whose result was dropped was left with no result at all")
	}
	if result.ToolUseID != "toolu_01" {
		t.Errorf("tool_use_id = %q, want toolu_01", result.ToolUseID)
	}
	if !result.IsError {
		t.Error("the recovered result should be an error: the real one is lost")
	}
}

// Parallel calls come back as one user message with a tool_result per call, so
// an oversized one of those loses every call in it — including the ones whose
// own blocks were small enough to read.
func TestStreamOutputEndsEveryCallOnAnOversizedBatch(t *testing.T) {
	line := `{"type":"user","message":{"role":"user","content":[` +
		`{"tool_use_id":"toolu_small","type":"tool_result","content":"ok"},` +
		`{"tool_use_id":"toolu_huge","type":"tool_result","content":"` +
		strings.Repeat("A", agent.MaxLineBytes) + `"}]}}`

	var ended []string
	for _, ev := range runStreamOutput(t, line+"\n") {
		if r, ok := ev.(agent.ToolResultEvent); ok {
			if !r.IsError {
				t.Errorf("call %s was not reported as failed", r.ToolUseID)
			}
			ended = append(ended, r.ToolUseID)
		}
	}

	want := []string{"toolu_small", "toolu_huge"}
	if len(ended) != len(want) {
		t.Fatalf("ended %v, want %v", ended, want)
	}
	for i, id := range want {
		if ended[i] != id {
			t.Errorf("ended[%d] = %s, want %s", i, ended[i], id)
		}
	}
}

// A line with no id to recover still has to be reported, and must not invent a
// result for a call it cannot name.
func TestStreamOutputReportsAnOversizedLineWithNoToolCall(t *testing.T) {
	got := runStreamOutput(t,
		`{"type":"assistant","message":{"content":"`+strings.Repeat("A", agent.MaxLineBytes)+`"}}`+"\n"+
			`{"type":"result","subtype":"success"}`+"\n")

	warnings, results := 0, 0
	for _, ev := range got {
		switch ev.(type) {
		case agent.WarningEvent:
			warnings++
		case agent.ToolResultEvent:
			results++
		}
	}
	if warnings != 1 {
		t.Errorf("got %d warnings, want exactly one", warnings)
	}
	if results != 0 {
		t.Errorf("got %d tool results for a line naming no call, want none", results)
	}
}

// A tool_use_id on a frame that is not a result says nothing about the call
// being over. Answering on one would end a call that is still running, and the
// real result arriving later would have nothing left to land on.
func TestStreamOutputDoesNotEndACallOnAnOversizedProgressFrame(t *testing.T) {
	got := runStreamOutput(t,
		`{"type":"tool_progress","tool_use_id":"toolu_01","output":"`+strings.Repeat("A", agent.MaxLineBytes)+`"}`+"\n")

	for _, ev := range got {
		if r, ok := ev.(agent.ToolResultEvent); ok {
			t.Fatalf("ended call %s on a progress frame", r.ToolUseID)
		}
	}
}

// A control_request is the CLI blocked on an answer: dropping one silently
// hangs the turn for good, which is the same failure in a different place.
func TestStreamOutputDeclinesAnOversizedControlRequest(t *testing.T) {
	got, declines := runStreamOutputWithDeclines(t,
		`{"type":"control_request","request_id":"req_01","request":{"subtype":"can_use_tool","tool_name":"Write","input":{"content":"`+
			strings.Repeat("A", agent.MaxLineBytes)+`"}}}`+"\n")

	if len(declines) != 1 || declines[0].requestID != "req_01" {
		t.Fatalf("declines = %+v, want one for req_01", declines)
	}
	if declines[0].reason == "" {
		t.Error("the CLI was declined without being told why")
	}
	if !hasWarning(got, "declined") {
		t.Errorf("the user was not told the request was declined; got %#v", got)
	}
	for _, ev := range got {
		if r, ok := ev.(agent.ToolResultEvent); ok {
			t.Errorf("invented a result for %s from a request that never ran", r.ToolUseID)
		}
	}
}

func hasWarning(events []agent.AgentEvent, substr string) bool {
	for _, ev := range events {
		if w, ok := ev.(agent.WarningEvent); ok && strings.Contains(w.Message, substr) {
			return true
		}
	}
	return false
}
