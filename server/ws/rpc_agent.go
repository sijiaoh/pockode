package ws

import (
	"context"
	"slices"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// handleAgentList answers with what each registered agent declares about itself.
//
// Plain request/response rather than a subscription: the answers come from the
// agent implementations compiled into this server, so they cannot change while
// it runs. Sorted so the list reads the same on every call.
func (h *rpcMethodHandler) handleAgentList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	supports := h.worktreeManager.AgentForkSupports()

	types := make([]session.AgentType, 0, len(supports))
	for agentType := range supports {
		types = append(types, agentType)
	}
	slices.Sort(types)

	agents := make([]rpc.AgentInfo, len(types))
	for i, agentType := range types {
		agents[i] = rpc.AgentInfo{Type: agentType, ForkSupport: supports[agentType]}
	}

	if err := conn.Reply(ctx, req.ID, rpc.AgentListResult{Agents: agents}); err != nil {
		h.log.Error("failed to send agent list response", "error", err)
	}
}
