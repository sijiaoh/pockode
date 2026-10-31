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
//
// It is also what says a canvas call is still in flight, for a fork from a
// page whose result has not been recorded yet (canvas.ForkPending,
// Manager.CanvasLive).
type canvasCalls struct {
	callsMu sync.Mutex
	// pending are the canvas calls whose result has not been recorded, by
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
		c.callsMu.Unlock()
		if !pending || e.IsError {
			return event
		}
		if revision, ok := canvas.RevisionFromResult(e.ToolResult); ok {
			e.CanvasRevision = revision
			return e
		}
	}
	return event
}

// settle forgets what an event ended, once it has been recorded. Not at
// stamp: a call is in flight until its result is in history, or a fork asked
// for in between would find the page neither pending nor recorded.
func (c *canvasCalls) settle(event agent.AgentEvent) {
	switch e := event.(type) {
	case agent.ToolResultEvent:
		c.callsMu.Lock()
		delete(c.pending, e.ToolUseID)
		c.callsMu.Unlock()

	case agent.DoneEvent, agent.InterruptedEvent, agent.ErrorEvent, agent.ProcessEndedEvent:
		// A turn that is over leaves no call running, so a canvas call cut short
		// by a stop or a crashed CLI is never going to get its result. The
		// process ending is cleared here too, not left to the process being
		// dropped: a list read in between would still find the call in flight,
		// and the client reads it on this very record (docs/canvas-ui.md §15.3). A canvas
		// call is never background work, unlike the calls toolActivity keeps.
		c.callsMu.Lock()
		clear(c.pending)
		c.callsMu.Unlock()
	}
}

func (c *canvasCalls) inFlight() bool {
	c.callsMu.Lock()
	defer c.callsMu.Unlock()
	return len(c.pending) > 0
}
