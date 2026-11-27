package claude

import (
	"encoding/json"

	"github.com/pockode/server/agent"
)

// isSubagentTool reports whether a tool runs a subagent: Agent, and Task, the
// name it had before.
func isSubagentTool(toolName string) bool {
	return toolName == "Agent" || toolName == "Task"
}

// subagentToolUseResult is the part of a subagent call's tool_use_result that
// says who ran and what it did, measured on claude 2.1.330. A call that ran
// inside its turn carries all of it; the placeholder of a backgrounded one
// carries only agentId (its status is async_launched), and the figures come
// later on task_notification.
//
// Read here rather than out of the result text, which on older CLIs ended in
// `agentId: …` and `<usage>…</usage>` lines: that text is written for the
// model, and 2.1.330 no longer puts either line in it.
type subagentToolUseResult struct {
	AgentID           string `json:"agentId"`
	AgentType         string `json:"agentType"`
	TotalTokens       *int64 `json:"totalTokens"`
	TotalToolUseCount *int64 `json:"totalToolUseCount"`
}

// reportedSubagent is what the CLI said about the subagent a finished call ran,
// or nil when the call is not a subagent's or the CLI said nothing about it.
//
// totalToolUseCount is the same counter task_progress reports live as
// usage.tool_uses: on 2.1.330 a subagent that made three calls reported 1, 2, 3
// live, then 3 on its notification and 3 here.
//
// Read only from a frame holding one result, like a duration (see
// parseUserEvent), and that costs no subagent: two run in parallel hand back
// in a frame each, each with its own tool_use_result (measured on 2.1.330).
func reportedSubagent(toolName string, toolUseResult json.RawMessage) *agent.SubagentReport {
	if !isSubagentTool(toolName) || len(toolUseResult) == 0 || toolUseResult[0] != '{' {
		return nil
	}
	var r subagentToolUseResult
	if err := json.Unmarshal(toolUseResult, &r); err != nil {
		return nil
	}
	return subagentReport(agent.SubagentReport{
		AgentID:   r.AgentID,
		AgentType: r.AgentType,
		SubagentCounts: agent.SubagentCounts{
			ToolUses:    r.TotalToolUseCount,
			TotalTokens: r.TotalTokens,
		},
	})
}

// subagentReport is the report, or nil when it says nothing at all — so a
// record never carries an empty object that reads as "reported, and blank".
func subagentReport(r agent.SubagentReport) *agent.SubagentReport {
	if r == (agent.SubagentReport{}) {
		return nil
	}
	return &r
}
