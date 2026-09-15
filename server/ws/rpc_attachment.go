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

// handleAttachmentGet serves the content a chat event references by id.
//
// The bytes are fetched on demand rather than carried in the event because an
// event is written into the session history and replayed with every page of it;
// see package attachments.
//
// It reads through contents.GetContents, the same way file.get does, so an
// attachment is described to the client exactly as a file is — MIME sniffed
// from the bytes, base64 for an image, omitted with a reason when it is not
// something to show. The root is the attachment directory rather than the work
// directory, which is also what confines the id: a directory holding nothing
// but content-addressed files has nothing else to reach.
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

	result, err := contents.GetContents(attachments.Dir(wt.DataDir, params.SessionID), params.ID)
	if err != nil {
		if errors.Is(err, contents.ErrNotFound) || errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "attachment not found")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	if result.IsDir() {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "attachment not found")
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.AttachmentGetResult{File: result.File}); err != nil {
		h.log.Error("failed to send attachment get response", "error", err)
	}
}
