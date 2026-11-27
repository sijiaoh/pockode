package claude

import (
	"encoding/json"
	"math"
	"sync"
)

// toolCallNames remembers which tool each open call is, so a result can be read
// by the tool that produced it. A user frame names only the tool_use_id, and
// what its tool_use_result means depends on the tool: the duration fields below
// are each one tool's own, and the same key in an MCP tool's structured output
// is that server's data, not a measurement of the call.
//
// Per-process live state, like backgroundTaskTracker: a resumed process never
// sees a result for a call the previous one made.
type toolCallNames struct {
	namesMu sync.Mutex
	names   map[string]string
}

func (n *toolCallNames) record(toolUseID, name string) {
	if toolUseID == "" {
		return
	}
	n.namesMu.Lock()
	defer n.namesMu.Unlock()
	if n.names == nil {
		n.names = make(map[string]string)
	}
	n.names[toolUseID] = name
}

// take returns the call's tool and forgets it: a call has one result of its
// own (a background outcome arrives through task_notification, not here).
func (n *toolCallNames) take(toolUseID string) string {
	n.namesMu.Lock()
	defer n.namesMu.Unlock()
	name := n.names[toolUseID]
	delete(n.names, toolUseID)
	return name
}

// toolUseResultDurations is every duration Claude reports in a result's
// tool_use_result, measured on claude 2.1.330. Each is the CLI's own
// measurement of the call: the subagent's totalDurationMs (also what it tells
// the model as <usage>duration_ms</usage>), WebFetch's durationMs and
// WebSearch's durationSeconds. Bash and the other built-in tools report none.
type toolUseResultDurations struct {
	TotalDurationMs *float64 `json:"totalDurationMs"`
	DurationMs      *float64 `json:"durationMs"`
	DurationSeconds *float64 `json:"durationSeconds"`
}

// reportedDurationMs is the duration the CLI reported for one finished call,
// in milliseconds, or 0 when it reported none. Zero and negative figures count
// as none: WebSearch writes durationSeconds 0 for a search it refused without
// running, and 0 is the wire's "not reported".
func reportedDurationMs(toolName string, toolUseResult json.RawMessage) int64 {
	if len(toolUseResult) == 0 || toolUseResult[0] != '{' {
		return 0
	}
	var d toolUseResultDurations
	if err := json.Unmarshal(toolUseResult, &d); err != nil {
		return 0
	}

	var ms *float64
	scale := 1.0
	switch toolName {
	case "Agent", "Task":
		ms = d.TotalDurationMs
	case "WebFetch":
		ms = d.DurationMs
	case "WebSearch":
		ms, scale = d.DurationSeconds, 1000
	}
	if ms == nil {
		return 0
	}
	return max(int64(math.Round(*ms*scale)), 0)
}
