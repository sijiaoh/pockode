package mcp

import (
	"context"
	"errors"
	"flag"
	"fmt"
)

// proxyArgs is what the `mcp` subcommand is told on its command line.
type proxyArgs struct {
	dataDir string
	caller  Caller
}

// parseProxyArgs parses the arguments that follow the `mcp` subcommand's name.
// The flags are the contract with the agents that spawn it (agent/claude,
// agent/codex), which is why they are parsed here and not by each binary that
// can serve as the proxy: the server's own main, and the question eval's test
// binary, which stands in for it there.
func parseProxyArgs(args []string, errorHandling flag.ErrorHandling) (proxyArgs, error) {
	flags := flag.NewFlagSet("mcp", errorHandling)
	dataDir := flags.String("data-dir", "", "data directory (required)")
	// Who this proxy speaks for. Written into the spawn by the agent that starts
	// the CLI, so tools can act on the calling session without the model naming
	// it. Optional: a proxy started by hand has no session.
	sessionID := flags.String("session-id", "", "session the calling CLI runs (optional)")
	worktree := flags.String("worktree", "", "worktree that session lives in (optional; empty is the main worktree)")
	if err := flags.Parse(args); err != nil {
		return proxyArgs{}, err
	}

	if *dataDir == "" {
		return proxyArgs{}, errors.New("--data-dir is required")
	}
	return proxyArgs{
		dataDir: *dataDir,
		caller:  Caller{SessionID: *sessionID, Worktree: *worktree},
	}, nil
}

// RunProxy runs the stdio proxy as the `mcp` subcommand, taking the arguments
// that follow the subcommand's name (see parseProxyArgs).
func RunProxy(args []string, version string) error {
	parsed, err := parseProxyArgs(args, flag.ExitOnError)
	if err != nil {
		return err
	}

	// Client mode: discover the running server from server.json and forward tool
	// calls over its local API. The MCP process owns no stores and no watcher.
	client, err := NewClientFromServerInfo(parsed.dataDir, parsed.caller)
	if err != nil {
		return err
	}
	if err := NewServer(client, version).Run(context.Background()); err != nil {
		return fmt.Errorf("MCP server failed: %w", err)
	}
	return nil
}
