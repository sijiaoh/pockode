package claude

import (
	"fmt"
	"testing"

	"github.com/pockode/server/agent"
)

func toolUseLine(id, name string) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"content":[{"type":"tool_use","id":%q,"name":%q,"input":{}}]}}`, id, name)
}

// resultLine is a user frame carrying one tool_result, with toolUseResult as
// the frame's tool_use_result ("" for none).
func resultLine(id, toolUseResult string) string {
	extra := ""
	if toolUseResult != "" {
		extra = `,"tool_use_result":` + toolUseResult
	}
	return fmt.Sprintf(`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":%q,"content":"ok"}]}%s}`, id, extra)
}

func toolResults(events []agent.AgentEvent) []agent.ToolResultEvent {
	var results []agent.ToolResultEvent
	for _, ev := range events {
		if r, ok := ev.(agent.ToolResultEvent); ok {
			results = append(results, r)
		}
	}
	return results
}

// The durations below are the shapes claude 2.1.330 writes into tool_use_result,
// trimmed of the fields this code does not read.
func TestToolResult_CarriesTheDurationTheCLIReported(t *testing.T) {
	for _, tt := range []struct {
		name          string
		tool          string
		toolUseResult string
		want          int64
	}{
		{"subagent", "Agent", `{"status":"completed","agentId":"a1","totalDurationMs":72345,"totalTokens":100}`, 72345},
		{"subagent under the older tool name", "Task", `{"status":"completed","totalDurationMs":1500}`, 1500},
		{"WebFetch", "WebFetch", `{"url":"https://example.com","code":200,"bytes":10,"durationMs":842}`, 842},
		{"WebSearch, reported in seconds", "WebSearch", `{"query":"q","results":[],"durationSeconds":3.2156}`, 3216},
		{"WebSearch it refused without running", "WebSearch", `{"query":"q","results":[],"durationSeconds":0}`, 0},
		{"Bash, which reports none", "Bash", `{"stdout":"hi","stderr":"","interrupted":false}`, 0},
		// An MCP tool's structured output is the server's data: a durationMs
		// there is whatever that server means by it.
		{"MCP tool with a durationMs of its own", "mcp__media__probe", `{"durationMs":90000}`, 0},
		{"a subagent field on another tool", "WebFetch", `{"totalDurationMs":5000}`, 0},
		{"no tool_use_result", "Agent", ``, 0},
		{"tool_use_result that is not an object", "Agent", `"Error: boom"`, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			results := toolResults(parseTestTurns(t, toolUseLine("toolu_1", tt.tool), resultLine("toolu_1", tt.toolUseResult)))
			if len(results) != 1 {
				t.Fatalf("expected one result, got %#v", results)
			}
			if got := results[0].DurationMs; got != tt.want {
				t.Errorf("DurationMs = %d, want %d", got, tt.want)
			}
			if got := results[0].ToRecord().DurationMs; got != tt.want {
				t.Errorf("record duration_ms = %d, want %d", got, tt.want)
			}
		})
	}
}

// tool_use_result is one per frame: with two results in the frame there is no
// saying whose it is.
func TestToolResult_FrameWithSeveralResultsCarriesNoDuration(t *testing.T) {
	frame := `{"type":"user","message":{"role":"user","content":[` +
		`{"type":"tool_result","tool_use_id":"toolu_1","content":"a"},` +
		`{"type":"tool_result","tool_use_id":"toolu_2","content":"b"}` +
		`]},"tool_use_result":{"totalDurationMs":72345}}`

	results := toolResults(parseTestTurns(t, toolUseLine("toolu_1", "Agent"), toolUseLine("toolu_2", "Agent"), frame))
	if len(results) != 2 {
		t.Fatalf("expected two results, got %#v", results)
	}
	for _, r := range results {
		if r.DurationMs != 0 {
			t.Errorf("%s: DurationMs = %d, want none", r.ToolUseID, r.DurationMs)
		}
	}
}

// A backgrounded subagent's figure is how long it worked, so it belongs on the
// outcome — never on the placeholder, even one that carried a duration.
func TestToolResult_BackgroundSubagentDurationIsOnItsOutcome(t *testing.T) {
	const (
		started     = `{"type":"system","subtype":"task_started","task_id":"a9","tool_use_id":"toolu_bg","description":"Survey","is_backgrounded":true,"task_type":"local_agent"}`
		placeholder = `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_bg","content":"Async agent launched"}]},"tool_use_result":{"status":"async_launched","isAsync":true,"agentId":"a9","totalDurationMs":12}}`
		notified    = `{"type":"system","subtype":"task_notification","task_id":"a9","tool_use_id":"toolu_bg","status":"completed","summary":"done","usage":{"total_tokens":900,"tool_uses":4,"duration_ms":61000}}`
	)

	results := toolResults(parseTestTurns(t, toolUseLine("toolu_bg", "Agent"), started, placeholder, notified))
	if len(results) != 2 {
		t.Fatalf("expected the placeholder and the outcome, got %#v", results)
	}
	if results[0].Subtype != agent.ToolResultBackgroundStarted || results[0].DurationMs != 0 {
		t.Errorf("placeholder = subtype %q, duration %d; want %q with none", results[0].Subtype, results[0].DurationMs, agent.ToolResultBackgroundStarted)
	}
	if results[1].Subtype != agent.ToolResultBackgroundResult || results[1].DurationMs != 61000 {
		t.Errorf("outcome = subtype %q, duration %d; want %q with 61000", results[1].Subtype, results[1].DurationMs, agent.ToolResultBackgroundResult)
	}
}

// usage is optional on task_notification; an outcome without it has no figure
// rather than a zero one.
func TestToolResult_BackgroundOutcomeWithoutUsageCarriesNoDuration(t *testing.T) {
	results := toolResults(parseTestTurns(t, toolUseLine("toolu_bg", "Bash"), bgTaskStarted, bgPlaceholder, bgNotified))
	if len(results) != 2 {
		t.Fatalf("expected the placeholder and the outcome, got %#v", results)
	}
	for _, r := range results {
		if r.DurationMs != 0 {
			t.Errorf("%s: DurationMs = %d, want none", r.Subtype, r.DurationMs)
		}
	}
}
