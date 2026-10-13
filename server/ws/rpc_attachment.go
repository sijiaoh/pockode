package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// handleAttachmentGet describes the content a chat event references by id,
// carrying it inline only when it is text; a raster image's bytes come from
// GET /api/chat/attachments.
//
// The bytes are fetched on demand rather than carried in the event because an
// event is written into the session history and replayed with every page of it;
// see package attachments. How the content itself is read and described:
// readAttachment.
func (h *rpcMethodHandler) handleAttachmentGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.AttachmentGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	// Checked against this worktree's own sessions, not just for existence: the
	// session id picks the directory to read from, so anything not known here
	// must not be turned into a path at all.
	_, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	file, ok := h.readAttachment(ctx, conn, req, wt.DataDir, params.SessionID, params.ID)
	if !ok {
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.AttachmentGetResult{File: file}); err != nil {
		h.log.Error("failed to send attachment get response", "error", err)
	}
}

// readAttachment resolves one attachment id inside one session's attachment
// directory, answering the client itself on every failure. ok=false means the
// request has already been answered.
//
// The id is held to what the store hands out by attachments.Resolve — the same
// gate GET /api/chat/attachments applies, so an id described here is one that
// endpoint serves. It is then read through contents.GetContents, the same way
// file.get does, so an attachment is described to the client exactly as a file
// is — MIME sniffed from the bytes, media left for the client to fetch over
// HTTP, omitted with a reason when it is not something to show.
//
// Shared by attachment.get and session_view.attachment so that an id is
// confined and answered the same way whichever worktree the session belongs to.
//
// The caller has already established that the session exists in the data
// directory it passes; that check is what keeps an unknown session id from
// becoming a path at all.
func (h *rpcMethodHandler) readAttachment(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, dataDir, sessionID, id string) (*contents.FileContent, bool) {
	if _, err := attachments.Resolve(dataDir, sessionID, id); err != nil {
		if errors.Is(err, attachments.ErrNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "attachment not found")
			return nil, false
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return nil, false
	}

	result, err := contents.GetContents(attachments.Dir(dataDir, sessionID), id)
	if err != nil {
		// Resolve has vouched for the id, so not finding it now means it was
		// removed in between — the session deleted under the request.
		if errors.Is(err, contents.ErrNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "attachment not found")
			return nil, false
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return nil, false
	}
	if result.IsDir() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "attachment not found")
		return nil, false
	}
	return result.File, true
}
