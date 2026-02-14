package ws

import (
	"context"
	"errors"
	"strings"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleGitStatus(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	status, err := git.Status(wt.WorkDir)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send git status response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitDiffSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitDiffSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Path == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "path required")
		return
	}

	if err := contents.ValidatePath(wt.WorkDir, params.Path); err != nil {
		if errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path")
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	notifier := h.state.getNotifier()
	id, result, err := wt.GitDiffWatcher.Subscribe(params.Path, params.Staged, notifier)
	if err != nil {
		if strings.Contains(err.Error(), "file not found") {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	h.state.trackSubscription(id, wt.GitDiffWatcher)

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

func (h *rpcMethodHandler) handleGitSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	notifier := h.state.getNotifier()
	id := wt.GitWatcher.Subscribe(notifier)
	h.state.trackSubscription(id, wt.GitWatcher)
	h.log.Debug("subscribed", "watcher", "git", "watchId", id)

	if err := conn.Reply(ctx, req.ID, rpc.GitSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send git subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitAdd(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitPathsParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if len(params.Paths) == 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "paths required")
		return
	}

	workDir := wt.WorkDir
	for _, path := range params.Paths {
		if err := contents.ValidatePath(workDir, path); err != nil {
			if errors.Is(err, contents.ErrInvalidPath) {
				h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path: "+path)
				return
			}
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
			return
		}

		if err := git.Add(workDir, path); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
			return
		}
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git add response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitReset(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitPathsParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if len(params.Paths) == 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "paths required")
		return
	}

	workDir := wt.WorkDir
	for _, path := range params.Paths {
		if err := contents.ValidatePath(workDir, path); err != nil {
			if errors.Is(err, contents.ErrInvalidPath) {
				h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path: "+path)
				return
			}
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
			return
		}

		if err := git.Reset(workDir, path); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
			return
		}
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git reset response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitLog(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitLogParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	commits, err := git.Log(wt.WorkDir, params.Limit)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	result := rpc.GitLogResult{Commits: commits}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send git log response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitShow(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitShowParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Hash == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "hash required")
		return
	}

	result, err := git.Show(wt.WorkDir, params.Hash)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send git show response", "error", err)
	}
}
