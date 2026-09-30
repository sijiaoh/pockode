package ws

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/pockode/server/cliauth"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// handleCLIAuthStatus reads each AI CLI's sign-in state afresh.
//
// Plain request/response rather than a subscription: the state lives in the
// CLIs' own credential files, which a terminal, another project or another
// cluster node can change without this server hearing of it, so there is no
// change for a subscription to push. The client asks when it needs to know.
func (h *rpcMethodHandler) handleCLIAuthStatus(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthStatusParams
	if req.Params != nil {
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
			return
		}
	}

	statuses, err := h.cliAuth.Statuses(ctx, params.Agent)
	if err != nil {
		h.replyCLIAuthError(ctx, conn, req.ID, err)
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.CLIAuthStatusResult{Statuses: statuses}); err != nil {
		h.log.Error("failed to send cli auth status response", "error", err)
	}
}

func (h *rpcMethodHandler) handleCLIAuthLogout(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthLogoutParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}

	status, err := h.cliAuth.Logout(ctx, params.Agent)
	if err != nil {
		h.replyCLIAuthError(ctx, conn, req.ID, err)
		return
	}

	if err := conn.Reply(ctx, req.ID, rpc.CLIAuthLogoutResult{Status: status}); err != nil {
		h.log.Error("failed to send cli auth logout response", "error", err)
	}
}

// replyCLIAuthError passes the CLI's own reason through: it is what the user
// needs to see ("claude auth logout failed: ..."), and the providers word it
// for them.
func (h *rpcMethodHandler) replyCLIAuthError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	h.replyReasonError(ctx, conn, id, err,
		cliauth.ErrUnknownAgent,
		cliauth.ErrInvalidAccountKind,
		cliauth.ErrLoginNotFound,
		cliauth.ErrCodeNotExpected,
		cliauth.ErrInvalidCode,
	)
}

// replyReasonError replies with err's own message, as invalid params when it
// is one of clientErrs and as an internal error otherwise.
func (h *rpcMethodHandler) replyReasonError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error, clientErrs ...error) {
	code := int64(jsonrpc2.CodeInternalError)
	for _, clientErr := range clientErrs {
		if errors.Is(err, clientErr) {
			code = jsonrpc2.CodeInvalidParams
		}
	}
	h.replyError(ctx, conn, id, code, err.Error())
}

// handleCLIAuthLoginStart starts a sign-in, or answers with the one already
// running for the CLI. The sign-in is the server's, not this connection's: it
// carries on if the client goes away, and cli_auth.login.subscribe finds it
// again.
func (h *rpcMethodHandler) handleCLIAuthLoginStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthLoginStartParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}
	login, err := h.cliAuth.StartLogin(params.Agent, params.AccountKind)
	h.replyCLIAuthLogin(ctx, conn, req.ID, login, err)
}

// handleCLIAuthLoginSubmitCode hands the CLI a pasted code. The reply is the
// sign-in verifying it; the verdict arrives as cli_auth.login.changed. The code
// is never logged.
func (h *rpcMethodHandler) handleCLIAuthLoginSubmitCode(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthLoginSubmitCodeParams
	if err := unmarshalParams(req, &params); err != nil || params.LoginID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: login_id is required")
		return
	}
	login, err := h.cliAuth.SubmitCode(params.LoginID, params.Code)
	h.replyCLIAuthLogin(ctx, conn, req.ID, login, err)
}

func (h *rpcMethodHandler) handleCLIAuthLoginCancel(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthLoginCancelParams
	if err := unmarshalParams(req, &params); err != nil || params.LoginID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: login_id is required")
		return
	}
	login, err := h.cliAuth.CancelLogin(params.LoginID)
	h.replyCLIAuthLogin(ctx, conn, req.ID, login, err)
}

func (h *rpcMethodHandler) handleCLIAuthLoginSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIAuthLoginSubscribeParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}

	login, err := h.cliLoginWatcher.Subscribe(params.ID, params.Agent, h.state.getNotifier())
	if err != nil {
		if errors.Is(err, cliauth.ErrUnknownAgent) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to CLI sign-in")
		return
	}
	h.state.trackSubscription(params.ID, h.cliLoginWatcher)

	if err := conn.Reply(ctx, req.ID, rpc.CLIAuthLoginSubscribeResult{Login: login}); err != nil {
		h.log.Error("failed to send cli auth login subscribe response", "error", err)
	}
}

func (h *rpcMethodHandler) replyCLIAuthLogin(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, login cliauth.Login, err error) {
	if err != nil {
		h.replyCLIAuthError(ctx, conn, id, err)
		return
	}
	if err := conn.Reply(ctx, id, rpc.CLIAuthLoginResult{Login: login}); err != nil {
		h.log.Error("failed to send cli auth login response", "error", err)
	}
}
