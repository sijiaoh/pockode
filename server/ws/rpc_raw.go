package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/authsession"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/filetransfer"
	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// handleRawCapability hands the logged-in app a URL for content a browser
// element loads by itself, bound to the session this connection authenticated
// as: whatever ends that session ends the URL with it.
func (h *rpcMethodHandler) handleRawCapability(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.RawCapabilityParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	grant, ok := h.rawGrant(ctx, conn, req, params)
	if !ok {
		return
	}

	capability, expiresAt, err := h.rawCapabilities.Issue(h.getSessionToken(), grant)
	switch {
	case errors.Is(err, filetransfer.ErrInvalidGrant):
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	case errors.Is(err, authsession.ErrSessionNotLive):
		// The connection outlived its session (idled out, evicted, or the
		// password changed); logging in again is the remedy, as for auth.
		h.replyAuthError(ctx, conn, req.ID, "session expired", rpc.AuthReasonSessionExpired)
		return
	case err != nil:
		h.replyInternalError(ctx, conn, req.ID, "failed to issue raw capability", err)
		return
	}

	result := rpc.RawCapabilityResult{Path: filetransfer.RawEntryPath(capability, grant), ExpiresAt: expiresAt}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send raw capability response", "error", err)
	}
}

// rawGrant turns params into the grant they ask for, replying and returning
// false when they cannot name one. A field that belongs to another origin is
// refused rather than ignored: a worktree sent with a work-directory file would
// otherwise read the connection's worktree while the client believed it chose.
func (h *rpcMethodHandler) rawGrant(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, params rpc.RawCapabilityParams) (filetransfer.RawGrant, bool) {
	invalid := func(message string) (filetransfer.RawGrant, bool) {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, message)
		return filetransfer.RawGrant{}, false
	}
	grant := filetransfer.RawGrant{Scope: filetransfer.RawScope(params.Scope)}

	switch filetransfer.RawOrigin(params.Origin) {
	case filetransfer.RawOriginFile:
		if params.Hash != "" || params.SessionID != "" || params.ID != "" || params.Worktree != "" {
			return invalid("a file origin takes only path")
		}
		wt, ok := h.boundWorktree(ctx, conn, req)
		if !ok {
			return filetransfer.RawGrant{}, false
		}
		grant.Origin, grant.Worktree, grant.Path = filetransfer.RawOriginFile, wt.Name, params.Path

	case filetransfer.RawOriginCommit:
		if params.SessionID != "" || params.ID != "" || params.Worktree != "" {
			return invalid("a commit origin takes only hash and path")
		}
		wt, ok := h.boundWorktree(ctx, conn, req)
		if !ok {
			return filetransfer.RawGrant{}, false
		}
		if !h.worktreeManager.Registry().IsGitRepo() {
			h.replyNotGitRepo(ctx, conn, req.ID)
			return filetransfer.RawGrant{}, false
		}
		// Resolved now because the capability outlives this request, and an
		// abbreviation unique today need not stay so while it lives.
		hash, err := git.ResolveCommit(wt.WorkDir, params.Hash)
		if errors.Is(err, git.ErrInvalidArgument) || errors.Is(err, contents.ErrNotFound) {
			return invalid(err.Error())
		}
		if err != nil {
			h.replyInternalError(ctx, conn, req.ID, "failed to resolve commit", err)
			return filetransfer.RawGrant{}, false
		}
		grant.Origin, grant.Worktree, grant.Hash, grant.Path = filetransfer.RawOriginCommit, wt.Name, hash, params.Path

	case filetransfer.RawOriginAttachment:
		if params.Path != "" || params.Hash != "" {
			return invalid("an attachment origin takes only session_id, id and worktree")
		}
		// Only that the worktree name could be one: whether the session and its
		// attachment exist is asked per request, as they come and go while the
		// capability lives.
		if _, ok := h.sessionReader(ctx, conn, req, params.Worktree); !ok {
			return filetransfer.RawGrant{}, false
		}
		grant.Origin, grant.Worktree, grant.SessionID, grant.Path = filetransfer.RawOriginAttachment, params.Worktree, params.SessionID, params.ID

	default:
		return invalid(`origin must be "file", "commit" or "attachment"`)
	}
	return grant, true
}
