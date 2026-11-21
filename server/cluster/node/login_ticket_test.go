package node

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/pockode/server/localapi"
	"github.com/pockode/server/serverinfo"
)

const testLocalToken = "local-token"

// runningNodeAt is a node whose server.json says it is running — the process
// is this test's — and serves its local API at handler.
func runningNodeAt(t *testing.T, token string, handler http.Handler) Node {
	t.Helper()
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	n := Node{ID: "test-id", Path: t.TempDir()}
	writeServerJSON(t, n.Path, serverinfo.Info{
		PID:       os.Getpid(),
		Port:      9870,
		StartedAt: "2025-06-14T10:00:00Z",
		LocalURL:  srv.URL,
		Token:     token,
		Version:   "1.0.0",
	})
	return n
}

func TestLoginTicket_Failures(t *testing.T) {
	answering := func(status int, body string) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			w.Write([]byte(body))
		})
	}

	tests := []struct {
		name    string
		token   string
		handler http.Handler
		wantErr error  // a sentinel, or nil for a reported failure
		wantMsg string // a fragment of a reported failure
	}{
		{
			name:  "no token in server.json",
			token: "",
			handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				t.Error("a node without a token was called")
			}),
			wantErr: ErrLoginTicketUnsupported,
		},
		{
			name:    "401: an older node's password middleware",
			token:   testLocalToken,
			handler: answering(http.StatusUnauthorized, "Unauthorized"),
			wantErr: ErrLoginTicketUnsupported,
		},
		{
			name:    "404: an older node with no such route",
			token:   testLocalToken,
			handler: answering(http.StatusNotFound, "404 page not found"),
			wantErr: ErrLoginTicketUnsupported,
		},
		{
			name:    "500 is reported with the node's words",
			token:   testLocalToken,
			handler: answering(http.StatusInternalServerError, "failed to issue login ticket\n"),
			wantMsg: "the node answered 500 Internal Server Error: failed to issue login ticket",
		},
		{
			name:  "a redirect is not followed",
			token: testLocalToken,
			handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != localapi.LoginTicketPath {
					t.Errorf("redirect followed to %s, carrying the token", r.URL.Path)
				}
				http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
			}),
			wantMsg: "the node answered 307",
		},
		{
			name:    "a reply that is not a ticket",
			token:   testLocalToken,
			handler: answering(http.StatusOK, "<html>"),
			wantMsg: "not a login ticket",
		},
		{
			name:    "a reply with no ticket",
			token:   testLocalToken,
			handler: answering(http.StatusOK, `{}`),
			wantMsg: "carries no ticket",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			n := runningNodeAt(t, tc.token, tc.handler)

			_, err := NewProcessManager(os.Args[0]).LoginTicket(context.Background(), n)
			if err == nil {
				t.Fatal("LoginTicket succeeded")
			}
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Errorf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if errors.Is(err, ErrLoginTicketUnsupported) {
				t.Errorf("err = %v, want a reported failure, not unsupported", err)
			}
			if !strings.Contains(err.Error(), tc.wantMsg) {
				t.Errorf("err = %q, want it to contain %q", err, tc.wantMsg)
			}
		})
	}
}

func TestLoginTicket_SendsTheTokenInItsHeader(t *testing.T) {
	var got *http.Request
	n := runningNodeAt(t, testLocalToken, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		w.Write([]byte(`{"ticket":"t"}`))
	}))

	if _, err := NewProcessManager(os.Args[0]).LoginTicket(context.Background(), n); err != nil {
		t.Fatalf("LoginTicket: %v", err)
	}
	if got.Method != http.MethodPost || got.URL.Path != localapi.LoginTicketPath {
		t.Errorf("request = %s %s, want POST %s", got.Method, got.URL.Path, localapi.LoginTicketPath)
	}
	if v := got.Header.Get(localapi.TokenHeader); v != testLocalToken {
		t.Errorf("%s = %q, want the server.json token", localapi.TokenHeader, v)
	}
	// An older node would count a Bearer value as a password guess.
	if v := got.Header.Get("Authorization"); v != "" {
		t.Errorf("Authorization = %q, want none", v)
	}
}

func TestLoginTicket_RefusesANodeThatIsNotRunning(t *testing.T) {
	pm := NewProcessManager(os.Args[0])

	t.Run("stopped", func(t *testing.T) {
		_, err := pm.LoginTicket(context.Background(), Node{ID: "test-id", Path: t.TempDir()})
		if !errors.Is(err, ErrNodeNotRunning) {
			t.Errorf("err = %v, want ErrNodeNotRunning", err)
		}
	})

	t.Run("stale", func(t *testing.T) {
		requireDeadPID(t)
		n := Node{ID: "test-id", Path: t.TempDir()}
		writeServerJSON(t, n.Path, serverinfo.Info{PID: deadPID, Port: 9870, Token: testLocalToken})
		_, err := pm.LoginTicket(context.Background(), n)
		if !errors.Is(err, ErrNodeNotRunning) {
			t.Errorf("err = %v, want ErrNodeNotRunning", err)
		}
	})

	// The old start's server.json is still there and its process alive; a
	// ticket from it would die with it.
	t.Run("restarting", func(t *testing.T) {
		n := runningNodeAt(t, testLocalToken, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			t.Error("a restarting node was called")
		}))
		pm.restartsMu.Lock()
		pm.restarts[n.ID] = restartRecord{requestedAt: pm.now(), token: testLocalToken}
		pm.restartsMu.Unlock()

		_, err := pm.LoginTicket(context.Background(), n)
		if !errors.Is(err, ErrNodeRestarting) {
			t.Errorf("err = %v, want ErrNodeRestarting", err)
		}
	})
}
