package process

import (
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/work"
)

// WorkLookup reads a work item by id. Satisfied by work.Store.
type WorkLookup interface {
	Get(id string) (work.Work, bool, error)
}

// workCalls names, on a Pockode work tool's successful result, the work the
// call acted on and its title at that moment (agent.WorkRef). It is
// pageCalls' counterpart, for the same reason: the MCP executor never learns
// the CLI's tool call id, so the record is stamped here, before it is recorded
// or broadcast.
//
// The work is read when the call is noted, for a call whose input names it, so
// the record says what the work was called when the call was made — and a
// work_delete still says what it deleted. A creation names no work until it
// has returned, so its work is read from the id its result reports
// (work.IDFromCreateResult).
//
// The stamp never carries a status: a record that said "active" would be
// wrong the moment the work stopped. What is true of the work now is the work
// store's.
type workCalls struct {
	mu sync.Mutex
	// pending are the work tool calls whose result has not arrived, by
	// tool_use_id: the work as it was when the call was noted, or nil for a
	// creation. Not cleared when a turn ends, as pageCalls' are not.
	pending map[string]*agent.WorkRef
}

// stamp notes a work tool call, or returns its result with the work on it.
// Every other event comes back as it went in, and so does every event when
// there is no work store to read (lookup nil).
func (c *workCalls) stamp(event agent.AgentEvent, lookup WorkLookup) agent.AgentEvent {
	if lookup == nil {
		return event
	}
	switch e := event.(type) {
	case agent.ToolCallEvent:
		tool, ok := agent.PockodeTool(e.ToolName)
		if e.ToolUseID == "" || !ok {
			return event
		}
		id, creates, ok := work.ToolTarget(tool, e.ToolInput)
		if !ok {
			return event
		}
		var ref *agent.WorkRef
		if !creates {
			// An id that names no work leaves nothing to stamp.
			if ref = refOf(lookup, id); ref == nil {
				return event
			}
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if c.pending == nil {
			c.pending = make(map[string]*agent.WorkRef)
		}
		c.pending[e.ToolUseID] = ref

	case agent.ToolResultEvent:
		c.mu.Lock()
		ref, pending := c.pending[e.ToolUseID]
		delete(c.pending, e.ToolUseID)
		c.mu.Unlock()
		if !pending || e.IsError {
			return event
		}
		if ref == nil {
			id, ok := work.IDFromCreateResult(e.ToolResult)
			if !ok {
				return event
			}
			if ref = refOf(lookup, id); ref == nil {
				return event
			}
		}
		e.WorkRef = ref
		return e
	}
	return event
}

func refOf(lookup WorkLookup, id string) *agent.WorkRef {
	w, found, err := lookup.Get(id)
	if err != nil || !found {
		return nil
	}
	return &agent.WorkRef{ID: w.ID, Type: string(w.Type()), Title: w.Title}
}
