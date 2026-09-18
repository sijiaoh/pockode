package ws

import (
	"context"
	"errors"

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

	// Validate agent_role_id is provided and exists
	if params.AgentRoleID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent_role_id is required")
		return
	}
	if _, found, err := h.agentRoleStore.Get(params.AgentRoleID); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to validate agent role")
		return
	} else if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent role not found: "+params.AgentRoleID)
		return
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

	// The cascade onto sessions and their processes is part of the command, not
	// of this transport: work_delete over MCP deletes exactly as much.
	if err := h.workOps.DeleteWork(ctx, params.ID); err != nil {
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

	// Capture the frontend's current worktree onto a top-level work the first
	// time it starts. Children inherit their worktree at create time, and a
	// restart keeps the worktree it already has (SetWorktree only applies while
	// the work is still open), so this only ever pins a brand-new story.
	if current, found, err := h.workStore.Get(params.ID); err == nil && found &&
		current.ParentID == "" && current.Status == work.StatusOpen {
		name := ""
		if wt := h.state.getWorktree(); wt != nil {
			name = wt.Name
		}
		if err := h.workStore.SetWorktree(ctx, params.ID, name); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to assign worktree: "+err.Error())
			return
		}
	}

	w, err := h.workOps.StartWork(ctx, params.ID)
	if err != nil {
		// ErrWorkNotFound / ErrInvalidWork map to client errors; a kickoff failure
		// (e.g. "send kickoff message: ...") is surfaced verbatim so the user sees
		// why the agent did not start.
		if errors.Is(err, work.ErrWorkNotFound) || errors.Is(err, work.ErrInvalidWork) {
			h.replyWorkError(ctx, conn, req.ID, err, "failed to start work")
		} else {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	h.log.Info("work started", "workId", w.ID, "sessionId", w.SessionID)

	if err := conn.Reply(ctx, req.ID, w); err != nil {
		h.log.Error("failed to send work start response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkStop(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkStopParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.workOps.StopWork(ctx, params.ID); err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to stop work")
		return
	}

	h.log.Info("work stopped", "workId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send work stop response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkReopen(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkReopenParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := h.workOps.ReopenWork(ctx, params.ID); err != nil {
		h.replyWorkError(ctx, conn, req.ID, err, "failed to reopen work")
		return
	}

	h.log.Info("work reopened", "workId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send work reopen response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkCommentList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkCommentListParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.WorkID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "work_id is required")
		return
	}

	comments, err := h.workStore.ListComments(params.WorkID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to list comments")
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.WorkCommentListResult{Comments: comments}); err != nil {
		h.log.Error("failed to send work comment list response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkCommentUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkCommentUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}
	if params.Body == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "body is required")
		return
	}

	comment, err := h.workStore.UpdateComment(ctx, params.ID, params.Body)
	if err != nil {
		if errors.Is(err, work.ErrCommentNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "comment not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update comment")
		return
	}

	h.log.Info("comment updated", "commentId", params.ID)

	if err := conn.Reply(ctx, req.ID, comment); err != nil {
		h.log.Error("failed to send comment update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkDetailSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkDetailSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.WorkID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "work_id is required")
		return
	}

	notifier := h.state.getNotifier()
	detail, err := h.workDetailWatcher.Subscribe(params.ID, params.WorkID, notifier)
	if err != nil {
		if h.replySubscriptionIDError(ctx, conn, req.ID, err) {
			return
		}
		h.replyWorkError(ctx, conn, req.ID, err, "failed to subscribe")
		return
	}
	h.state.trackSubscription(params.ID, h.workDetailWatcher)
	h.log.Debug("subscribed", "watcher", "work detail", "watchId", params.ID, "workId", params.WorkID)

	result := rpc.WorkDetailSubscribeResult{
		Work:     detail.Work,
		Comments: detail.Comments,
		Usage:    detail.Usage,
		Activity: detail.Activity,
		Children: detail.Children,
		Parent:   detail.Parent,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send work detail subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorkListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	notifier := h.state.getNotifier()
	snapshot, err := h.workListWatcher.Subscribe(id, notifier)
	if err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to work list")
		return
	}
	h.state.trackSubscription(id, h.workListWatcher)
	h.log.Debug("subscribed", "watcher", "work list", "watchId", id)

	result := rpc.WorkListSubscribeResult{
		Items:            snapshot.Items,
		NotRunningHidden: snapshot.NotRunningHidden,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send work list subscribe response", "error", err)
	}
}

// handleWorkListArchive serves one page of closed work.
//
// It names the subscription rather than standing alone so that a page and the
// list it belongs to cannot come apart, and so that an id the server has
// dropped is refused as invalid params — which tells the client to subscribe
// afresh instead of offering a Retry that can only fail again.
func (h *rpcMethodHandler) handleWorkListArchive(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkListArchiveParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	page, err := h.workListWatcher.Archive(params.ID, params.Cursor, params.Limit)
	if err != nil {
		h.replyListPageError(ctx, conn, req.ID, err, "failed to read the work archive page")
		return
	}

	result := rpc.WorkListArchiveResult{
		Items:      page.Items,
		NextCursor: page.NextCursor,
		HasMore:    page.HasMore,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send work list archive response", "error", err)
	}
}

// handleWorkListEarlier serves the `Current` segment with the *Not running* cap
// lifted — one press, the whole group, no cursor.
func (h *rpcMethodHandler) handleWorkListEarlier(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorkListEarlierParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	items, err := h.workListWatcher.Earlier(params.ID)
	if err != nil {
		h.replyListPageError(ctx, conn, req.ID, err, "failed to read the earlier work")
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.WorkListEarlierResult{Items: items}); err != nil {
		h.log.Error("failed to send work list earlier response", "error", err)
	}
}
