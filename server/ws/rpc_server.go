package ws

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// ServerControl serves the server namespace — server.version and
// server.restart — for whichever process owns the Restarter. A pockode server
// and a cluster share it; Subject is how the refusal copy names the process
// ("Pockode", "The cluster").
type ServerControl struct {
	Restarter *restart.Restarter
	Subject   string
}

// Installed reads the installed version afresh.
func (c ServerControl) Installed(ctx context.Context) rpc.InstalledVersion {
	program := c.Restarter.Program()
	installed := rpc.InstalledVersion{Path: program.Path}
	version, err := program.Version(ctx)
	if err != nil {
		installed.Error = err.Error()
	} else {
		installed.Version = version
	}
	return installed
}

// restartReplyTimeout bounds how long an accepted restart waits for its reply
// to be acknowledged before shutting down regardless. The close itself gives
// up after at most about 10 s (coder/websocket allows 5 s to write the close
// frame and 5 s for the answer); this also covers the queue ahead of the reply,
// which a client this slow has stopped waiting on anyway.
const restartReplyTimeout = 10 * time.Second

// HandleRestart answers server.restart. A success is the empty object, and the
// process starts going down only after the client has acknowledged it: the
// connection is closed right after the reply with StatusServiceRestart (1012),
// and the shutdown is held (Restarter.RequestHeld) until the client answers
// that close — or restartReplyTimeout passes.
//
// The order matters because the shutdown begins with the relay: a reply merely
// written to the socket may still be on its way through the tunnel when it is
// torn down, and a client that sees the connection drop without a reply cannot
// tell a restart from a failure. The close handshake is end to end, relay or
// not — a client answering the close has read every frame before it.
func (c ServerControl) HandleRestart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, stream jsonrpc2.ObjectStream, log *slog.Logger) {
	release, err := c.Restarter.RequestHeld(ctx)
	if err != nil {
		reason, message := c.refusal(err)
		log.Info("restart refused", "reason", reason, "error", err)
		replyErr := &jsonrpc2.Error{Code: rpc.CodeRestartRefused, Message: message}
		replyErr.SetError(rpc.RestartRefusedData{Reason: reason})
		if err := conn.ReplyWithError(ctx, req.ID, replyErr); err != nil {
			log.Error("failed to send server.restart refusal", "error", err)
		}
		return
	}
	defer release()

	// A reply that cannot be queued means the connection is already gone. The
	// restart was accepted and goes ahead: the client finds out by
	// reconnecting, as it would from a restart asked for anywhere else.
	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Warn("restarting without replying to server.restart: the connection is gone", "error", err)
		return
	}
	flushed, ok := stream.(interface {
		CloseAfterFlush(websocket.StatusCode, string) <-chan struct{}
	})
	if !ok {
		log.Warn("restarting without waiting for the server.restart reply: the stream cannot close after flushing")
		return
	}
	select {
	case <-flushed.CloseAfterFlush(websocket.StatusServiceRestart, "server restarting"):
	case <-time.After(restartReplyTimeout):
		log.Warn("restarting without the client acknowledging the reply", "timeout", restartReplyTimeout)
	}
}

// refusal is the reason and the copy of a refused request; the copy is
// docs/restart-ui.md's.
func (c ServerControl) refusal(err error) (reason, message string) {
	switch {
	case errors.Is(err, restart.ErrAlreadyRestarting):
		return rpc.RestartRefusedAlreadyRestarting, c.Subject + " is already restarting."
	case errors.Is(err, restart.ErrShuttingDown):
		return rpc.RestartRefusedShuttingDown, c.Subject + " is shutting down."
	}
	var notRunnable *restart.NotRunnableError
	if errors.As(err, &notRunnable) {
		return rpc.RestartRefusedNotRunnable, "The installed pockode at " + c.Restarter.Program().Path +
			" didn't run: " + notRunnable.Err.Error() + ". " + c.Subject + " kept running; nothing was stopped."
	}
	// Request refuses for no other reason; a new one would surface verbatim.
	return "", err.Error()
}

// handleServerVersion reads the installed version afresh, with what a restart
// would cost: the turns it would stop. Nothing is pushed — an upgrade replaces
// the file without this server hearing of it — so the client asks when it is
// about to show either.
func (h *rpcMethodHandler) handleServerVersion(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	turns, err := h.worktreeManager.RunningTurns()
	if err != nil {
		h.log.Error("failed to count running turns", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to count running turns: "+err.Error())
		return
	}
	result := rpc.ServerVersionResult{
		Installed:    h.server.Installed(ctx),
		RunningTurns: turns,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send server.version response", "error", err)
	}
}
