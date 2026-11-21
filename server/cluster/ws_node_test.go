package cluster

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/authsession"
	"github.com/pockode/server/cluster/node"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/localapi"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/serverinfo"
)

// TestNodeRestart_Refusals holds the wire half of node.restart's refusals:
// each is CodeRestartRefused with the reason the panel branches on, and a
// message it shows as it is. The node they are about is this test process
// (serverinfo.Write records the caller's PID); every refusal here comes before
// anything is sent, which is what makes that safe. Whether a request reaches a
// node is package node's TestRestart.
func TestNodeRestart_Refusals(t *testing.T) {
	tests := []struct {
		name string
		// version is the running version written to server.json; nil is no
		// server.json at all.
		version     *string
		breakBinary bool
		wantReason  string
		wantMessage string // a fragment
	}{
		{
			name:        "not running",
			wantReason:  rpc.RestartRefusedNotRunning,
			wantMessage: "This node is not running.",
		},
		{
			name:        "started by an older Pockode",
			version:     ptr(""),
			wantReason:  rpc.RestartRefusedOlderNode,
			wantMessage: "started by an older Pockode",
		},
		{
			name:        "installed executable does not run",
			version:     ptr("1.0.0"),
			breakBinary: true,
			wantReason:  rpc.RestartRefusedNotRunnable,
			wantMessage: "didn't run: --version: exit status 3: boom. The node kept running; nothing was stopped.",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := newTestServer(t, authsessiontest.New(), restart.New(restarttest.Executable(t.TempDir())))
			restarttest.Install(t, "2.0.0")
			if tc.breakBinary {
				restarttest.Break(t, "boom")
			}

			nodeDir := t.TempDir()
			resp, _ := authenticatedCall(t, server.URL, "node.create", NodeCreateParams{Path: nodeDir})
			if resp.Error != nil {
				t.Fatalf("node.create failed: %v", resp.Error)
			}
			var n node.Node
			if err := json.Unmarshal(resp.Result, &n); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if tc.version != nil {
				if err := serverinfo.Write(filepath.Join(nodeDir, ".pockode"), *tc.version, 9870, "", "", "token"); err != nil {
					t.Fatal(err)
				}
			}

			resp, _ = authenticatedCall(t, server.URL, "node.restart", NodeRestartParams{ID: n.ID})
			if resp.Error == nil || resp.Error.Code != rpc.CodeRestartRefused {
				t.Fatalf("node.restart = %+v, want a refusal", resp)
			}
			var data rpc.RestartRefusedData
			if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil {
				t.Fatalf("refusal %q carries no reason", resp.Error.Message)
			}
			if data.Reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", data.Reason, tc.wantReason)
			}
			if !strings.Contains(resp.Error.Message, tc.wantMessage) {
				t.Errorf("message = %q, want it to contain %q", resp.Error.Message, tc.wantMessage)
			}
		})
	}
}

func ptr[T any](v T) *T { return &v }

// TestNodeLoginTicket is the wire half of node.login_ticket: a ticket the node
// redeems, or the refusal the panel branches on. Which node answers what is
// package node's TestLoginTicket_*. The running node here is this test process
// (serverinfo.Write records the caller's PID), with its local API served by
// localAPI.
func TestNodeLoginTicket(t *testing.T) {
	const token = "local-token"
	tickets := authsession.NewTickets()
	mux := http.NewServeMux()
	mux.Handle("POST "+localapi.LoginTicketPath, localapi.NewLoginTicketHandler(tickets, token))
	localAPI := httptest.NewServer(mux)
	t.Cleanup(localAPI.Close)
	olderNode := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(olderNode.Close)

	tests := []struct {
		name string
		// localURL is the running node's; empty is a node with no server.json.
		localURL   string
		wantReason string // empty for a ticket
	}{
		{name: "running node", localURL: localAPI.URL},
		{name: "older node", localURL: olderNode.URL, wantReason: rpc.NodeLoginTicketRefusedUnsupported},
		{name: "not running", wantReason: rpc.NodeLoginTicketRefusedNotRunning},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := newAuthTestServer(t, authsessiontest.New())
			nodeDir := t.TempDir()
			resp, _ := authenticatedCall(t, server.URL, "node.create", NodeCreateParams{Path: nodeDir})
			if resp.Error != nil {
				t.Fatalf("node.create failed: %v", resp.Error)
			}
			var n node.Node
			if err := json.Unmarshal(resp.Result, &n); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if tc.localURL != "" {
				if err := serverinfo.Write(filepath.Join(nodeDir, ".pockode"), "1.0.0", 9870, tc.localURL, "", token); err != nil {
					t.Fatal(err)
				}
			}

			resp, _ = authenticatedCall(t, server.URL, "node.login_ticket", NodeLoginTicketParams{ID: n.ID})

			if tc.wantReason == "" {
				if resp.Error != nil {
					t.Fatalf("node.login_ticket failed: %v", resp.Error)
				}
				var result rpc.NodeLoginTicketResult
				if err := json.Unmarshal(resp.Result, &result); err != nil {
					t.Fatalf("unmarshal: %v", err)
				}
				if !tickets.Redeem(result.Ticket) {
					t.Errorf("ticket %q does not redeem on the node", result.Ticket)
				}
				return
			}
			if resp.Error == nil || resp.Error.Code != rpc.CodeNodeLoginTicketRefused {
				t.Fatalf("node.login_ticket = %+v, want a refusal", resp)
			}
			var data rpc.NodeLoginTicketRefusedData
			if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil {
				t.Fatalf("refusal %q carries no reason", resp.Error.Message)
			}
			if data.Reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", data.Reason, tc.wantReason)
			}
		})
	}
}
