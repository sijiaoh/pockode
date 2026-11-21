package ws

import (
	"context"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// permissionReviewerReadOnly is what a person is told when they try to drive a
// permission reviewer session. The reviewer is Pockode's: what it is sent is the
// main session's permission requests, and how it runs comes from the server's
// permission_reviewer settings, so input from anyone else would only muddle
// the one job it has.
const permissionReviewerReadOnly = "This is a permission reviewer session: Pockode sends it the main session's permission requests and it takes no input from you. " +
	"Answer or follow up in the main session; the reviewer's model and effort are set in the server settings."

// refusePermissionReviewer replies with an error and returns true when the
// session is a permission reviewer, for every RPC through which a person would
// send a session input or change how it runs. A session that is not found is
// left to the caller, which already has its own answer for that.
//
// Checked here, at the edge where a person's input arrives, rather than in
// chat.Client: the reviewer is fed through that client by Pockode itself.
func (h *rpcMethodHandler) refusePermissionReviewer(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree, sessionID string) bool {
	meta, found, err := wt.SessionStore.Get(sessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", sessionID)
		return true
	}
	if !found || !meta.IsPermissionReviewer() {
		return false
	}
	h.replyErrorData(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, permissionReviewerReadOnly,
		rpc.ChatErrorData{Reason: rpc.ChatReasonPermissionReviewer})
	return true
}
