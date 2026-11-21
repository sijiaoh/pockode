package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/permreview"
)

const (
	verdictAllow = "allow"
	verdictDeny  = "deny"
)

// PermissionReviews reaches the permission review service of a worktree, which
// is where the reviewer calling permission_verdict and the request it answers
// both live, and returns the release func to call when the tool call is done
// with it. worktree.Manager.ResolvePermissionReviews is the implementation; a
// func rather than an interface because that method returns the concrete
// service, and worktree cannot import this package to name the interface.
type PermissionReviews func(worktree string) (PermissionReviewService, func(), error)

// PermissionReviewService is the part of permreview.Service the tool uses.
type PermissionReviewService interface {
	Verdict(ctx context.Context, reviewerID string, v permreview.Verdict) (permreview.Outcome, error)
	PendingSummary(reviewerID string) string
}

// SetPermissionReviews installs what permission_verdict answers through. Left
// unset, the tool refuses every call; the server always sets it.
func (e *Executor) SetPermissionReviews(reviews PermissionReviews) {
	e.reviews = reviews
}

type permissionVerdictParams struct {
	RequestID string `json:"request_id"`
	Verdict   string `json:"verdict"`
	Category  string `json:"category"`
	Reason    string `json:"reason"`
}

// permissionVerdict answers one request routed to the calling reviewer. Only
// a reviewer's proxy offers the tool (NewPermissionReviewerServer); that the
// request was routed to this caller is checked here, by the service, which is
// what keeps a reviewer to its own main session's requests.
func (e *Executor) permissionVerdict(ctx context.Context, caller Caller, args json.RawMessage) (string, error) {
	if caller.SessionID == "" || e.reviews == nil {
		return "", userErrorf("%s is only for a permission reviewer session", agent.PermissionVerdictTool)
	}
	var p permissionVerdictParams
	if err := json.Unmarshal(args, &p); err != nil {
		return "", userErrorf("invalid arguments: %v", err)
	}
	if p.RequestID == "" {
		return "", userErrorf("request_id is required")
	}
	if p.Verdict != verdictAllow && p.Verdict != verdictDeny {
		return "", userErrorf("verdict must be %q or %q, got %q", verdictAllow, verdictDeny, p.Verdict)
	}

	service, release, err := e.reviews(caller.Worktree)
	if err != nil {
		return "", fmt.Errorf("reach the permission reviews of worktree %q: %w", caller.Worktree, err)
	}
	defer release()

	outcome, err := service.Verdict(ctx, caller.SessionID, permreview.Verdict{
		RequestID: p.RequestID,
		Allow:     p.Verdict == verdictAllow,
		Category:  agent.PermissionDenyCategory(p.Category),
		Reason:    p.Reason,
	})
	switch {
	case errors.Is(err, permreview.ErrDenyNeedsCategory):
		return "", userErrorf("%v; got %q. Nothing was sent: call %s again with a category", err, p.Category, agent.PermissionVerdictTool)
	case errors.Is(err, permreview.ErrNotRouted):
		return "", userErrorf("%v: %s", err, p.RequestID)
	case err != nil:
		return "", err
	}

	var text string
	switch outcome {
	case permreview.NoLongerPending:
		text = fmt.Sprintf("Request %s is no longer pending: someone else answered it, or it ended. Nothing more to do for it.", p.RequestID)
	default:
		if p.Verdict == verdictAllow {
			text = fmt.Sprintf("Allowed request %s.", p.RequestID)
		} else {
			text = fmt.Sprintf("Denied request %s; the main agent was told your reason.", p.RequestID)
		}
	}
	if pending := service.PendingSummary(caller.SessionID); pending != "" {
		text += " " + pending
	}
	return text, nil
}
