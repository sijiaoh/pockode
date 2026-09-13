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
	result, err := wt.GitDiffWatcher.Subscribe(params.ID, params.Path, params.Staged, params.HideWhitespace, notifier)
	if err != nil {
		if h.replySubscriptionIDError(ctx, conn, req.ID, err) {
			return
		}
		if strings.Contains(err.Error(), "file not found") {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	h.state.trackSubscription(params.ID, wt.GitDiffWatcher)

	h.log.Debug("subscribed", "watcher", "git-diff", "watchId", params.ID, "path", params.Path, "staged", params.Staged)

	response := rpc.GitDiffSubscribeResult{
		Diff:       result.Diff,
		OldContent: result.OldContent,
		NewContent: result.NewContent,
	}
	if err := conn.Reply(ctx, req.ID, response); err != nil {
		h.log.Error("failed to send git diff subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	id, ok := h.subscriptionID(ctx, conn, req)
	if !ok {
		return
	}

	notifier := h.state.getNotifier()
	if err := wt.GitWatcher.Subscribe(id, notifier); err != nil {
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to git")
		return
	}
	h.state.trackSubscription(id, wt.GitWatcher)
	h.log.Debug("subscribed", "watcher", "git", "watchId", id)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
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

func (h *rpcMethodHandler) handleGitDiscard(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
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
	// Every path is checked before any of them is discarded: this call deletes
	// files, so a bad path must stop the request rather than be reached halfway
	// through it.
	for _, path := range params.Paths {
		if err := contents.ValidatePath(workDir, path); err != nil {
			if errors.Is(err, contents.ErrInvalidPath) {
				h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid path: "+path)
				return
			}
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
			return
		}
	}

	// git names the file it could not write or remove, which is the only thing
	// that makes a failed discard actionable, so its message is the response.
	if err := git.Discard(workDir, params.Paths); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git discard response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitCommit(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitCommitParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if strings.TrimSpace(params.Message) == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "message required")
		return
	}

	// git's own output is the response body: a rejected commit-msg hook, an
	// unconfigured user.email and an empty index are only actionable from what
	// git said about them.
	if err := git.CreateCommit(wt.WorkDir, params.Message, params.Amend); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git commit response", "error", err)
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

func (h *rpcMethodHandler) handleGitShowDiff(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitShowDiffParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Hash == "" || params.Path == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "hash and path required")
		return
	}

	result, err := git.ShowFileDiff(wt.WorkDir, params.Hash, params.Path, params.HideWhitespace)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send git show diff response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitShowFile(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitShowFileParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Hash == "" || params.Path == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "hash and path required")
		return
	}

	file, err := git.ShowFile(wt.WorkDir, params.Hash, params.Path)
	if err != nil {
		// Asking for a path the commit never had is the caller's mistake, not a
		// server fault, and file.get answers it the same way.
		if errors.Is(err, contents.ErrNotFound) || errors.Is(err, contents.ErrInvalidPath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, file); err != nil {
		h.log.Error("failed to send git show file response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitBranches(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	branches, err := git.Branches(wt.WorkDir)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, branches); err != nil {
		h.log.Error("failed to send git branches response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitCheckout(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitCheckoutParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Branch == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "branch required")
		return
	}

	// git's refusal message (which files would be overwritten, why the ref is
	// ambiguous) is the response body the panel shows, so it is forwarded as-is.
	if err := git.Checkout(wt.WorkDir, params.Branch); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git checkout response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitBranchCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitBranchCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Name == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "name required")
		return
	}

	if err := git.CreateBranch(wt.WorkDir, params.Name); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git branch create response", "error", err)
	}
}

// The three remote operations are the only unbounded ones in the panel. They
// run on the request's own goroutine (the connection uses jsonrpc2.AsyncHandler),
// and git's stderr is forwarded verbatim: an authentication failure or a
// rejected push is only actionable if the user can read what git said.

func (h *rpcMethodHandler) handleGitFetch(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	if err := git.Fetch(wt.WorkDir); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git fetch response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitPull(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	commits, err := git.Pull(wt.WorkDir)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.GitPullResult{Commits: commits}); err != nil {
		h.log.Error("failed to send git pull response", "error", err)
	}
}

func (h *rpcMethodHandler) handleGitPush(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitPushParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if err := git.Push(wt.WorkDir, params.Force); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send git push response", "error", err)
	}
}
