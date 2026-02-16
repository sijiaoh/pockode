package ws

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleSessionCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	sessionID := uuid.Must(uuid.NewV7()).String()

	sess, err := wt.SessionStore.Create(ctx, sessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to create session")
		return
	}

	h.log.Info("session created", "sessionId", sessionID)

	result := rpc.SessionListItem{
		SessionMeta: sess,
		State:       wt.ProcessManager.GetProcessState(sessionID),
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	wt.ProcessManager.Close(params.SessionID)
	if err := wt.SessionStore.Delete(ctx, params.SessionID); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to delete session")
		return
	}

	h.log.Info("session deleted", "sessionId", params.SessionID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionUpdateTitle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionUpdateTitleParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Title == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "title required")
		return
	}

	if err := wt.SessionStore.Update(ctx, params.SessionID, params.Title); err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to update session")
		return
	}

	h.log.Info("session title updated", "sessionId", params.SessionID, "title", params.Title)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionSetMode(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionSetModeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if !params.Mode.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid mode")
		return
	}

	// Close any running process for this session (mode change requires restart)
	wt.ProcessManager.Close(params.SessionID)

	if err := wt.SessionStore.SetMode(ctx, params.SessionID, params.Mode); err != nil {
		if errors.Is(err, session.ErrSessionNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to set mode")
		return
	}

	h.log.Info("session mode changed", "sessionId", params.SessionID, "mode", params.Mode)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session set mode response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	notifier := h.state.getNotifier()
	id, sessions, err := wt.SessionListWatcher.Subscribe(notifier)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to subscribe")
		return
	}
	h.state.trackSubscription(id, wt.SessionListWatcher)
	h.log.Debug("subscribed", "watcher", "session list", "watchId", id)

	result := rpc.SessionListSubscribeResult{
		ID:       id,
		Sessions: sessions,
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session list subscribe response", "error", err)
	}
}
