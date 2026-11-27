package claude

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/agent"
)

// Frames measured on claude 2.1.330, trimmed of the fields this code does not
// read: an Explore subagent that ran inside its call and made three tool calls,
// and one that was backgrounded and made two.
const (
	inlineAgentStarted   = `{"type":"system","subtype":"task_started","task_id":"ae19cb8dafaf11f70","tool_use_id":"toolu_fg","description":"Run shell probe and read hosts","subagent_type":"Explore","is_backgrounded":false,"spawn_depth":1,"task_type":"local_agent"}`
	inlineAgentProgress1 = `{"type":"system","subtype":"task_progress","task_id":"ae19cb8dafaf11f70","tool_use_id":"toolu_fg","description":"Running List first entries of /etc","subagent_type":"Explore","usage":{"total_tokens":14365,"tool_uses":1,"duration_ms":1814},"last_tool_name":"Bash"}`
	inlineAgentProgress3 = `{"type":"system","subtype":"task_progress","task_id":"ae19cb8dafaf11f70","tool_use_id":"toolu_fg","description":"Reading /etc/hosts","subagent_type":"Explore","usage":{"total_tokens":14408,"tool_uses":3,"duration_ms":2134},"last_tool_name":"Read"}`
	inlineAgentNotified  = `{"type":"system","subtype":"task_notification","task_id":"ae19cb8dafaf11f70","tool_use_id":"toolu_fg","status":"completed","summary":"Outputs from all three steps","usage":{"total_tokens":15778,"tool_uses":3,"duration_ms":4138}}`
	inlineAgentHandBack  = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_fg","type":"tool_result","content":[{"type":"text","text":"  <tools-used-before-summary>Bash, Read</tools-used-before-summary>\n  \n[Subagent hand-back] The report follows:\n  Outputs from all three steps"}]}]},"parent_tool_use_id":null,"tool_use_result":{"status":"completed","agentId":"ae19cb8dafaf11f70","agentType":"Explore","toolsUsed":["Bash","Read"],"totalDurationMs":4140,"totalTokens":15778,"totalToolUseCount":3}}`

	bgAgentStarted     = `{"type":"system","subtype":"task_started","task_id":"abab96af65c2bfeb9","tool_use_id":"toolu_bga","description":"Run two ls commands","subagent_type":"Explore","is_backgrounded":true,"spawn_depth":1,"task_type":"local_agent"}`
	bgAgentPlaceholder = `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_bga","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully."}]}]},"parent_tool_use_id":null,"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"abab96af65c2bfeb9","description":"Run two ls commands"}}`
	bgAgentProgress    = `{"type":"system","subtype":"task_progress","task_id":"abab96af65c2bfeb9","tool_use_id":"toolu_bga","description":"Running List first three entries in /tmp","subagent_type":"Explore","usage":{"total_tokens":12737,"tool_uses":2,"duration_ms":1930},"last_tool_name":"Bash"}`
	bgAgentNotified    = `{"type":"system","subtype":"task_notification","task_id":"abab96af65c2bfeb9","tool_use_id":"toolu_bga","status":"completed","summary":"Both commands ran successfully, in order.","summary_is_report":true,"usage":{"total_tokens":13842,"tool_uses":2,"duration_ms":3895}}`
)

func int64p(v int64) *int64 { return &v }

func toolActivities(events []agent.AgentEvent) []agent.ToolActivityEvent {
	var out []agent.ToolActivityEvent
	for _, ev := range events {
		if a, ok := ev.(agent.ToolActivityEvent); ok {
			out = append(out, a)
		}
	}
	return out
}

// What the row says while a subagent runs and what it says once it is over
// must count the same thing, or a count shrinks or jumps as the run finishes.
// Both come from the CLI's own counter, and on 2.1.330 they agree.
func TestSubagent_InlineRunReportsLiveAndFinalFromTheSameCounter(t *testing.T) {
	events := parseTestTurns(t,
		toolUseLine("toolu_fg", "Agent"),
		inlineAgentStarted, inlineAgentProgress1, inlineAgentProgress3, inlineAgentNotified, inlineAgentHandBack,
	)

	activities := toolActivities(events)
	if len(activities) != 2 {
		t.Fatalf("expected two activities, got %#v", activities)
	}
	want := []agent.SubagentProgress{
		{SubagentCounts: agent.SubagentCounts{ToolUses: int64p(1), TotalTokens: int64p(14365)}, LastToolName: "Bash"},
		{SubagentCounts: agent.SubagentCounts{ToolUses: int64p(3), TotalTokens: int64p(14408)}, LastToolName: "Read"},
	}
	for i, a := range activities {
		if a.Subagent == nil {
			t.Fatalf("activity %d carries no progress", i)
		}
		if got := *a.Subagent; *got.ToolUses != *want[i].ToolUses || *got.TotalTokens != *want[i].TotalTokens || got.LastToolName != want[i].LastToolName {
			t.Errorf("activity %d progress = %s, want %s", i, mustJSON(t, got), mustJSON(t, want[i]))
		}
		if a.Activity == "" {
			t.Errorf("activity %d lost its line", i)
		}
	}

	results := toolResults(events)
	if len(results) != 1 {
		t.Fatalf("expected the hand-back alone (an inline notification is not recorded), got %#v", results)
	}
	report := results[0].Subagent
	if report == nil {
		t.Fatal("the hand-back carries no subagent report")
	}
	wantReport := agent.SubagentReport{AgentID: "ae19cb8dafaf11f70", AgentType: "Explore", SubagentCounts: agent.SubagentCounts{ToolUses: int64p(3), TotalTokens: int64p(15778)}}
	if mustJSON(t, *report) != mustJSON(t, wantReport) {
		t.Errorf("report = %s, want %s", mustJSON(t, *report), mustJSON(t, wantReport))
	}
	if *report.ToolUses != *activities[len(activities)-1].Subagent.ToolUses {
		t.Errorf("final tool uses %d disagree with the last live count %d", *report.ToolUses, *activities[len(activities)-1].Subagent.ToolUses)
	}
	if results[0].DurationMs != 4140 {
		t.Errorf("DurationMs = %d, want the hand-back's totalDurationMs", results[0].DurationMs)
	}

	var record map[string]json.RawMessage
	if err := json.Unmarshal([]byte(mustJSON(t, results[0].ToRecord())), &record); err != nil {
		t.Fatal(err)
	}
	if got := string(record["subagent"]); got != `{"agent_id":"ae19cb8dafaf11f70","agent_type":"Explore","tool_uses":3,"total_tokens":15778}` {
		t.Errorf("record subagent = %s", got)
	}
}

// A backgrounded subagent's placeholder already names it; the figures are what
// it did, so they come with the outcome, which the notification alone could
// not name.
func TestSubagent_BackgroundRunReportsOnItsOutcome(t *testing.T) {
	events := parseTestTurns(t,
		toolUseLine("toolu_bga", "Agent"),
		bgAgentStarted, bgAgentPlaceholder, bgAgentProgress, bgAgentNotified,
	)

	results := toolResults(events)
	if len(results) != 2 {
		t.Fatalf("expected the placeholder and the outcome, got %#v", results)
	}
	placeholder, outcome := results[0], results[1]
	if placeholder.Subagent == nil || mustJSON(t, *placeholder.Subagent) != `{"agent_id":"abab96af65c2bfeb9"}` {
		t.Errorf("placeholder report = %#v, want the agent id alone", placeholder.Subagent)
	}

	wantOutcome := `{"agent_id":"abab96af65c2bfeb9","agent_type":"Explore","tool_uses":2,"total_tokens":13842}`
	if outcome.Subagent == nil || mustJSON(t, *outcome.Subagent) != wantOutcome {
		t.Errorf("outcome report = %#v, want %s", outcome.Subagent, wantOutcome)
	}
	if outcome.DurationMs != 3895 {
		t.Errorf("outcome DurationMs = %d, want 3895", outcome.DurationMs)
	}

	activities := toolActivities(events)
	if len(activities) != 1 || activities[0].Subagent == nil || *activities[0].Subagent.ToolUses != *outcome.Subagent.ToolUses {
		t.Errorf("live progress %#v should end on the outcome's count", activities)
	}
}

// Usage on any other task is not a subagent's work, and drawn on its row it
// would read as one.
func TestSubagent_OtherTasksCarryNoSubagentFigures(t *testing.T) {
	const (
		started  = `{"type":"system","subtype":"task_started","task_id":"b1","tool_use_id":"toolu_sh","description":"tick","is_backgrounded":true,"task_type":"local_bash"}`
		progress = `{"type":"system","subtype":"task_progress","task_id":"b1","tool_use_id":"toolu_sh","description":"Running tick","usage":{"total_tokens":0,"tool_uses":0,"duration_ms":10}}`
		notified = `{"type":"system","subtype":"task_notification","task_id":"b1","tool_use_id":"toolu_sh","status":"completed","summary":"done","usage":{"total_tokens":0,"tool_uses":0,"duration_ms":900}}`
	)
	events := parseTestTurns(t, toolUseLine("toolu_sh", "Bash"), started, bgPlaceholderFor("toolu_sh"), progress, notified)
	for _, a := range toolActivities(events) {
		if a.Subagent != nil {
			t.Errorf("activity carries subagent progress %#v", a.Subagent)
		}
	}
	for _, r := range toolResults(events) {
		if r.Subagent != nil {
			t.Errorf("%s result carries a subagent report %#v", r.Subtype, r.Subagent)
		}
	}
}

// A CLI that reports nothing about the subagent leaves no empty object behind
// that would read as "reported, and blank".
func TestSubagent_NothingReportedIsNoReport(t *testing.T) {
	for _, tt := range []struct {
		name          string
		toolUseResult string
	}{
		{"no tool_use_result", ``},
		{"none of the subagent fields", `{"status":"completed","totalDurationMs":1500}`},
		{"not an object", `"Error: boom"`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			results := toolResults(parseTestTurns(t, toolUseLine("toolu_1", "Task"), resultLine("toolu_1", tt.toolUseResult)))
			if len(results) != 1 {
				t.Fatalf("expected one result, got %#v", results)
			}
			if results[0].Subagent != nil {
				t.Errorf("Subagent = %#v, want nil", results[0].Subagent)
			}
		})
	}

	// The same fields on another tool's result are that tool's own data.
	results := toolResults(parseTestTurns(t, toolUseLine("toolu_2", "mcp__x__y"), resultLine("toolu_2", `{"agentId":"a","totalToolUseCount":2}`)))
	if len(results) != 1 || results[0].Subagent != nil {
		t.Errorf("non-subagent tool got a report: %#v", results)
	}
}

func bgPlaceholderFor(id string) string {
	return `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"Command running in background."}]}}`
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
