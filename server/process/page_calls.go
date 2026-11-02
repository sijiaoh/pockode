package process

import (
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/htmlpage"
)

// pageCalls links a page tool's result to the page it stored.
//
// The MCP executor that stores a page never learns the CLI's tool call id — an
// MCP call does not carry it — so the link is made here, from the other side:
// the call's name is known from its tool_call, and its result begins with the
// page id (htmlpage.IDFromResult). The id is stamped on the result before it is
// recorded or broadcast, so the record carries it from the moment it exists.
//
// The name has to be checked, not just the text: any other tool's output may
// happen to begin with the same words.
type pageCalls struct {
	callsMu sync.Mutex
	// pending are the page tool calls whose result has not arrived, by
	// tool_use_id. Not cleared when a turn ends: a backgrounded subagent's call
	// can return after the turn that started it, and still stored a page.
	// A call that never returns costs one entry for the life of the process.
	pending map[string]bool
}

// stamp notes a page tool call, or returns its result with the page id on it.
// Every other event comes back as it went in.
func (c *pageCalls) stamp(event agent.AgentEvent) agent.AgentEvent {
	switch e := event.(type) {
	case agent.ToolCallEvent:
		if e.ToolUseID == "" || !htmlpage.IsPageTool(e.ToolName) {
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
		if id, ok := htmlpage.IDFromResult(e.ToolResult); ok {
			e.HTMLPage = id
			return e
		}
	}
	return event
}
