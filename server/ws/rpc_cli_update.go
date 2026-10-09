package ws

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// handleCLIUpdateCheck reads each AI CLI's installed and latest version afresh.
// Nothing is pushed: a CLI updates itself, or is updated from a terminal,
// without this server hearing of it, so the client asks when it needs to know.
func (h *rpcMethodHandler) handleCLIUpdateCheck(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIUpdateCheckParams
	if req.Params != nil {
		if err := json.Unmarshal(*req.Params, &params); err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
			return
		}
	}

	checks, err := h.cliUpdate.Checks(ctx, params.Agent)
	if err != nil {
		h.replyCLIUpdateError(ctx, conn, req.ID, err)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.CLIUpdateCheckResult{Checks: checks}); err != nil {
		h.log.Error("failed to send cli update check response", "error", err)
	}
}

// handleCLIUpdateStart starts an update, or answers with the one already
// running for the CLI. The update is the server's, not this connection's: it
// carries on if the client goes away, and cli_update.subscribe finds it again.
func (h *rpcMethodHandler) handleCLIUpdateStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIUpdateStartParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}

	update, err := h.cliUpdate.StartUpdate(params.Agent)
	if err != nil {
		h.replyCLIUpdateError(ctx, conn, req.ID, err)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.CLIUpdateStartResult{Update: update}); err != nil {
		h.log.Error("failed to send cli update start response", "error", err)
	}
}

// handleCLIUpdateInstall installs a CLI the server cannot find, or answers
// with the install already running for it. Like an update, the install is the
// server's and is followed with cli_update.subscribe.
func (h *rpcMethodHandler) handleCLIUpdateInstall(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIUpdateInstallParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}

	update, err := h.cliUpdate.StartInstall(params.Agent)
	if err != nil {
		if reason := cliInstallRefusal(err); reason != "" {
			h.replyErrorData(ctx, conn, req.ID, rpc.CodeCLIInstallRefused, err.Error(), rpc.CLIInstallRefusedData{Reason: reason})
			return
		}
		h.replyCLIUpdateError(ctx, conn, req.ID, err)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.CLIUpdateInstallResult{Update: update}); err != nil {
		h.log.Error("failed to send cli update install response", "error", err)
	}
}

// cliInstallRefusal is the reason of an install refused for something a
// client can show its own copy for, or "" for any other error.
func cliInstallRefusal(err error) string {
	switch {
	case errors.Is(err, cliupdate.ErrAlreadyInstalled):
		return rpc.CLIInstallRefusedAlreadyInstalled
	case errors.Is(err, cliupdate.ErrInstallerNotFound):
		return rpc.CLIInstallRefusedNPMNotFound
	case errors.Is(err, cliupdate.ErrBusy):
		return rpc.CLIInstallRefusedBusy
	}
	return ""
}

// handleCLIUpdateDismiss drops an ended update. Its subscribers are told the
// CLI's latest update is now none.
func (h *rpcMethodHandler) handleCLIUpdateDismiss(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIUpdateDismissParams
	if err := unmarshalParams(req, &params); err != nil || params.UpdateID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: update_id is required")
		return
	}
	if err := h.cliUpdate.Dismiss(params.UpdateID); err != nil {
		h.replyCLIUpdateError(ctx, conn, req.ID, err)
		return
	}
	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send cli update dismiss response", "error", err)
	}
}

func (h *rpcMethodHandler) handleCLIUpdateSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.CLIUpdateSubscribeParams
	if err := unmarshalParams(req, &params); err != nil || params.Agent == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params: agent is required")
		return
	}

	update, err := h.cliUpdateWatcher.Subscribe(params.ID, params.Agent, h.state.getNotifier())
	if err != nil {
		if errors.Is(err, cliupdate.ErrUnknownAgent) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replySubscriptionError(ctx, conn, req.ID, err, "failed to subscribe to CLI update")
		return
	}
	h.state.trackSubscription(params.ID, h.cliUpdateWatcher)

	if err := conn.Reply(ctx, req.ID, rpc.CLIUpdateSubscribeResult{Update: update}); err != nil {
		h.log.Error("failed to send cli update subscribe response", "error", err)
	}
}

// replyCLIUpdateError passes the reason through: a refused start is shown to
// the user as it is ("a sign-in to claude is in progress; ...").
func (h *rpcMethodHandler) replyCLIUpdateError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	h.replyReasonError(ctx, conn, id, err,
		cliupdate.ErrUnknownAgent,
		cliupdate.ErrUpdateNotFound,
		cliupdate.ErrUpdateRunning,
	)
}
