package ws

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/commitdraft"
	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// commitDrafts are a connection's running commit message drafts, by the
// client's draft id.
type commitDrafts struct {
	draftsMu sync.Mutex
	running  map[string]context.CancelFunc
	// cancelledEarly holds ids cancelled before their draft was registered.
	// Requests are handled concurrently (jsonrpc2.AsyncHandler), so a cancel
	// sent right after its draft can be handled first; without this the draft
	// would then run to the end, a paid call nobody is waiting for. Ids of drafts
	// that had already finished land here too, and stay until the connection
	// closes — one string per click — which is why a client never reuses one.
	cancelledEarly map[string]struct{}
}

// start registers a draft and returns its context, which ends when the draft
// is cancelled or parent ends. ok is false for an id already running.
func (d *commitDrafts) start(parent context.Context, id string) (ctx context.Context, ok bool) {
	ctx, cancel := context.WithCancel(parent)

	d.draftsMu.Lock()
	defer d.draftsMu.Unlock()
	if _, running := d.running[id]; running {
		cancel()
		return nil, false
	}
	if _, early := d.cancelledEarly[id]; early {
		delete(d.cancelledEarly, id)
		cancel()
		return ctx, true
	}
	if d.running == nil {
		d.running = make(map[string]context.CancelFunc)
	}
	d.running[id] = cancel
	return ctx, true
}

// finish releases a draft that has ended.
func (d *commitDrafts) finish(id string) {
	d.draftsMu.Lock()
	cancel := d.running[id]
	delete(d.running, id)
	d.draftsMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// cancel stops a draft. An id that is not running is remembered in case its
// draft has not been registered yet.
func (d *commitDrafts) cancel(id string) {
	d.draftsMu.Lock()
	defer d.draftsMu.Unlock()
	if cancel, running := d.running[id]; running {
		cancel()
		return
	}
	if d.cancelledEarly == nil {
		d.cancelledEarly = make(map[string]struct{})
	}
	d.cancelledEarly[id] = struct{}{}
}

// handleGitCommitDraft answers with a commit message an AI CLI wrote for what
// is staged. It commits nothing: the message goes into the commit sheet's text
// box, for the user to edit and commit — see docs/git.md#drafting-a-commit-message.
//
// The reply comes when the CLI is done, which takes seconds. The CLI is
// killed, with everything it started, when the draft is cancelled, when the
// connection closes, or after commitdraft.Timeout.
func (h *rpcMethodHandler) handleGitCommitDraft(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.GitCommitDraftParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.DraftID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "draft_id required")
		return
	}
	if params.AgentType == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "agent_type required")
		return
	}
	engine := session.Engine{AgentType: params.AgentType, Model: params.Model, Effort: params.Effort}
	if err := session.ValidateEngine(engine); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	runner, err := h.worktreeManager.AgentOneShot(params.AgentType)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	// ctx is the connection's, so a CLI whose answer nobody is left to receive
	// is stopped when the connection closes.
	draftCtx, ok := h.state.drafts.start(ctx, params.DraftID)
	if !ok {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "a draft with this draft_id is already running")
		return
	}
	defer h.state.drafts.finish(params.DraftID)

	message, err := commitdraft.Draft(draftCtx, runner, commitdraft.Options{
		Dir:    wt.WorkDir,
		Amend:  params.Amend,
		Model:  params.Model,
		Effort: params.Effort,
	})
	if ctx.Err() != nil {
		// The connection is gone: there is nobody to answer.
		h.log.Debug("commit message draft ended with its connection", "agent", params.AgentType)
		return
	}
	if err != nil {
		h.log.Info("commit message draft failed", "agent", params.AgentType, "error", err)
		h.replyCommitDraftError(ctx, conn, req.ID, err)
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.GitCommitDraftResult{Message: message}); err != nil {
		h.log.Error("failed to send commit message draft response", "error", err)
	}
}

// handleGitCommitDraftCancel stops a draft. It is idempotent: cancelling a
// draft that already ended, or was never started, succeeds and does nothing.
func (h *rpcMethodHandler) handleGitCommitDraftCancel(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.GitCommitDraftCancelParams
	if err := unmarshalParams(req, &params); err != nil || params.DraftID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "draft_id required")
		return
	}
	h.state.drafts.cancel(params.DraftID)
	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send commit message cancel response", "error", err)
	}
}

// commitDraftReason sorts a failed draft into the reasons a client can say
// something specific about. ok is false for anything else — a git command that
// failed, which is an internal error.
func commitDraftReason(err error) (reason string, ok bool) {
	var notFound *agent.BinaryNotFoundError
	var authErr *agent.OneShotAuthError
	var failed *agent.OneShotFailedError
	switch {
	case errors.Is(err, git.ErrNothingStaged):
		return rpc.CommitDraftNothingStaged, true
	case errors.As(err, &notFound):
		return rpc.CommitDraftCLINotFound, true
	case errors.As(err, &authErr):
		return rpc.CommitDraftAuthFailed, true
	case errors.Is(err, context.DeadlineExceeded):
		return rpc.CommitDraftTimeout, true
	case errors.Is(err, context.Canceled):
		return rpc.CommitDraftCancelled, true
	case errors.Is(err, agent.ErrOneShotToolUse):
		return rpc.CommitDraftToolUse, true
	case errors.Is(err, commitdraft.ErrEmptyAnswer):
		return rpc.CommitDraftEmpty, true
	case errors.As(err, &failed):
		return rpc.CommitDraftFailed, true
	}
	return "", false
}

func (h *rpcMethodHandler) replyCommitDraftError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	// The sheet offers no amend without a commit, so this is a client asking
	// for something that cannot be, not a draft that failed.
	if errors.Is(err, git.ErrNothingToAmend) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	reason, ok := commitDraftReason(err)
	if !ok {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInternalError, err.Error())
		return
	}
	message := err.Error()
	switch reason {
	case rpc.CommitDraftTimeout:
		message = fmt.Sprintf("the AI CLI did not answer within %s", commitdraft.Timeout)
	case rpc.CommitDraftCancelled:
		message = "the draft was cancelled"
	}
	h.replyErrorData(ctx, conn, id, rpc.CodeCommitDraftFailed, message, rpc.CommitDraftFailedData{Reason: reason})
}
