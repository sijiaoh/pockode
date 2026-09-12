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

	s := h.settingsStore.Get()
	sess, err := wt.SessionStore.Create(ctx, sessionID, session.CreateSpec{AgentType: s.DefaultAgentType, Mode: s.DefaultMode})
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to create session", err, "sessionId", sessionID)
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

func (h *rpcMethodHandler) handleSessionFork(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionForkParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	meta, err := wt.ChatClient.Fork(ctx, params.SessionID, params.AnchorSeq, params.Title)
	if err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	// Not logged here: chat.Client already logged the fork with what it did.
	result := rpc.SessionListItem{
		SessionMeta: meta,
		State:       wt.ProcessManager.GetProcessState(meta.ID),
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session fork response", "error", err)
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
		h.replyInternalError(ctx, conn, req.ID, "failed to delete session", err, "sessionId", params.SessionID)
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
		h.replyInternalError(ctx, conn, req.ID, "failed to update session", err, "sessionId", params.SessionID)
		return
	}

	h.log.Info("session title updated", "sessionId", params.SessionID, "title", params.Title)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session update response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionSetAgentType(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionSetAgentTypeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if !params.AgentType.IsValid() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid agent type")
		return
	}

	meta, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}
	if meta.Activated {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "cannot change agent type after session has started")
		return
	}

	// An unactivated session can still have a live process — the CLI that was
	// spawned for a first turn nobody heard back from is exactly the case this
	// switch exists for. GetOrCreateProcess reuses a process by session ID
	// without looking at its agent type, so leaving it running would silently
	// send the next message to the agent the user just switched away from.
	wt.ProcessManager.Close(params.SessionID)

	if err := wt.SessionStore.SetAgentType(ctx, params.SessionID, params.AgentType); err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to set agent type", err, "sessionId", params.SessionID)
		return
	}

	h.log.Info("session agent type changed", "sessionId", params.SessionID, "agentType", params.AgentType)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session set agent type response", "error", err)
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
		h.replyInternalError(ctx, conn, req.ID, "failed to set mode", err, "sessionId", params.SessionID)
		return
	}

	h.log.Info("session mode changed", "sessionId", params.SessionID, "mode", params.Mode)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session set mode response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionSetModel(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionSetModelParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Which models are valid depends on the session's agent type, so the store
	// judges the choice while holding that value still. Unlike session.set_mode
	// the write therefore comes first: a model the agent cannot run must be
	// refused without killing the process the session is running.
	if err := wt.SessionStore.SetModel(ctx, params.SessionID, params.Model); err != nil {
		switch {
		case errors.Is(err, session.ErrSessionNotFound):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		case errors.Is(err, session.ErrModelNotAvailable):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			h.replyInternalError(ctx, conn, req.ID, "failed to set model", err, "sessionId", params.SessionID)
		}
		return
	}

	// The model is only read when a CLI is launched, so a running process would
	// keep the old one until it is replaced (same as session.set_mode).
	wt.ProcessManager.Close(params.SessionID)

	h.log.Info("session model changed", "sessionId", params.SessionID, "model", params.Model)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session set model response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionModels(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	result := rpc.SessionModelsResult{Models: session.AllModels()}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session models response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionSetEffort(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionSetEffortParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Written before the process is closed, for the same reason as
	// session.set_model: which levels are valid depends on the session's agent
	// type, and a level that agent does not offer must be refused without
	// costing the user the CLI they have running.
	if err := wt.SessionStore.SetEffort(ctx, params.SessionID, params.Effort); err != nil {
		switch {
		case errors.Is(err, session.ErrSessionNotFound):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		case errors.Is(err, session.ErrEffortNotAvailable):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		default:
			h.replyInternalError(ctx, conn, req.ID, "failed to set effort", err, "sessionId", params.SessionID)
		}
		return
	}

	// The effort is only read when a CLI is launched, so a running process would
	// keep the old one until it is replaced (same as session.set_model).
	wt.ProcessManager.Close(params.SessionID)

	h.log.Info("session effort changed", "sessionId", params.SessionID, "effort", params.Effort)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session set effort response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionEfforts(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	result := rpc.SessionEffortsResult{Efforts: session.AllEfforts()}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session efforts response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionListSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	notifier := h.state.getNotifier()
	id, sessions, err := wt.SessionListWatcher.Subscribe(notifier)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to subscribe to session list", err)
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

func (h *rpcMethodHandler) handleSessionMarkRead(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.SessionMarkReadParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	wt.SessionListWatcher.MarkRead(params.SessionID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session mark read response", "error", err)
	}
}
