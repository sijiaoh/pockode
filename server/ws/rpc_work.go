package ws

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

// replyWorkError classifies work store errors into JSON-RPC error codes.
func (h *rpcMethodHandler) replyWorkError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error, fallbackMsg string) {
	if errors.Is(err, work.ErrWorkNotFound) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, "work not found")
	} else if errors.Is(err, work.ErrInvalidWork) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, err.Error())
	} else {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInternalError, fallbackMsg)
	}
}

func (h *rpcMethodHandler) handleWorkCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Validate agent_role_id exists if specified
	if params.AgentRoleID != "" {
		if _, found, err := h.agentRoleStore.Get(params.AgentRoleID); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to validate agent role")
			return
		} else if !found {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent role not found: "+params.AgentRoleID)
			return
		}
	}

	w, err := h.workStore.Create(ctx, work.Work{
		Type:        params.Type,
		ParentID:    params.ParentID,
		AgentRoleID: params.AgentRoleID,
		Title:       params.Title,
		Body:        params.Body,
	})
	if err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to create work")
		return
	}

	h.log.Info("work created", "workId", w.ID, "type", w.Type, "title", w.Title)

	if err := conn.Reply(ctx, req.ID, w); err != nil {
		h.log.Error("failed to send work create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Validate agent_role_id exists if specified
	if params.AgentRoleID != nil && *params.AgentRoleID != "" {
		if _, found, err := h.agentRoleStore.Get(*params.AgentRoleID); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to validate agent role")
			return
		} else if !found {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent role not found: "+*params.AgentRoleID)
			return
		}
	}

	fields := work.UpdateFields{
		Title:       params.Title,
		Body:        params.Body,
		AgentRoleID: params.AgentRoleID,
		Status:      params.Status,
	}
	if err := h.workStore.Update(ctx, params.ID, fields); err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to update work")
		return
	}

	h.log.Info("work updated", "workId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send work update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.workStore.Delete(ctx, params.ID); err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to delete work")
		return
	}

	h.log.Info("work deleted", "workId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send work delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkStartParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// 1. Claim the work atomically: open → in_progress + link session.
	//    This must happen before creating the session to prevent orphan
	//    sessions when concurrent requests race on the same work item.
	//    The Store's mutex ensures only one request wins the transition.
	sessionID := uuid.Must(uuid.NewV7()).String()
	status := work.StatusInProgress
	if err := h.workStore.Update(ctx, params.ID, work.UpdateFields{
		SessionID: &sessionID,
		Status:    &status,
	}); err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to start work")
		return
	}

	// Re-read to get the full work (including title for session/kickoff)
	w, found, err := h.workStore.Get(params.ID)
	if err != nil || !found {
		h.log.Error("failed to read work after claim", "error", err, "found", found)
		h.rollbackAndReply(ctx, conn, req.ID, params.ID, "work claimed but failed to read back")
		return
	}

	// 2. Create session and send kickoff message via WorkStarter.
	if err := h.workStarter.HandleWorkStart(ctx, w); err != nil {
		h.rollbackAndReply(ctx, conn, req.ID, params.ID, err.Error())
		return
	}

	h.log.Info("work started", "workId", params.ID, "sessionId", sessionID)

	if err := conn.Reply(ctx, req.ID, w); err != nil {
		h.log.Error("failed to send work start response", "error", err)
	}
}

// rollbackAndReply reverts a claimed work item back to open status and
// replies with an internal error. If the rollback itself fails, the
// message is annotated.
func (h *rpcMethodHandler) rollbackAndReply(ctx context.Context, conn *jsonrpc2.Conn, reqID jsonrpc2.ID, workID, msg string) {
	openStatus := work.StatusOpen
	emptySession := ""
	if err := h.workStore.Update(ctx, workID, work.UpdateFields{
		Status:    &openStatus,
		SessionID: &emptySession,
	}); err != nil {
		h.log.Error("failed to rollback work start", "workId", workID, "error", err)
		msg += " (rollback also failed — work may be stuck in_progress)"
	} else {
		h.log.Info("rolled back work start", "workId", workID)
	}
	h.replyError(ctx, conn, reqID, jsonrpc2.CodeInternalError, msg)
}

func (h *rpcMethodHandler) handleWorkListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	notifier := h.state.getNotifier()
	id, items, err := h.workListWatcher.Subscribe(notifier)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to subscribe")
		return
	}
	h.state.trackSubscription(id, h.workListWatcher)
	h.log.Debug("subscribed", "watcher", "work list", "watchId", id)

	result := rpc.WorkListSubscribeResult{
		ID:    id,
		Items: items,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send work list subscribe response", "error", err)
	}
}
