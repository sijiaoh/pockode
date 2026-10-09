package ws

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/cliupdate"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// The update flow itself is cliupdate's to test; here, that each method turns
// a request it cannot act on into invalid params rather than a server error.
func TestCLIUpdate_Errors(t *testing.T) {
	tests := []struct {
		name    string
		method  string
		params  any
		wantMsg string
	}{
		{"check unknown agent", "cli_update.check", rpc.CLIUpdateCheckParams{Agent: "gemini"}, "unknown agent"},
		{"start without agent", "cli_update.start", rpc.CLIUpdateStartParams{}, "agent is required"},
		{"start unknown agent", "cli_update.start", rpc.CLIUpdateStartParams{Agent: "gemini"}, "unknown agent"},
		{"install without agent", "cli_update.install", rpc.CLIUpdateInstallParams{}, "agent is required"},
		{"install unknown agent", "cli_update.install", rpc.CLIUpdateInstallParams{Agent: "gemini"}, "unknown agent"},
		{"dismiss without update", "cli_update.dismiss", rpc.CLIUpdateDismissParams{}, "update_id is required"},
		{"dismiss an unknown update", "cli_update.dismiss", rpc.CLIUpdateDismissParams{UpdateID: "nope"}, "no such update"},
		{"subscribe without agent", "cli_update.subscribe", rpc.CLIUpdateSubscribeParams{ID: "s"}, "agent is required"},
		{"subscribe unknown agent", "cli_update.subscribe", rpc.CLIUpdateSubscribeParams{ID: "s", Agent: "gemini"}, "unknown agent"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := newTestEnv(t, &mockAgent{})
			resp := env.call(tt.method, tt.params)
			if resp.Error == nil {
				t.Fatal("expected an error")
			}
			if resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, tt.wantMsg) {
				t.Errorf("got %d %q, want invalid params containing %q", resp.Error.Code, resp.Error.Message, tt.wantMsg)
			}
		})
	}
}

// An install refused for a reason the client has its own copy for carries that
// reason; anything else is an error with a message only.
func TestCLIInstallRefusal(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{fmt.Errorf("claude %w at /usr/bin/claude", cliupdate.ErrAlreadyInstalled), rpc.CLIInstallRefusedAlreadyInstalled},
		{fmt.Errorf("%w: install Node.js", cliupdate.ErrInstallerNotFound), rpc.CLIInstallRefusedNPMNotFound},
		{fmt.Errorf("wrapped: %w", cliupdate.ErrBusy), rpc.CLIInstallRefusedBusy},
		{cliupdate.ErrShuttingDown, ""},
		{errors.New("no home directory"), ""},
	}
	for _, tt := range tests {
		if got := cliInstallRefusal(tt.err); got != tt.want {
			t.Errorf("cliInstallRefusal(%v) = %q, want %q", tt.err, got, tt.want)
		}
	}
}
