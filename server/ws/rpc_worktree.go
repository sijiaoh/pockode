package ws

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// formatWorktreeBlockedError builds a locatable error listing every work item
// that blocks deleting the worktree, so the developer knows which and how many.
func formatWorktreeBlockedError(name string, blocking []work.Work) string {
	var b strings.Builder
	fmt.Fprintf(&b, "cannot delete worktree %q: %d work item(s) not closed", name, len(blocking))
	for _, w := range blocking {
		fmt.Fprintf(&b, "; %s %q (%s)", w.ID, w.Title, w.Status)
	}
	return b.String()
}

// toRPCSetupHookSkip converts a skip for the wire, mapping "runs fine" to an
// absent field.
func toRPCSetupHookSkip(skip *worktree.SetupHookSkip) *rpc.SetupHookSkip {
	if skip == nil {
		return nil
	}
	return &rpc.SetupHookSkip{Reason: skip.Reason, Hint: skip.Hint}
}

func (h *rpcMethodHandler) handleWorktreeList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	registry := h.worktreeManager.Registry()
	worktrees := registry.List()

	result := rpc.WorktreeListResult{
		Worktrees:     make([]rpc.WorktreeInfo, len(worktrees)),
		SetupHookSkip: toRPCSetupHookSkip(registry.CheckSetupHook()),
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
	info, setupHookSkip, err := registry.Create(params.Name, params.Branch, params.BaseBranch)
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
		SetupHookSkip: toRPCSetupHookSkip(setupHookSkip),
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
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "name required")
		return
	}

	// Refuse to delete a worktree that still owns work which has not closed;
	// deleting it would orphan live or resumable sessions. main (name "") is
	// rejected earlier by the empty-name guard, so its behavior is unchanged.
	works, err := h.workStore.List()
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to list work: "+err.Error())
		return
	}
	if blocking := work.UnclosedWorkByWorktree(works, params.Name); len(blocking) > 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, formatWorktreeBlockedError(params.Name, blocking))
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

	// Atomically swap the connection's bound worktree, subscribing the notifier
	// under the same lock so a concurrent disconnect can't leave the reference
	// leaked or the new worktree unsubscribed.
	prevWorktree, noop, ok := h.state.bindWorktree(newWorktree)
	if !ok {
		// Connection was closed mid-switch; drop the reference we just acquired.
		h.worktreeManager.Release(newWorktree)
		return
	}
	if noop {
		// Already bound to this exact worktree; drop the extra ref.
		h.worktreeManager.Release(newWorktree)
		result := rpc.WorktreeSwitchResult{
			WorkDir:      newWorktree.WorkDir,
			WorktreeName: newWorktree.Name,
		}
		if err := conn.Reply(ctx, req.ID, result); err != nil {
			h.log.Error("failed to send worktree switch response", "error", err)
		}
		return
	}

	// Cleanup old worktree (outside lock to avoid deadlock)
	if prevWorktree != nil {
		notifier := h.state.getNotifier()
		h.state.unsubscribeWorktreeWatchers(prevWorktree)
		prevWorktree.Unsubscribe(notifier)
		h.worktreeManager.Release(prevWorktree)
	}

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
	notifier := h.state.getNotifier()
	id := h.worktreeManager.WorktreeWatcher.Subscribe(notifier)
	h.state.trackSubscription(id, h.worktreeManager.WorktreeWatcher)
	h.log.Debug("subscribed", "watcher", "worktree", "watchId", id)

	if err := conn.Reply(ctx, req.ID, rpc.WorktreeSubscribeResult{ID: id}); err != nil {
		h.log.Error("failed to send worktree subscribe response", "error", err)
	}
}
