package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// handleHTMLPageGet reads one page an agent drew in one of this worktree's
// sessions. The page is fetched by id rather than carried on the record that
// names it because a record is replayed with every page of history, and a page
// derived from another one has no copy of its HTML in its call's input at all.
func (h *rpcMethodHandler) handleHTMLPageGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.HTMLPageGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Checked against this worktree's own sessions, as for attachment.get: the
	// session id picks the directory to read from.
	_, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	page, ok := h.readHTMLPage(ctx, conn, req, wt.DataDir, params.SessionID, params.ID)
	if !ok {
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.HTMLPageGetResult{Page: page}); err != nil {
		h.log.Error("failed to send html page get response", "error", err)
	}
}

// handleSessionViewHTMLPage is html_page.get for a session of a worktree the
// connection is not in, including one that has been deleted: its sessions stay
// readable, pages included.
func (h *rpcMethodHandler) handleSessionViewHTMLPage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.SessionViewHTMLPageParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if _, _, ok := h.viewedSession(ctx, conn, req, params.Worktree, params.SessionID); !ok {
		return
	}
	dataDir, err := h.worktreeManager.SessionDataDir(params.Worktree)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	page, ok := h.readHTMLPage(ctx, conn, req, dataDir, params.SessionID, params.ID)
	if !ok {
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.SessionViewHTMLPageResult{Page: page}); err != nil {
		h.log.Error("failed to send session view html page response", "error", err)
	}
}

// readHTMLPage reads one page of a session already known to exist in dataDir,
// answering the client itself on every failure. ok=false means the request
// has already been answered. The id is parsed before it becomes a path
// (htmlpage.Get), so nothing but a page number ever names a file.
func (h *rpcMethodHandler) readHTMLPage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, dataDir, sessionID, id string) (htmlpage.Page, bool) {
	page, err := htmlpage.Get(dataDir, sessionID, id)
	if errors.Is(err, htmlpage.ErrNotFound) {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "page not found")
		return htmlpage.Page{}, false
	}
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read html page", err, "sessionId", sessionID, "pageId", id)
		return htmlpage.Page{}, false
	}
	return page, true
}
