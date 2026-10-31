package ws

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/internal/restarttest"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

func serverVersion(t *testing.T, env *testEnv) rpc.ServerVersionResult {
	t.Helper()
	resp := env.call("server.version", nil)
	if resp.Error != nil {
		t.Fatalf("server.version failed: %s", resp.Error.Message)
	}
	var result rpc.ServerVersionResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal server.version result: %v", err)
	}
	return result
}

func TestHandler_ServerVersion(t *testing.T) {
	t.Run("reports the installed version", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		restarttest.Install(t, "9.9.9")

		got := serverVersion(t, env)
		want := rpc.InstalledVersion{Version: "9.9.9", Path: os.Args[0]}
		if got.Installed != want {
			t.Errorf("installed = %+v, want %+v", got.Installed, want)
		}
		if got.RunningTurns != 0 {
			t.Errorf("running_turns = %d with no session, want 0", got.RunningTurns)
		}
	})

	t.Run("reports why the installed version could not be read", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		restarttest.Break(t, "boom")

		got := serverVersion(t, env).Installed
		if got.Version != "" || !strings.Contains(got.Error, "boom") || got.Path != os.Args[0] {
			t.Errorf("installed = %+v, want no version, an error carrying the stderr, and the path", got)
		}
	})

	t.Run("counts a turn waiting for an answer", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})
		restarttest.Install(t, "9.9.9")
		env.getMainWorktree().SessionStore.Create(bgCtx, "idle", session.CreateSpec{})
		_, sessionID := startWorkWaiting(t, env, work.WaitNone)
		// The kickoff turn ends first, or its end would take the prompt with
		// it. A prompt raised after its turn has ended is the case to count:
		// no turn is open, and the restart still ends the process that would
		// take the answer.
		deadline := time.Now().Add(opTimeout)
		for {
			meta, _, err := env.getMainWorktree().SessionStore.Get(sessionID)
			if err == nil && meta.Turn.LastOutcome != "" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("the kickoff turn never ended")
			}
			time.Sleep(5 * time.Millisecond)
		}
		raisePrompt(t, env, sessionID, "req-1", agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})

		if got := serverVersion(t, env).RunningTurns; got != 1 {
			t.Errorf("running_turns = %d, want 1", got)
		}
	})
}

func restartRefusal(t *testing.T, resp rpcResponse) (reason, message string) {
	t.Helper()
	if resp.Error == nil {
		t.Fatal("server.restart succeeded, want a refusal")
	}
	if resp.Error.Code != rpc.CodeRestartRefused {
		t.Fatalf("server.restart error code = %d, want %d (%s)", resp.Error.Code, rpc.CodeRestartRefused, resp.Error.Message)
	}
	var data rpc.RestartRefusedData
	if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil {
		t.Fatalf("server.restart refusal carries no reason: %+v", resp.Error)
	}
	return data.Reason, resp.Error.Message
}

func TestHandler_ServerRestart_RefusesWhatCannotRun(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	restarttest.Break(t, "boom")

	reason, message := restartRefusal(t, env.call("server.restart", nil))
	if reason != rpc.RestartRefusedNotRunnable {
		t.Errorf("reason = %q, want %q", reason, rpc.RestartRefusedNotRunnable)
	}
	want := "The installed pockode at " + os.Args[0] + " didn't run: "
	if !strings.HasPrefix(message, want) || !strings.Contains(message, "boom") ||
		!strings.HasSuffix(message, ". Pockode kept running; nothing was stopped.") {
		t.Errorf("message = %q, want the refusal copy naming the path and the stderr", message)
	}
	if env.restarter.Pending() {
		t.Error("a refused restart is pending")
	}
	// Nothing changed: the connection carries on, and a fixed file restarts.
	restarttest.Install(t, "9.9.9")
	if resp := env.call("server.restart", nil); resp.Error != nil {
		t.Errorf("server.restart after the file was fixed = %s", resp.Error.Message)
	}
}

// The process must not start going down before the client has the reply:
// the shutdown begins with the relay, and a reply still in the tunnel then is
// lost. So the reply is followed by a close the client has to answer, and the
// restart is held until it has. The relay reaches /ws through a reverse proxy
// on this machine (relay.newLocalProxy); the handshake has to hold across it.
func TestHandler_ServerRestart_ShutsDownOnlyOnceTheClientHasTheReply(t *testing.T) {
	for _, tc := range []struct {
		name  string
		serve func(h http.Handler) http.Handler
	}{
		{"direct", func(h http.Handler) http.Handler { return h }},
		{"through a reverse proxy, as relayed", func(h http.Handler) http.Handler {
			backend := httptest.NewServer(h)
			t.Cleanup(backend.Close)
			target, err := url.Parse(backend.URL)
			if err != nil {
				t.Fatal(err)
			}
			return httputil.NewSingleHostReverseProxy(target)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newMinimalTestHandler(t, testPassword, func() string { return "" }, authsessiontest.New(), authsession.NewTickets())
			server := httptest.NewServer(tc.serve(h))
			t.Cleanup(server.Close)
			restarttest.Install(t, "9.9.9")
			restarter := h.server.Restarter

			ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
			defer cancel()
			conn, err := dialTestClient(ctx, server.URL)
			if err != nil {
				t.Fatalf("failed to connect: %v", err)
			}
			defer conn.CloseNow()
			if resp := exchange(t, ctx, conn, 1, "auth", rpc.AuthParams{Password: testPassword}); resp.Error != nil {
				t.Fatalf("auth failed: %s", resp.Error.Message)
			}

			if resp := exchange(t, ctx, conn, 2, "server.restart", nil); resp.Error != nil {
				t.Fatalf("server.restart = %s", resp.Error.Message)
			}
			if !restarter.Pending() {
				t.Error("the restart is not pending once accepted")
			}
			// The client has read the reply but not yet the close behind it,
			// so it cannot have answered that close.
			select {
			case <-restarter.Requested():
				t.Fatal("the shutdown was let go before the client answered the close")
			default:
			}

			_, _, err = conn.Read(ctx)
			if status := websocket.CloseStatus(err); status != websocket.StatusServiceRestart {
				t.Fatalf("read after the reply = %v, want the connection closed with %d", err, websocket.StatusServiceRestart)
			}
			select {
			case <-restarter.Requested():
			case <-time.After(opTimeout):
				t.Fatal("the shutdown was never let go after the client answered the close")
			}
		})
	}
}

func TestHandler_ServerRestart_RefusesWhileOneIsUnderWay(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	restarttest.Install(t, "9.9.9")
	if err := env.restarter.Request(context.Background()); err != nil {
		t.Fatalf("Request() = %v", err)
	}

	reason, message := restartRefusal(t, env.call("server.restart", nil))
	if reason != rpc.RestartRefusedAlreadyRestarting || message != "Pockode is already restarting." {
		t.Errorf("refusal = %q %q, want %q", reason, message, rpc.RestartRefusedAlreadyRestarting)
	}
}

func TestHandler_ServerRestart_RefusesWhileShuttingDown(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	restarttest.Install(t, "9.9.9")
	env.restarter.Close()

	reason, message := restartRefusal(t, env.call("server.restart", nil))
	if reason != rpc.RestartRefusedShuttingDown || message != "Pockode is shutting down." {
		t.Errorf("refusal = %q %q, want %q", reason, message, rpc.RestartRefusedShuttingDown)
	}
}
