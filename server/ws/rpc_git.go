package ws

import (
	"context"
	"errors"
	"strings"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleGitStatus(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	status, err := git.Status(h.state.worktree.WorkDir)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send git status response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitDiffSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.GitDiffSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Path == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "path required")
		return
	}

	if err := contents.ValidatePath(h.state.worktree.WorkDir, params.Path); err != nil {
		if errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	connID := h.state.getConnID()
	id, result, err := h.state.worktree.GitDiffWatcher.Subscribe(params.Path, params.Staged, conn, connID)
	if err != nil {
		if strings.Contains(err.Error(), "file not found") {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.log.Debug("subscribed", "watcher", "git-diff", "watchId", id, "path", params.Path, "staged", params.Staged)

	response := rpc.GitDiffSubscribeResult{
		ID:         id,
		Diff:       result.Diff,
		OldContent: result.OldContent,
		NewContent: result.NewContent,
	}
	if err := conn.Reply(ctx, req.ID, response); err != nil {
		h.log.Error("failed to send git diff subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	connID := h.state.getConnID()
	id, err := h.state.worktree.GitWatcher.Subscribe(conn, connID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	h.log.Debug("subscribed", "watcher", "git", "watchId", id)

	if err := conn.Reply(ctx, req.ID, rpc.GitSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send git subscribe response", "error", err)
	}
}
