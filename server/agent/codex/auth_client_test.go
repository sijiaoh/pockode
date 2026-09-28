package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/cliauth"
)

// The test binary re-execs itself as a fake `codex`, so that the account client
// is driven over a real process and real pipes — on Windows too — without a
// Codex install or an account.
const (
	fakeCodexRoleEnv = "POCKODE_TEST_FAKE_CODEX"
	// fakeSignedIn answers account/read with a ChatGPT account until
	// account/logout, and account/read with none after it. Before each reply it
	// sends a notification and a reply to a request nobody made, which the
	// client has to see past.
	fakeSignedIn = "signed_in"
	// fakeExits dies at the handshake, saying why on stderr.
	fakeExits = "exits"
	// fakeSilent completes the handshake and then answers nothing.
	fakeSilent = "silent"
	// fakeTooOld has no account API.
	fakeTooOld = "too_old"

	// The sign-in roles answer account/login/start with a device code, then
	// end the sign-in as their name says. Each first announces the end of a
	// sign-in that is not the one started, which the client has to see past.
	fakeLoginSucceeds = "login_succeeds"
	fakeLoginFails    = "login_fails"
	fakeLoginExpires  = "login_expires"
	// fakeLoginWaits never ends the sign-in.
	fakeLoginWaits = "login_waits"
	// fakeLoginUnreadable ends it with a completion of the wrong shape.
	fakeLoginUnreadable = "login_unreadable"
	// fakeLoginDisabled refuses a ChatGPT sign-in, as forced_login_method =
	// "api" in config.toml makes Codex do.
	fakeLoginDisabled = "login_disabled"
)

const (
	fakeLoginID  = "fake-login-id"
	fakeUserCode = "ABCD-12345"
)

// runFakeLogin answers account/login/start for the sign-in roles.
func runFakeLogin(role string, id int64) {
	if role == fakeLoginDisabled {
		fmt.Printf(`{"jsonrpc":"2.0","id":%d,"error":{"code":-32600,"message":"ChatGPT login is disabled. Use API key login instead."}}`+"\n", id)
		return
	}
	data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{
		"type": "chatgptDeviceCode", "loginId": fakeLoginID, "verificationUrl": "https://auth.openai.com/codex/device", "userCode": fakeUserCode,
	}})
	fmt.Println(string(data))

	completed := func(loginID string, success bool, errMsg any) {
		data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "account/login/completed", "params": map[string]any{
			"loginId": loginID, "success": success, "error": errMsg,
		}})
		fmt.Println(string(data))
	}
	switch role {
	case fakeLoginWaits:
		return
	case fakeLoginSucceeds:
		// A reply nobody is waiting for, while nothing is: it must not hold
		// up the completion behind it.
		fmt.Printf(`{"jsonrpc":"2.0","id":%d,"result":{}}`+"\n", id+1000)
		completed("another-login", false, "Login was not completed")
		completed(fakeLoginID, true, nil)
	case fakeLoginUnreadable:
		fmt.Println(`{"jsonrpc":"2.0","method":"account/login/completed","params":{"loginId":"fake-login-id","success":"yes"}}`)
	case fakeLoginFails:
		completed("another-login", true, nil)
		completed(fakeLoginID, false, "device auth failed with status 403 Forbidden")
	case fakeLoginExpires:
		completed(fakeLoginID, false, "device auth timed out after 15 minutes")
	}
}

func TestMain(m *testing.M) {
	if role := os.Getenv(fakeCodexRoleEnv); role != "" {
		runFakeCodex(role)
		return
	}
	os.Exit(m.Run())
}

func runFakeCodex(role string) {
	if len(os.Args) > 1 && os.Args[1] == "--help" {
		fmt.Println("Commands:\n  app-server        [experimental] Run the app server or related tooling")
		os.Exit(0)
	}

	signedIn := !strings.HasPrefix(role, "login_")
	reply := func(id int64, result any) {
		data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		fmt.Println(string(data))
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req rpcMessage
		if err := json.Unmarshal(scanner.Bytes(), &req); err != nil || req.ID == nil {
			continue
		}
		if role == fakeExits {
			fmt.Fprintln(os.Stderr, "Error: failed to load config.toml: unknown key `modle`")
			os.Exit(1)
		}
		if req.Method == "initialize" {
			reply(*req.ID, map[string]any{"userAgent": "fake"})
			continue
		}
		switch role {
		case fakeSilent:
			continue
		case fakeTooOld:
			fmt.Printf(`{"jsonrpc":"2.0","id":%d,"error":{"code":-32601,"message":"method not found"}}`+"\n", *req.ID)
			continue
		}

		if req.Method == "account/login/start" {
			runFakeLogin(role, *req.ID)
			if role == fakeLoginSucceeds {
				signedIn = true
			}
			continue
		}

		fmt.Println(`{"jsonrpc":"2.0","method":"account/updated","params":{"authMode":null}}`)
		reply(*req.ID+1000, map[string]any{"account": nil, "requiresOpenaiAuth": true})
		switch req.Method {
		case "account/read":
			var account any
			if signedIn {
				account = map[string]any{"type": "chatgpt", "email": "ada@example.com", "planType": "plus"}
			}
			reply(*req.ID, map[string]any{"account": account, "requiresOpenaiAuth": true})
		case "account/logout":
			signedIn = false
			reply(*req.ID, map[string]any{})
		}
	}
	os.Exit(0)
}

func fakeCodexAuth(t *testing.T, role string) *Auth {
	t.Helper()
	t.Setenv(fakeCodexRoleEnv, role)
	return &Auth{log: slog.Default(), binary: os.Args[0], workDir: t.TempDir()}
}

func TestAuth_Status(t *testing.T) {
	got, err := fakeCodexAuth(t, fakeSignedIn).Status(context.Background())
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got.State != cliauth.StateSignedIn || got.Account == nil || got.Account.Email != "ada@example.com" {
		t.Errorf("got %+v, want signed in as ada@example.com", got)
	}
}

// The read after the sign-out goes to the same app-server: the fake forgets the
// account only in the process that signed out.
func TestAuth_LogoutReadsOnTheSameAppServer(t *testing.T) {
	got, err := fakeCodexAuth(t, fakeSignedIn).Logout(context.Background())
	if err != nil {
		t.Fatalf("Logout: %v", err)
	}
	if got.State != cliauth.StateSignedOut {
		t.Errorf("got %+v, want signed out", got)
	}
}

func TestAuth_Failures(t *testing.T) {
	tests := []struct {
		name    string
		role    string
		wantMsg string
	}{
		// What the app-server said on its way out is the only account of why.
		{"app-server exits", fakeExits, "failed to load config.toml"},
		{"no account API", fakeTooOld, "update codex"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := fakeCodexAuth(t, tt.role).Status(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.wantMsg) {
				t.Errorf("got %v, want an error containing %q", err, tt.wantMsg)
			}
		})
	}
}

// An app-server that stops answering is given up on when the caller's ctx ends,
// and taken down rather than waited for.
func TestAuth_SilentAppServerIsAbandoned(t *testing.T) {
	a := fakeCodexAuth(t, fakeSilent)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	start := time.Now()
	_, err := a.Status(ctx)
	if !errors.Is(err, context.DeadlineExceeded) && (err == nil || !strings.Contains(err.Error(), "did not finish")) {
		t.Errorf("got %v, want the deadline", err)
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("Status took %s after a 1s deadline, so the app-server was waited out", elapsed)
	}
}
