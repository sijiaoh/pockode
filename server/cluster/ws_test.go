package cluster

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/cluster/node"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

const testPassword = "test-password"

// opTimeout bounds one websocket send or receive: long enough that a loaded
// machine never trips it, short enough that a stuck server names the operation
// instead of hanging until the test binary panics.
const opTimeout = 30 * time.Second

type response struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *jsonrpc2.Error `json:"error,omitempty"`
}

func newAuthTestServer(t *testing.T, sessions *authsessiontest.Sessions) *httptest.Server {
	t.Helper()
	nodeStore, err := node.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("failed to create node store: %v", err)
	}
	h := newWSHandler(testPassword, sessions, "test", true, nodeStore, node.NewProcessManager(),
		slog.New(slog.DiscardHandler))
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	return server
}

// callOnce sends one request over a fresh connection. Fresh per call because
// every refusal below closes the connection, and the first request is the only
// one an unauthenticated connection gets.
func callOnce(t *testing.T, serverURL, method string, params any) response {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http"), nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}
	var resp response
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}
	return resp
}

// The cluster front end stores a session token exactly as the server's does, so
// the exchange has to work the same way here: a password buys a token, and the
// token comes back unchanged so a client can store it without knowing which
// credential it used.
func TestClusterAuth_PasswordIssuesReusableSessionToken(t *testing.T) {
	server := newAuthTestServer(t, authsessiontest.New())

	resp := callOnce(t, server.URL, "auth", AuthParams{Password: testPassword})
	if resp.Error != nil {
		t.Fatalf("auth with password failed: %v", resp.Error)
	}
	var first AuthResult
	if err := json.Unmarshal(resp.Result, &first); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if first.SessionToken == "" {
		t.Fatal("auth with a password returned no session token")
	}

	resp = callOnce(t, server.URL, "auth", AuthParams{SessionToken: first.SessionToken})
	if resp.Error != nil {
		t.Fatalf("auth with the issued session token failed: %v", resp.Error)
	}
	var second AuthResult
	if err := json.Unmarshal(resp.Result, &second); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if second.SessionToken != first.SessionToken {
		t.Errorf("session token = %q, want it returned unchanged (%q)", second.SessionToken, first.SessionToken)
	}
}

func TestClusterAuth_Refusals(t *testing.T) {
	sessions := authsessiontest.New()
	live, err := sessions.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	server := newAuthTestServer(t, sessions)

	tests := []struct {
		name       string
		method     string
		params     any
		wantReason string
	}{
		{
			name:       "wrong password",
			method:     "auth",
			params:     AuthParams{Password: "wrong-password"},
			wantReason: rpc.AuthReasonInvalidPassword,
		},
		{
			name:       "unknown session token",
			method:     "auth",
			params:     AuthParams{SessionToken: live + "-tampered"},
			wantReason: rpc.AuthReasonSessionExpired,
		},
		{
			name:       "some other method first",
			method:     "node.list",
			params:     map[string]any{},
			wantReason: rpc.AuthReasonNotAuthenticated,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := callOnce(t, server.URL, tt.method, tt.params)
			if resp.Error == nil {
				t.Fatalf("expected an error reply, got result %s", resp.Result)
			}
			if resp.Error.Data == nil {
				t.Fatalf("error %q carries no data; clients branch on data.reason", resp.Error.Message)
			}
			var data rpc.AuthErrorData
			if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
				t.Fatalf("unmarshal error data: %v", err)
			}
			if data.Reason != tt.wantReason {
				t.Errorf("reason = %q, want %q", data.Reason, tt.wantReason)
			}
		})
	}
}

func TestClusterAuth_BothCredentialsRefused(t *testing.T) {
	sessions := authsessiontest.New()
	live, err := sessions.Issue()
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	server := newAuthTestServer(t, sessions)

	resp := callOnce(t, server.URL, "auth", AuthParams{Password: testPassword, SessionToken: live})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want an invalid-params error", resp.Error)
	}
}

// A cluster front end cached before the rename still sends `token`.
func TestClusterAuth_AcceptsDeprecatedTokenParam(t *testing.T) {
	server := newAuthTestServer(t, authsessiontest.New())

	resp := callOnce(t, server.URL, "auth", AuthParams{Token: testPassword})
	if resp.Error != nil {
		t.Fatalf("auth with the deprecated token param failed: %v", resp.Error)
	}
}
