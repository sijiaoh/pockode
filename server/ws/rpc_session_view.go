package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

// The session_view namespace serves the sessions of a worktree the connection
// is not in — including worktrees that no longer exist, whose session data
// deleting them deliberately leaves behind (worktree.Manager.ForceShutdown).
//
// Every handler here reads and nothing more; see the namespace comment on
// rpc.SessionViewWorktreesResult for why that is the whole of the read-only rule.

// sessionReader resolves the reader for the worktree a request names, answering
// the client itself when the name is not one. ok=false means the request has
// already been answered.
func (h *rpcMethodHandler) sessionReader(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, worktree string) (session.Reader, bool) {
	reader, err := h.worktreeManager.SessionReader(worktree)
	if err != nil {
		// The only failure is a name that could never be a worktree's, which is
		// the client's to get right.
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return nil, false
	}
	return reader, true
}

// viewedSession reads the metadata of a session out of the named worktree,
// answering the client when it is not there.
//
// Every session_view method that names a session goes through here, and not only to
// report a missing one: the session id picks the directory a transcript or an
// attachment is read from, so an id this worktree does not know must not be
// turned into a path at all (the same rule attachment.get follows).
func (h *rpcMethodHandler) viewedSession(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, worktree, sessionID string) (session.Reader, session.SessionMeta, bool) {
	if sessionID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session_id is required")
		return nil, session.SessionMeta{}, false
	}

	reader, ok := h.sessionReader(ctx, conn, req, worktree)
	if !ok {
		return nil, session.SessionMeta{}, false
	}

	meta, found, err := reader.Get(sessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err,
			"worktree", worktree, "sessionId", sessionID)
		return nil, session.SessionMeta{}, false
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return nil, session.SessionMeta{}, false
	}
	return reader, meta, true
}

func (h *rpcMethodHandler) handleSessionViewWorktrees(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	sources, err := h.worktreeManager.SessionSources()
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to list session sources", err)
		return
	}

	result := rpc.SessionViewWorktreesResult{Worktrees: make([]rpc.SessionViewWorktree, len(sources))}
	for i, source := range sources {
		result.Worktrees[i] = rpc.SessionViewWorktree{
			Worktree:     source.Name,
			Exists:       source.Exists,
			SessionCount: source.SessionCount,
		}
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session view worktrees response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionViewList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewListParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	reader, ok := h.sessionReader(ctx, conn, req, params.Worktree)
	if !ok {
		return
	}

	sessions, err := reader.List()
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read sessions", err, "worktree", params.Worktree)
		return
	}

	// The work index is read once for the whole page rather than once per row,
	// as the live list does. Session ids are unique across worktrees, so it
	// needs no worktree filter.
	workIDs, err := h.workIDsBySession()
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read work items", err)
		return
	}

	items := make([]rpc.SessionListItem, 0, len(sessions))
	for _, sess := range sessions {
		workID := workIDs[sess.ID]
		if params.ExcludeWorkSessions && workID != "" {
			continue
		}
		items = append(items, rpc.NewSessionListItem(sess, workID))
	}

	// Cut after the filter, for the reason session.PageList gives.
	rows, next, hasMore, err := session.PageList(items, rpc.SessionListItem.Cursor, params.Cursor, params.Limit)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	// items is allocated even when empty, so an empty page goes out as `[]` —
	// which a client can iterate — and not `null`, which it cannot.
	result := rpc.SessionViewListResult{Sessions: rows, HasMore: hasMore}
	if hasMore {
		result.NextCursor = next.String()
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session view list response", "error", err)
	}
}

// workIDsBySession indexes the work store by the session each item runs, so a
// page of rows costs one read of it rather than one per row.
func (h *rpcMethodHandler) workIDsBySession() (map[string]string, error) {
	if h.workStore == nil {
		return nil, nil
	}
	works, err := h.workStore.List()
	if err != nil {
		return nil, err
	}
	return work.IDsBySession(works), nil
}

func (h *rpcMethodHandler) handleSessionViewGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	_, meta, ok := h.viewedSession(ctx, conn, req, params.Worktree, params.SessionID)
	if !ok {
		return
	}

	workID := ""
	if h.workStore != nil {
		item, found, err := h.workStore.FindBySessionID(params.SessionID)
		if err != nil {
			h.replyInternalError(ctx, conn, req.ID, "failed to look up the work a session belongs to", err,
				"sessionId", params.SessionID)
			return
		}
		if found {
			workID = item.ID
		}
	}

	result := rpc.SessionViewGetResult{Session: rpc.NewSessionDetail(meta, workID)}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session view get response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionViewHistory(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewHistoryParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	reader, _, ok := h.viewedSession(ctx, conn, req, params.Worktree, params.SessionID)
	if !ok {
		return
	}

	records, err := reader.GetHistory(ctx, params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read session history", err,
			"worktree", params.Worktree, "sessionId", params.SessionID)
		return
	}

	page, err := session.PageHistory(records, params.BeforeSeq, params.Limit)
	if err != nil {
		// Both failures name what the client asked for and what the history can
		// answer, so the cause is the reply.
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	result := rpc.SessionViewHistoryResult{
		History:       page.Records,
		HasMore:       page.HasMore,
		NextBeforeSeq: page.NextBeforeSeq,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send session view history response", "error", err)
	}
}

func (h *rpcMethodHandler) handleSessionViewAttachment(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewAttachmentParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	if _, _, ok := h.viewedSession(ctx, conn, req, params.Worktree, params.SessionID); !ok {
		return
	}

	// Resolved only after the session was found there: the id picks a directory,
	// and the worktree name was already checked on the way to the reader.
	dataDir, err := h.worktreeManager.SessionDataDir(params.Worktree)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	file, ok := h.readAttachment(ctx, conn, req, dataDir, params.SessionID, params.ID)
	if !ok {
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.SessionViewAttachmentResult{File: file}); err != nil {
		h.log.Error("failed to send session view attachment response", "error", err)
	}
}

// handleSessionViewDelete discards a session stored under a worktree the
// connection is not in — most of the time one that no longer exists.
//
// The one method in this namespace that is not a read, for the reason the
// namespace comment on rpc.SessionViewWorktreesResult gives: keeping a deleted
// worktree's conversations only works if they can still be thrown away.
func (h *rpcMethodHandler) handleSessionViewDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Looked up first, as every other method here does: a session id that this
	// worktree does not have is the client's mistake, and answering "not found"
	// is worth more than the silence an idempotent delete would give it.
	if _, _, ok := h.viewedSession(ctx, conn, req, params.Worktree, params.SessionID); !ok {
		return
	}

	if err := h.worktreeManager.DeleteSession(ctx, params.Worktree, params.SessionID); err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to delete session", err,
			"worktree", params.Worktree, "sessionId", params.SessionID)
		return
	}

	h.log.Info("session deleted", "worktree", params.Worktree, "sessionId", params.SessionID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send session view delete response", "error", err)
	}
}
