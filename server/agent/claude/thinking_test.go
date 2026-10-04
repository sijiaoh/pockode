package claude

import (
	"slices"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

func TestThinkingDisplayArgs(t *testing.T) {
	tests := []struct {
		version string
		want    bool
	}{
		{"2.1.92", false},
		{"2.1.94", true},
		{"2.1.289", true},
		{"3.0.0", true},
		// A version that could not be read is one the flag could kill.
		{"", false},
		{"unknown", false},
	}
	for _, tt := range tests {
		got := thinkingDisplayArgs(tt.version)
		if has := slices.Equal(got, []string{"--thinking-display", "summarized"}); has != tt.want {
			t.Errorf("thinkingDisplayArgs(%q) = %v, want flag: %v", tt.version, got, tt.want)
		}
	}
}

// clockStep is one moment in a clock's life, at an offset from a fixed start.
type clockStep struct {
	at    time.Duration
	event agent.AgentEvent
	// sent marks a message going to the CLI instead of an event coming from it.
	sent bool
}

// runClock feeds the steps to a fresh clock and returns what it let through.
func runClock(steps []clockStep) []agent.AgentEvent {
	var c thinkingClock
	start := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	var out []agent.AgentEvent
	for _, s := range steps {
		if s.sent {
			c.messageSent(start.Add(s.at))
			continue
		}
		if ev, ok := c.observe(s.event, start.Add(s.at)); ok {
			out = append(out, ev)
		}
	}
	return out
}

func thinkingDurations(events []agent.AgentEvent) []int64 {
	var d []int64
	for _, ev := range events {
		if th, ok := ev.(agent.ThinkingEvent); ok {
			d = append(d, th.DurationMs)
		}
	}
	return d
}

func TestThinkingClock_Duration(t *testing.T) {
	tests := []struct {
		name  string
		steps []clockStep
		want  []int64
	}{
		{
			name: "from the message that opened the turn",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 12 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{12000},
		},
		{
			name: "from the last transcript output, not from the thinking signals",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "t1"}},
				{at: 5 * time.Second, event: agent.ThinkingDeltaEvent{}},
				{at: 6 * time.Second, event: agent.SystemEvent{}},
				{at: 9 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{7000},
		},
		{
			name: "a second block is measured from the first",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 3 * time.Second, event: agent.ThinkingEvent{}},
				{at: 4 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{3000, 1000},
		},
		{
			// The agent reads it at its next call to the model, which nothing
			// reports; a thinking under way goes on regardless.
			name: "a message sent mid-turn does not cut a thinking short",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.TextEvent{Content: "on it"}},
				{at: 10 * time.Second, sent: true},
				{at: 14 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{13000},
		},
		{
			// The CLI had already ended the turn when the message went out, so
			// the message opens the next one.
			name: "a message the ending had not answered opens the next turn",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.TextEvent{Content: "done"}},
				{at: 2 * time.Second, sent: true},
				{at: 3 * time.Second, event: agent.DoneEvent{}},
				{at: 7 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{5000},
		},
		{
			name: "a message answered before the ending opens nothing",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, sent: true},
				{at: 2 * time.Second, event: agent.TextEvent{Content: "both answered"}},
				{at: 3 * time.Second, event: agent.DoneEvent{}},
				{at: 60 * time.Second, sent: true},
				{at: 64 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{4000},
		},
		{
			// The carried message's turn is running: a third message, or work
			// finishing in the background, must not restart its clock.
			name: "the turn a carried message opens is a running turn",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "bg"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 3 * time.Second, sent: true},
				{at: 4 * time.Second, event: agent.DoneEvent{}},
				{at: 6 * time.Second, sent: true},
				{at: 7 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundResult}},
				{at: 9 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{6000},
		},
		{
			// Stop may have thrown the message away with the turn, so the next
			// message is the one that starts the clock.
			name: "a Stop carries no message forward",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.TextEvent{Content: "working"}},
				{at: 2 * time.Second, sent: true},
				{at: 3 * time.Second, event: agent.InterruptedEvent{}},
				{at: 60 * time.Second, sent: true},
				{at: 62 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{2000},
		},
		{
			name: "background work finishing after a Stop opens nothing",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "bg"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 3 * time.Second, event: agent.InterruptedEvent{}},
				{at: 600 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundResult}},
				{at: 900 * time.Second, sent: true},
				{at: 905 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{5000},
		},
		{
			name: "a parked turn back by itself is a running turn",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "bg"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 3 * time.Second, event: agent.BackgroundWaitEvent{}},
				{at: 60 * time.Second, event: agent.TextEvent{Content: "back"}},
				{at: 61 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundResult}},
				{at: 64 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{4000},
		},
		{
			name: "background work finishing does not cut a thinking short",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "bg"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 5 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundResult}},
				{at: 8 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{6000},
		},
		{
			name: "but it is where a parked turn's quiet begins",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "bg"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 3 * time.Second, event: agent.BackgroundWaitEvent{}},
				{at: 60 * time.Second, event: agent.ToolResultEvent{ToolUseID: "bg", Subtype: agent.ToolResultBackgroundResult}},
				{at: 62 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{2000},
		},
		{
			name: "nothing to measure from leaves the duration out",
			steps: []clockStep{
				{at: 5 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{0},
		},
		{
			name: "nor after the turn ended",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.DoneEvent{}},
				{at: 60 * time.Second, event: agent.ThinkingEvent{}},
			},
			want: []int64{0},
		},
		{
			name: "a measured instant is never recorded as unmeasured",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 0, event: agent.ThinkingEvent{}},
			},
			want: []int64{1},
		},
		{
			name: "a subagent is measured on its own clock, from its spawn",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "task"}},
				{at: 2 * time.Second, event: agent.ToolCallEvent{ToolUseID: "t2"}},
				{at: 4 * time.Second, event: agent.ThinkingEvent{ParentToolUseID: "task"}},
				{at: 5 * time.Second, event: agent.TextEvent{ParentToolUseID: "task"}},
				{at: 6 * time.Second, event: agent.ThinkingEvent{}},
				{at: 7 * time.Second, event: agent.ThinkingEvent{ParentToolUseID: "task"}},
			},
			want: []int64{3000, 4000, 2000},
		},
		{
			name: "a backgrounded subagent outlives its placeholder",
			steps: []clockStep{
				{at: 0, sent: true},
				{at: 1 * time.Second, event: agent.ToolCallEvent{ToolUseID: "task"}},
				{at: 2 * time.Second, event: agent.ToolResultEvent{ToolUseID: "task", Subtype: agent.ToolResultBackgroundStarted}},
				{at: 3 * time.Second, event: agent.ThinkingEvent{ParentToolUseID: "task"}},
				{at: 4 * time.Second, event: agent.ToolResultEvent{ToolUseID: "task", Subtype: agent.ToolResultBackgroundResult}},
				{at: 5 * time.Second, event: agent.ThinkingEvent{ParentToolUseID: "task"}},
			},
			want: []int64{2000, 0},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := thinkingDurations(runClock(tt.steps)); !slices.Equal(got, tt.want) {
				t.Errorf("durations = %v, want %v", got, tt.want)
			}
		})
	}
}

// The CLI writes thinking_tokens several times a second; the client needs to
// hear once that a stretch of thinking began.
func TestThinkingClock_OneSignalPerStretch(t *testing.T) {
	got := runClock([]clockStep{
		{at: 0, sent: true},
		{at: 1 * time.Second, event: agent.ThinkingDeltaEvent{}},
		{at: 2 * time.Second, event: agent.ThinkingDeltaEvent{}},
		{at: 3 * time.Second, event: agent.ThinkingEvent{}},
		{at: 4 * time.Second, event: agent.ThinkingDeltaEvent{}},
		{at: 5 * time.Second, event: agent.ToolCallEvent{ToolUseID: "t1"}},
		{at: 6 * time.Second, event: agent.ThinkingDeltaEvent{}},
		{at: 7 * time.Second, event: agent.ThinkingDeltaEvent{}},
	})
	var signals int
	for _, ev := range got {
		if _, ok := ev.(agent.ThinkingDeltaEvent); ok {
			signals++
		}
	}
	if signals != 3 {
		t.Errorf("signals = %d, want 3 (one per stretch): %+v", signals, got)
	}
}

// Calls the turn never answered — a web search, whose result is not a tool
// result; a call cut off by Stop — must not pile up over a process's life, while
// a backgrounded subagent keeps its clock past the ending.
func TestThinkingClock_ForgetsWhatTheTurnLeftOpen(t *testing.T) {
	var c thinkingClock
	at := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	c.messageSent(at)
	for _, ev := range []agent.AgentEvent{
		agent.ToolCallEvent{ToolUseID: "search"},
		agent.ToolCallEvent{ToolUseID: "task"},
		agent.ToolResultEvent{ToolUseID: "task", Subtype: agent.ToolResultBackgroundStarted},
		agent.InterruptedEvent{},
	} {
		c.observe(ev, at)
	}
	if _, ok := c.since["search"]; ok {
		t.Error("an unanswered call outlived its turn")
	}
	if _, ok := c.since["task"]; !ok {
		t.Error("a backgrounded subagent lost its clock with the turn")
	}
}
