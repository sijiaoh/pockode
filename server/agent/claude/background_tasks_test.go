package claude

import (
	"bytes"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
)

const (
	oneLiveTask        = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bd1k65q5o","task_type":"local_bash","description":"sleep 25"}]}`
	oneAmbientTask     = `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"amb1","task_type":"local_bash","description":"watcher","ambient":true}]}`
	noLiveTasks        = `{"type":"system","subtype":"background_tasks_changed","tasks":[]}`
	successResult      = `{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed","result":"STARTED"}`
	abortedResult      = `{"type":"result","subtype":"error_during_execution","is_error":true,"terminal_reason":"aborted_streaming"}`
	failedResult       = `{"type":"result","subtype":"error_max_turns","is_error":true,"terminal_reason":"max_turns","errors":["Reached maximum number of turns (10)"]}`
	interruptRequestID = "req-interrupt"
	interruptResponse  = `{"type":"control_response","response":{"subtype":"success","request_id":"req-interrupt"}}`
	assistantOutput    = `{"type":"assistant","message":{"model":"claude","content":[{"type":"text","text":"STARTED"}]}}`
)

// The measured timeline (claude 2.1.263): the CLI ends the turn with an ordinary
// success result while a background task runs, then resumes output by itself
// once the task finishes. Both result frames are identical, so only the live set
// tells them apart.
func TestParseLine_BackgroundWaitDoesNotEndTheTurn(t *testing.T) {
	tracker := &backgroundTaskTracker{}

	for _, line := range []string{oneLiveTask, assistantOutput} {
		parseTestLineWithTracker(testLogger(), []byte(line), tracker)
	}

	events := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if len(events) != 1 {
		t.Fatalf("expected exactly one event for a turn parked on background work, got %#v", events)
	}
	if _, ok := events[0].(agent.BackgroundWaitEvent); !ok {
		t.Fatalf("expected the parked turn to be reported, got %#v", events[0])
	}

	// Task finished: the CLI resumes on its own and the real ending follows.
	parseTestLineWithTracker(testLogger(), []byte(noLiveTasks), tracker)
	events = parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if len(events) != 1 {
		t.Fatalf("expected exactly one event for the real turn end, got %#v", events)
	}
	if _, ok := events[0].(agent.DoneEvent); !ok {
		t.Errorf("expected DoneEvent after the background task finished, got %#v", events[0])
	}
}

// Only a normal ending is parked: an error or an abort really did end the turn,
// and reporting it as a wait would leave the user waiting on nothing.
func TestParseLine_BackgroundWaitStillReportsErrorAndAbort(t *testing.T) {
	tests := []struct {
		name     string
		line     string
		expected agent.AgentEvent
	}{
		{"aborted", abortedResult, agent.InterruptedEvent{}},
		{"failed", failedResult, agent.ErrorEvent{Error: "Reached maximum number of turns (10)"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tracker := &backgroundTaskTracker{}
			parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)

			events := parseTestLineWithTracker(testLogger(), []byte(tt.line), tracker)
			if len(events) != 1 || !agentEventEqual(events[0], tt.expected) {
				t.Errorf("expected %#v while a background task runs, got %#v", tt.expected, events)
			}
		})
	}
}

// Ambient tasks are housekeeping the CLI tells hosts to leave out of activity
// indicators, so they must not hold the turn open either.
func TestParseLine_AmbientTaskDoesNotHoldTheTurnOpen(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneAmbientTask), tracker)

	events := parseTestLineWithTracker(testLogger(), []byte(successResult), tracker)
	if len(events) != 1 {
		t.Fatalf("expected the turn to end normally with only an ambient task, got %#v", events)
	}
	if _, ok := events[0].(agent.DoneEvent); !ok {
		t.Errorf("expected DoneEvent, got %#v", events[0])
	}
}

// The level signal is per-process: the CLI emits nothing at startup, so a
// restarted session must not inherit the previous process's live set.
func TestBackgroundTaskTracker_StartsEmptyPerProcess(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)
	if !tracker.hasLive() {
		t.Fatal("expected the task list to be tracked")
	}

	restarted := &backgroundTaskTracker{}
	if restarted.hasLive() {
		t.Error("a new CLI process must start with an empty background task set")
	}
}

// A payload this code cannot read must not wedge the turn open: it clears the
// set, so the worst case is the pre-existing behaviour rather than a session
// that spins forever.
func TestParseLine_UnreadableTaskListClearsTheSet(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)

	parseTestLineWithTracker(testLogger(), []byte(`{"type":"system","subtype":"background_tasks_changed","tasks":"not an array"}`), tracker)
	if tracker.hasLive() {
		t.Error("an unreadable task list must clear the set, not keep the stale one")
	}
}

// The live set is state, not history: it must never reach the transcript.
func TestParseLine_BackgroundTasksChangedIsNotTranscript(t *testing.T) {
	if events := parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), &backgroundTaskTracker{}); events != nil {
		t.Errorf("expected background_tasks_changed to stay out of the transcript, got %#v", events)
	}
}

// The agent's copy of the explanation rides on the next prompt Pockode sends,
// and only that one: it describes a moment, not a standing condition.
func TestSession_QueuedNoteRidesOnTheNextPromptOnly(t *testing.T) {
	var buf bytes.Buffer
	sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}}

	sess.QueueNote("Pockode stopped waiting")
	if err := sess.SendMessage("continue"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if !strings.Contains(buf.String(), "Pockode stopped waiting") {
		t.Errorf("expected the note to reach the agent, got %s", buf.String())
	}

	buf.Reset()
	if err := sess.SendMessage("continue"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}
	if strings.Contains(buf.String(), "Pockode stopped waiting") {
		t.Errorf("expected the note to be delivered once, got %s", buf.String())
	}
}
