package ws

import (
	"context"
	"errors"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleWorktreeList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	registry := h.worktreeManager.Registry()
	worktrees := registry.List()

	result := rpc.WorktreeListResult{
		Worktrees: make([]rpc.WorktreeInfo, len(worktrees)),
	}
	for i, wt := range worktrees {
		result.Worktrees[i] = rpc.WorktreeInfo{
			Name:   wt.Name,
			Path:   wt.Path,
			Branch: wt.Branch,
			IsMain: wt.IsMain,
		}
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send worktree list response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorktreeCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorktreeCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Name == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "name required")
		return
	}
	if params.Branch == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "branch required")
		return
	}

	registry := h.worktreeManager.Registry()
	info, err := registry.Create(params.Name, params.Branch, params.BaseBranch)
	if err != nil {
		switch {
		case errors.Is(err, worktree.ErrNotGitRepo):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "not a git repository")
		case errors.Is(err, worktree.ErrWorktreeAlreadyExist):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "worktree already exists")
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	h.log.Info("worktree created", "name", info.Name, "branch", info.Branch)

	result := rpc.WorktreeCreateResult{
		Worktree: rpc.WorktreeInfo{
			Name:   info.Name,
			Path:   info.Path,
			Branch: info.Branch,
			IsMain: info.IsMain,
		},
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send worktree create response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorktreeDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorktreeDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Name == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "cannot delete main worktree")
		return
	}

	registry := h.worktreeManager.Registry()
	if err := registry.Delete(params.Name); err != nil {
		switch {
		case errors.Is(err, worktree.ErrNotGitRepo):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "not a git repository")
		case errors.Is(err, worktree.ErrWorktreeNotFound):
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "worktree not found")
		default:
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		}
		return
	}

	h.log.Info("worktree deleted", "name", params.Name)

	// Force shutdown the worktree (notifies subscribers internally)
	h.worktreeManager.ForceShutdown(params.Name)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send worktree delete response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorktreeSwitch(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.WorktreeSwitchParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	// Get new worktree first (outside lock) to ensure it exists before modifying state
	newWorktree, err := h.worktreeManager.Get(params.Name)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "worktree not found")
		return
	}

	// Atomically check and switch worktree
	h.state.mu.Lock()
	currentWorktree := h.state.worktree

	// No-op if switching to same worktree
	if currentWorktree != nil && currentWorktree.Name == params.Name {
		h.state.mu.Unlock()
		// Release the extra ref we acquired above
		h.worktreeManager.Release(newWorktree)
		result := rpc.WorktreeSwitchResult{
			WorkDir:      currentWorktree.WorkDir,
			WorktreeName: currentWorktree.Name,
		}
		if err := conn.Reply(ctx, req.ID, result); err != nil {
			h.log.Error("failed to send worktree switch response", "error", err)
		}
		return
	}

	// Cleanup old worktree (inline to avoid double-lock)
	if currentWorktree != nil {
		currentWorktree.UnsubscribeConnection(conn, h.state.connID)
		h.worktreeManager.Release(currentWorktree)
	}

	// Bind to new worktree and subscribe atomically
	h.state.worktree = newWorktree
	newWorktree.Subscribe(conn)
	h.state.mu.Unlock()

	h.log.Info("worktree switched", "to", newWorktree.Name)

	result := rpc.WorktreeSwitchResult{
		WorkDir:      newWorktree.WorkDir,
		WorktreeName: newWorktree.Name,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send worktree switch response", "error", err)
	}
}

func (h *rpcMethodHandler) handleWorktreeSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	connID := h.state.getConnID()
	id, err := h.worktreeManager.WorktreeWatcher.Subscribe(conn, connID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	h.log.Debug("subscribed", "watcher", "worktree", "watchId", id)

	if err := conn.Reply(ctx, req.ID, rpc.WorktreeSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send worktree subscribe response", "error", err)
	}
}
