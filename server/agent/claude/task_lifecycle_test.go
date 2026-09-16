package claude

import (
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/contents"
)

// Every frame here is one measured on claude 2.1.263, trimmed of the fields this
// code does not read. Two runs are represented: a backgrounded `Bash`, and a
// subagent Task that ran inside its own call.
const (
	bgTaskStarted = `{"type":"system","subtype":"task_started","task_id":"b6h7boemy","tool_use_id":"toolu_bg","description":"Run tick loop in background","is_backgrounded":true,"task_type":"local_bash"}`
	bgPlaceholder = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg","content":"Command running in background with ID: b6h7boemy.","is_error":false}]}}`
	bgUpdated     = `{"type":"system","subtype":"task_updated","task_id":"b6h7boemy","patch":{"status":"completed","end_time":1789544855991}}`
	bgNotified    = `{"type":"system","subtype":"task_notification","task_id":"b6h7boemy","tool_use_id":"toolu_bg","status":"completed","output_file":"/tmp/tasks/b6h7boemy.output","summary":"Background command \"Run tick loop\" completed (exit code 0)"}`
	bgStopped     = `{"type":"system","subtype":"task_notification","task_id":"b6h7boemy","tool_use_id":"toolu_bg","status":"stopped","summary":""}`

	inlineTaskStarted  = `{"type":"system","subtype":"task_started","task_id":"a39586","tool_use_id":"toolu_task","description":"List /etc files starting with h","subagent_type":"Explore","is_backgrounded":false,"task_type":"local_agent"}`
	inlineTaskProgress = `{"type":"system","subtype":"task_progress","task_id":"a39586","tool_use_id":"toolu_task","description":"Running List /etc files starting with h","subagent_type":"Explore","last_tool_name":"Bash"}`
	inlineTaskNotified = `{"type":"system","subtype":"task_notification","task_id":"a39586","tool_use_id":"toolu_task","status":"completed","summary":"Files in /etc starting with h: ..."}`

	ambientTaskStarted  = `{"type":"system","subtype":"task_started","task_id":"amb1","tool_use_id":"toolu_amb","description":"watch","ambient":true}`
	ambientTaskProgress = `{"type":"system","subtype":"task_progress","task_id":"amb1","tool_use_id":"toolu_amb","summary":"still watching"}`
	orphanTaskProgress  = `{"type":"system","subtype":"task_progress","task_id":"nobody","summary":"housekeeping"}`
)

// The join that problem this exists for: a progress frame is about one call, and
// the row it belongs to is what makes it worth showing.
func TestParseTaskEvent_ProgressBecomesActivityOnTheCall(t *testing.T) {
	tracker := &backgroundTaskTracker{}

	if events := parseTestLineWithTracker(testLogger(), []byte(inlineTaskStarted), tracker); events != nil {
		t.Fatalf("task_started should produce no event of its own, got %#v", events)
	}

	events := parseTestLineWithTracker(testLogger(), []byte(inlineTaskProgress), tracker)
	if len(events) != 1 {
		t.Fatalf("expected one activity event, got %#v", events)
	}
	activity, ok := events[0].(agent.ToolActivityEvent)
	if !ok {
		t.Fatalf("expected a ToolActivityEvent, got %#v", events[0])
	}
	if activity.ToolUseID != "toolu_task" {
		t.Errorf("activity joined to %q, want the call that started the task", activity.ToolUseID)
	}
	// claude 2.1.263 sends no summary on task_progress, only a description.
	if activity.Activity != "Running List /etc files starting with h" {
		t.Errorf("activity text = %q", activity.Activity)
	}
}

// A task nobody called — scheduled or housekeeping work — has no row to belong
// to, and a progress line with nothing behind it is worse than silence.
func TestParseTaskEvent_ProgressWithNoCallBehindItIsDropped(t *testing.T) {
	for _, tt := range []struct {
		name  string
		lines []string
	}{
		{"no tool_use_id anywhere", []string{orphanTaskProgress}},
		{"ambient task", []string{ambientTaskStarted, ambientTaskProgress}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tracker := &backgroundTaskTracker{}
			for _, line := range tt.lines {
				if events := parseTestLineWithTracker(testLogger(), []byte(line), tracker); events != nil {
					t.Fatalf("expected nothing for %q, got %#v", line, events)
				}
			}
		})
	}
}

// The whole of problem 1: the call hands back a placeholder, and the outcome
// arrives later on a channel of its own. Both records have to say which they
// are, or a replayed transcript reports unfinished work as successful.
func TestParseTaskEvent_BackgroundedCallIsStampedThenSuperseded(t *testing.T) {
	tracker := &backgroundTaskTracker{}

	parseTestLineWithTracker(testLogger(), []byte(bgTaskStarted), tracker)

	placeholder := parseTestLineWithTracker(testLogger(), []byte(bgPlaceholder), tracker)
	if len(placeholder) != 1 {
		t.Fatalf("expected the placeholder result, got %#v", placeholder)
	}
	first, ok := placeholder[0].(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("expected a ToolResultEvent, got %#v", placeholder[0])
	}
	if first.Subtype != agent.ToolResultBackgroundStarted {
		t.Errorf("placeholder subtype = %q, want %q", first.Subtype, agent.ToolResultBackgroundStarted)
	}

	if events := parseTestLineWithTracker(testLogger(), []byte(bgUpdated), tracker); events != nil {
		t.Fatalf("task_updated says nothing task_notification does not, got %#v", events)
	}

	outcome := parseTestLineWithTracker(testLogger(), []byte(bgNotified), tracker)
	if len(outcome) != 1 {
		t.Fatalf("expected the background outcome, got %#v", outcome)
	}
	result, ok := outcome[0].(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("expected a ToolResultEvent, got %#v", outcome[0])
	}
	if result.ToolUseID != "toolu_bg" {
		t.Errorf("outcome joined to %q, want the originating call", result.ToolUseID)
	}
	if result.Subtype != agent.ToolResultBackgroundResult {
		t.Errorf("outcome subtype = %q, want %q", result.Subtype, agent.ToolResultBackgroundResult)
	}
	if result.IsError {
		t.Error("a completed task is not an error")
	}

	// The log is named, not delivered.
	if len(result.Contents) != 2 {
		t.Fatalf("expected the summary and the log file, got %#v", result.Contents)
	}
	if result.ToolResult != "" {
		t.Errorf("a result carrying blocks must leave ToolResult empty, got %q", result.ToolResult)
	}
	file := result.Contents[1].File
	if file == nil || file.Path != "/tmp/tasks/b6h7boemy.output" {
		t.Fatalf("expected the output file to be named, got %#v", result.Contents[1])
	}
	if file.AttachmentID != "" || file.Omitted != contents.OmitNotFetched {
		t.Errorf("the log must be named rather than read, got %#v", file)
	}
}

// A task that did not finish did not produce what the agent was promised, and
// the CLI leaves the summary empty when it was killed.
func TestParseTaskEvent_StoppedBackgroundTaskIsReportedAsAFailure(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(bgTaskStarted), tracker)
	parseTestLineWithTracker(testLogger(), []byte(bgPlaceholder), tracker)

	events := parseTestLineWithTracker(testLogger(), []byte(bgStopped), tracker)
	if len(events) != 1 {
		t.Fatalf("expected the background outcome, got %#v", events)
	}
	result := events[0].(agent.ToolResultEvent)
	if !result.IsError {
		t.Error("a stopped task must not look like a success")
	}
	if result.ToolResult == "" {
		t.Error("a task that reported no summary still needs words, or the row is blank")
	}
}

// A subagent Task runs inside its call and its real result follows the
// notification (measured), so emitting here too would record the outcome twice.
func TestParseTaskEvent_InlineTaskNotificationIsDropped(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(inlineTaskStarted), tracker)

	if events := parseTestLineWithTracker(testLogger(), []byte(inlineTaskNotified), tracker); events != nil {
		t.Fatalf("expected nothing for a task that reports through its own call, got %#v", events)
	}
}

// An ordinary call's result is untouched: the stamp belongs to backgrounded work
// alone, and it must not leak to the call after it.
func TestParseTaskEvent_OrdinaryResultIsNotStamped(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(bgTaskStarted), tracker)
	parseTestLineWithTracker(testLogger(), []byte(bgPlaceholder), tracker)
	parseTestLineWithTracker(testLogger(), []byte(bgNotified), tracker)

	const other = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_other","content":"ok"}]}}`
	events := parseTestLineWithTracker(testLogger(), []byte(other), tracker)
	if len(events) != 1 {
		t.Fatalf("expected one result, got %#v", events)
	}
	if subtype := events[0].(agent.ToolResultEvent).Subtype; subtype != "" {
		t.Errorf("an ordinary result carries no subtype, got %q", subtype)
	}

	// And the same call replayed after the outcome: the tracker forgot it, so
	// nothing is stamped retroactively either.
	replay := parseTestLineWithTracker(testLogger(), []byte(bgPlaceholder), tracker)
	if subtype := replay[0].(agent.ToolResultEvent).Subtype; subtype != "" {
		t.Errorf("a settled call must not be stamped again, got %q", subtype)
	}
}

// The tracker is live state on a process that can run for hours, so every task
// it learns about has to be forgotten again — including the ones whose frames
// never produce anything, which nothing else would ever clear.
func TestParseTaskEvent_EveryFinishedTaskIsForgotten(t *testing.T) {
	tracker := &backgroundTaskTracker{}

	lines := []string{
		bgTaskStarted, bgNotified, // backgrounded, produced a record
		inlineTaskStarted, inlineTaskNotified, // ran inside its call, dropped
		ambientTaskStarted, `{"type":"system","subtype":"task_notification","task_id":"amb1","tool_use_id":"toolu_amb","status":"completed"}`,
	}
	for _, line := range lines {
		parseTestLineWithTracker(testLogger(), []byte(line), tracker)
	}

	tracker.tasksMu.Lock()
	defer tracker.tasksMu.Unlock()
	if len(tracker.tasks) != 0 {
		t.Errorf("tasks left behind: %v", tracker.tasks)
	}
	if len(tracker.backgroundedCalls) != 0 {
		t.Errorf("backgrounded calls left behind: %v", tracker.backgroundedCalls)
	}
}
