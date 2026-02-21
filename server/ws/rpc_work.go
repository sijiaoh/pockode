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

	w, err := h.workStore.Create(ctx, work.Work{
		Type:     params.Type,
		ParentID: params.ParentID,
		Title:    params.Title,
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

	fields := work.UpdateFields{
		Title:  params.Title,
		Status: params.Status,
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

	// rollbackAndReply rolls back the work claim and replies with an internal error.
	// If the rollback itself fails, the message is annotated.
	rollbackAndReply := func(msg string) {
		if rbErr := h.rollbackWorkStart(ctx, params.ID); rbErr != nil {
			msg += " (rollback also failed — work may be stuck in_progress)"
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, msg)
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
		rollbackAndReply("work claimed but failed to read back")
		return
	}

	// 2. Get main worktree
	mainWt, err := h.worktreeManager.Get("")
	if err != nil {
		rollbackAndReply("failed to get main worktree")
		return
	}
	defer h.worktreeManager.Release(mainWt)

	// 3. Create session
	if _, err := mainWt.SessionStore.Create(ctx, sessionID); err != nil {
		rollbackAndReply("failed to create session")
		return
	}

	// 4. Set session title to work title
	if err := mainWt.SessionStore.Update(ctx, sessionID, w.Title); err != nil {
		h.log.Warn("failed to set session title", "error", err)
	}

	// 5. Send kickoff message (starts the agent process).
	//    This is the step that actually launches the agent — if it fails,
	//    the work would be stuck in_progress with no running process.
	var parentTitle string
	if w.ParentID != "" {
		if parent, found, err := h.workStore.Get(w.ParentID); err == nil && found {
			parentTitle = parent.Title
		} else {
			h.log.Warn("failed to get parent for kickoff message", "parentId", w.ParentID, "error", err)
		}
	}
	kickoffMsg := work.BuildKickoffMessage(w, parentTitle)
	if err := mainWt.ChatClient.SendMessage(ctx, sessionID, kickoffMsg); err != nil {
		if delErr := mainWt.SessionStore.Delete(ctx, sessionID); delErr != nil {
			h.log.Error("failed to clean up session after kickoff failure", "sessionId", sessionID, "error", delErr)
		}
		rollbackAndReply("failed to send kickoff message")
		return
	}

	h.log.Info("work started", "workId", params.ID, "sessionId", sessionID)

	if err := conn.Reply(ctx, req.ID, w); err != nil {
		h.log.Error("failed to send work start response", "error", err)
	}
}

// rollbackWorkStart reverts a claimed work item back to open status.
// Called when session creation or kickoff fails after the work was
// already transitioned to in_progress.
// Returns an error if the rollback itself fails, so callers can
// include that context in the user-facing error message.
func (h *rpcMethodHandler) rollbackWorkStart(ctx context.Context, workID string) error {
	openStatus := work.StatusOpen
	emptySession := ""
	if err := h.workStore.Update(ctx, workID, work.UpdateFields{
		Status:    &openStatus,
		SessionID: &emptySession,
	}); err != nil {
		h.log.Error("failed to rollback work start", "workId", workID, "error", err)
		return err
	}
	h.log.Info("rolled back work start", "workId", workID)
	return nil
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
