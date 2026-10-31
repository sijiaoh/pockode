package process

import (
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/canvas"
)

// canvasCalls links a canvas tool's result to the revision it drew.
//
// The MCP executor that applies a canvas call never learns the CLI's tool call
// id — an MCP call does not carry it — so the link is made here, from the
// other side: the call's name is known from its tool_call, and its result
// says the revision in its first line (canvas.RevisionFromResult). The
// revision is stamped on the result before it is recorded or broadcast, so the
// record carries it from the moment it exists (docs/canvas-ui.md §13.4).
type canvasCalls struct {
	callsMu sync.Mutex
	// pending are the canvas calls whose result has not arrived, by
	// tool_use_id.
	pending map[string]bool
}

// stamp notes a canvas call, or returns its result with the revision on it.
// Every other event comes back as it went in.
func (c *canvasCalls) stamp(event agent.AgentEvent) agent.AgentEvent {
	switch e := event.(type) {
	case agent.ToolCallEvent:
		if e.ToolUseID == "" || !canvas.IsTool(e.ToolName) {
			return event
		}
		c.callsMu.Lock()
		defer c.callsMu.Unlock()
		if c.pending == nil {
			c.pending = make(map[string]bool)
		}
		c.pending[e.ToolUseID] = true

	case agent.ToolResultEvent:
		c.callsMu.Lock()
		pending := c.pending[e.ToolUseID]
		delete(c.pending, e.ToolUseID)
		c.callsMu.Unlock()
		if !pending || e.IsError {
			return event
		}
		if revision, ok := canvas.RevisionFromResult(e.ToolResult); ok {
			e.CanvasRevision = revision
			return e
		}

	case agent.DoneEvent, agent.InterruptedEvent, agent.ErrorEvent:
		// A turn that is over leaves no call running, so a canvas call cut short
		// by a stop or a crashed CLI is never going to get its result. A canvas
		// call is never background work, unlike the calls toolActivity keeps.
		c.callsMu.Lock()
		clear(c.pending)
		c.callsMu.Unlock()
	}
	return event
}
