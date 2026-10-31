package cluster

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/internal/restart"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/rpc"
)

// authenticatedCall authenticates a fresh connection and sends method on it,
// returning the reply and the connection, which stays the caller's to read.
func authenticatedCall(t *testing.T, serverURL, method string, params any) (response, *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(serverURL, "http"), nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	var resp response
	for id, call := range []struct {
		method string
		params any
	}{{"auth", AuthParams{Password: testPassword}}, {method, params}} {
		data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": call.method, "params": call.params})
		if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
			t.Fatalf("failed to send %s: %v", call.method, err)
		}
		_, respData, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("failed to read %s reply: %v", call.method, err)
		}
		resp = response{}
		if err := json.Unmarshal(respData, &resp); err != nil {
			t.Fatalf("unmarshal %s reply: %v", call.method, err)
		}
		if call.method == "auth" && resp.Error != nil {
			t.Fatalf("auth failed: %v", resp.Error)
		}
	}
	return resp, conn
}

func TestClusterServerVersion(t *testing.T) {
	server := newAuthTestServer(t, authsessiontest.New())
	restarttest.Install(t, "9.9.9")

	resp, _ := authenticatedCall(t, server.URL, "server.version", nil)
	if resp.Error != nil {
		t.Fatalf("server.version failed: %v", resp.Error)
	}
	var got rpc.ClusterVersionResult
	if err := json.Unmarshal(resp.Result, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if want := (rpc.InstalledVersion{Version: "9.9.9", Path: os.Args[0]}); got.Installed != want {
		t.Errorf("installed = %+v, want %+v", got.Installed, want)
	}
}

func TestClusterServerRestart(t *testing.T) {
	t.Run("refuses what cannot run, in the cluster's words", func(t *testing.T) {
		restarter := restart.New(restarttest.Executable(t.TempDir()))
		server := newTestServer(t, authsessiontest.New(), restarter)
		restarttest.Break(t, "boom")

		resp, _ := authenticatedCall(t, server.URL, "server.restart", nil)
		if resp.Error == nil || resp.Error.Code != rpc.CodeRestartRefused {
			t.Fatalf("server.restart = %+v, want a refusal", resp)
		}
		if !strings.HasSuffix(resp.Error.Message, ". The cluster kept running; nothing was stopped.") {
			t.Errorf("message = %q, want the cluster's refusal copy", resp.Error.Message)
		}
		if restarter.Pending() {
			t.Error("a refused restart is pending")
		}
	})

	t.Run("lets the shutdown go once the client has the reply", func(t *testing.T) {
		restarter := restart.New(restarttest.Executable(t.TempDir()))
		server := newTestServer(t, authsessiontest.New(), restarter)
		restarttest.Install(t, "9.9.9")

		resp, conn := authenticatedCall(t, server.URL, "server.restart", nil)
		if resp.Error != nil {
			t.Fatalf("server.restart failed: %v", resp.Error)
		}
		select {
		case <-restarter.Requested():
			t.Fatal("the shutdown was let go before the client answered the close")
		default:
		}

		ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
		defer cancel()
		if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusServiceRestart {
			t.Fatalf("read after the reply = %v, want a close with %d", err, websocket.StatusServiceRestart)
		}
		select {
		case <-restarter.Requested():
		case <-time.After(opTimeout):
			t.Fatal("the shutdown was never let go")
		}
	})
}
