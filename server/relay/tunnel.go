package relay

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/hashicorp/yamux"
)

const (
	// tunnelWriteTimeout is yamux's budget for handing one frame to the relay
	// WebSocket, and also the window a keepalive ping has to be answered. It
	// must stay well above the time needed to drain the frames already queued
	// ahead of a ping, otherwise a merely slow uplink reads as a dead one.
	// The cloud relay sets the same budget for its own direction; the two are
	// independent, each side only probes the liveness of the link as it sees
	// it.
	tunnelWriteTimeout      = 30 * time.Second
	tunnelKeepAliveInterval = 30 * time.Second

	// tunnelReadHeaderTimeout bounds how long the relay may take to finish
	// sending request headers on a stream it opened.
	tunnelReadHeaderTimeout = 10 * time.Second
)

// serveTunnel runs the pockode end of the relay: the cloud opens one yamux
// stream per public request, and each stream is an ordinary HTTP connection.
// Nothing about the relay leaks into handler: this is net/http served over a
// different listener.
//
// It blocks until the session ends, which is the only way the tunnel stops —
// the caller reconnects from there.
func serveTunnel(ctx context.Context, conn net.Conn, handler http.Handler, log *slog.Logger) error {
	session, err := yamux.Client(conn, yamuxConfig(log))
	if err != nil {
		return err
	}
	defer session.Close()

	srv := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: tunnelReadHeaderTimeout,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}
	defer srv.Close()

	// *yamux.Session is a net.Listener whose Accept yields streams.
	return srv.Serve(session)
}

// yamuxConfig differs from hashicorp/yamux's defaults only in the liveness
// budget; see tunnelWriteTimeout.
func yamuxConfig(logger *slog.Logger) *yamux.Config {
	cfg := yamux.DefaultConfig()
	cfg.KeepAliveInterval = tunnelKeepAliveInterval
	cfg.ConnectionWriteTimeout = tunnelWriteTimeout
	// yamux accepts exactly one of LogOutput and Logger. Its own chatter is
	// transport noise, so it lands at debug.
	cfg.LogOutput = nil
	cfg.Logger = slog.NewLogLogger(logger.Handler(), slog.LevelDebug)
	return cfg
}
