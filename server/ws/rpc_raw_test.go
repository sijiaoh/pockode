package ws

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/authsession"
	"github.com/pockode/server/filetransfer"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// rawCapabilitiesStub records what the RPC asks to be issued. Whether a grant
// is well-formed, and what a capability then serves, is filetransfer's to
// decide and test; what is under test here is what the RPC makes of its params
// and the connection.
type rawCapabilitiesStub struct {
	issuedMu sync.Mutex
	err      error
	issued   []rawIssue
}

type rawIssue struct {
	sessionToken string
	grant        filetransfer.RawGrant
}

var rawStubExpiry = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

func (s *rawCapabilitiesStub) Issue(sessionToken string, grant filetransfer.RawGrant) (string, time.Time, error) {
	s.issuedMu.Lock()
	defer s.issuedMu.Unlock()
	if s.err != nil {
		return "", time.Time{}, s.err
	}
	s.issued = append(s.issued, rawIssue{sessionToken, grant})
	return "cap", rawStubExpiry, nil
}

func (s *rawCapabilitiesStub) fail(err error) {
	s.issuedMu.Lock()
	defer s.issuedMu.Unlock()
	s.err = err
}

func (s *rawCapabilitiesStub) last(t *testing.T) rawIssue {
	t.Helper()
	s.issuedMu.Lock()
	defer s.issuedMu.Unlock()
	if len(s.issued) == 0 {
		t.Fatal("nothing was issued")
	}
	return s.issued[len(s.issued)-1]
}

// commitRawTestFile commits a file at rel and returns the commit's full hash.
func commitRawTestFile(t *testing.T, dir, rel string) string {
	t.Helper()
	full := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte("content"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "add "+rel)
	return gitOutputIn(t, dir, "rev-parse", "HEAD")
}

func gitOutputIn(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v failed: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func (e *testEnv) rawCapability(params rpc.RawCapabilityParams) rpc.RawCapabilityResult {
	e.t.Helper()
	resp := e.call("raw.capability", params)
	if resp.Error != nil {
		e.t.Fatalf("raw.capability(%+v) failed: %s", params, resp.Error.Message)
	}
	var result rpc.RawCapabilityResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("unmarshal: %v", err)
	}
	return result
}

func TestHandler_RawCapability_RequiresAuth(t *testing.T) {
	server := newAuthTestServer(t, testPassword, "", authsessiontest.New())

	resp := callOnce(t, server.URL, "raw.capability", rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.mp4"})
	if resp.Error == nil {
		t.Fatalf("raw.capability succeeded before auth: %s", resp.Result)
	}
}

// The capability is bound to the session this connection logged in as, which
// is the token the client was handed at auth and keeps.
func TestHandler_RawCapability_BoundToTheConnectionsSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	env.rawCapability(rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.mp4"})

	if got, want := env.raw.last(t).sessionToken, env.authResult.SessionToken; got != want || want == "" {
		t.Errorf("issued for session %q, want the connection's %q", got, want)
	}
}

func TestHandler_RawCapability_Grants(t *testing.T) {
	dir := setupGitRepo(t)
	full := commitRawTestFile(t, dir, "site/index.html")
	env := newWorkDirTestEnv(t, dir)

	tests := []struct {
		name     string
		params   rpc.RawCapabilityParams
		want     filetransfer.RawGrant
		wantPath string
	}{
		{
			name:     "work-directory file is read under its own name",
			params:   rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "media/my clip.mp4"},
			want:     filetransfer.RawGrant{Origin: filetransfer.RawOriginFile, Scope: filetransfer.RawScopeFile, Path: "media/my clip.mp4"},
			wantPath: "/api/raw/cap/my%20clip.mp4",
		},
		{
			name:     "directory is given with a trailing slash",
			params:   rpc.RawCapabilityParams{Origin: "file", Scope: "directory", Path: "site"},
			want:     filetransfer.RawGrant{Origin: filetransfer.RawOriginFile, Scope: filetransfer.RawScopeDirectory, Path: "site"},
			wantPath: "/api/raw/cap/",
		},
		{
			// An abbreviation is resolved now: it may stop being unique while
			// the capability lives.
			name:     "commit hash is resolved to the full one",
			params:   rpc.RawCapabilityParams{Origin: "commit", Scope: "directory", Hash: full[:7], Path: "site"},
			want:     filetransfer.RawGrant{Origin: filetransfer.RawOriginCommit, Scope: filetransfer.RawScopeDirectory, Hash: full, Path: "site"},
			wantPath: "/api/raw/cap/",
		},
		{
			// The attachment's own worktree, not the connection's.
			name:     "attachment",
			params:   rpc.RawCapabilityParams{Origin: "attachment", Scope: "file", SessionID: "s1", ID: "abc.png", Worktree: "feature-x"},
			want:     filetransfer.RawGrant{Origin: filetransfer.RawOriginAttachment, Scope: filetransfer.RawScopeFile, Worktree: "feature-x", SessionID: "s1", Path: "abc.png"},
			wantPath: "/api/raw/cap/abc.png",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := env.rawCapability(tt.params)
			if got := env.raw.last(t).grant; got != tt.want {
				t.Errorf("grant = %+v, want %+v", got, tt.want)
			}
			if result.Path != tt.wantPath {
				t.Errorf("path = %q, want %q", result.Path, tt.wantPath)
			}
			if result.Worktree != tt.want.Worktree {
				t.Errorf("worktree = %q, want %q", result.Worktree, tt.want.Worktree)
			}
			if !result.ExpiresAt.Equal(rawStubExpiry) {
				t.Errorf("expires_at = %v, want %v", result.ExpiresAt, rawStubExpiry)
			}
		})
	}
}

func TestHandler_RawCapability_RefusesParams(t *testing.T) {
	dir := setupGitRepo(t)
	commitRawTestFile(t, dir, "a.txt")
	tree := gitOutputIn(t, dir, "rev-parse", "HEAD^{tree}")
	env := newWorkDirTestEnv(t, dir)

	for _, tt := range []struct {
		name   string
		params rpc.RawCapabilityParams
	}{
		{"unknown origin", rpc.RawCapabilityParams{Origin: "url", Scope: "file", Path: "a.txt"}},
		{"worktree with a file origin", rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.txt", Worktree: "other"}},
		{"hash with a file origin", rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.txt", Hash: "abcdef0"}},
		{"attachment in a worktree that cannot exist", rpc.RawCapabilityParams{Origin: "attachment", Scope: "file", SessionID: "s", ID: "x", Worktree: "../x"}},
		{"path with an attachment origin", rpc.RawCapabilityParams{Origin: "attachment", Scope: "file", SessionID: "s", ID: "x", Path: "a.txt"}},
		{"malformed hash", rpc.RawCapabilityParams{Origin: "commit", Scope: "file", Hash: "HEAD", Path: "a.txt"}},
		{"unknown commit", rpc.RawCapabilityParams{Origin: "commit", Scope: "file", Hash: "0123456789abcdef0123456789abcdef01234567", Path: "a.txt"}},
		{"hash of a tree", rpc.RawCapabilityParams{Origin: "commit", Scope: "file", Hash: tree, Path: "a.txt"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call("raw.capability", tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
				t.Errorf("raw.capability(%+v) = %+v, want invalid params", tt.params, resp.Error)
			}
		})
	}
}

// What the grant itself is refused for — a directory at the root, say — is
// the client's mistake, and says what was wrong rather than reading as a fault.
func TestHandler_RawCapability_InvalidGrantIsInvalidParams(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.raw.fail(errors.Join(filetransfer.ErrInvalidGrant, errors.New("path \"\" must name something beneath the root")))

	resp := env.call("raw.capability", rpc.RawCapabilityParams{Origin: "file", Scope: "directory", Path: ""})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("error = %+v, want invalid params", resp.Error)
	}
	if !strings.Contains(resp.Error.Message, "beneath the root") {
		t.Errorf("message %q dropped the reason", resp.Error.Message)
	}
}

// A connection can outlive its session; the client is told the way auth tells
// it, so it knows to log in again rather than retry.
func TestHandler_RawCapability_EndedSessionSaysSessionExpired(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.raw.fail(authsession.ErrSessionNotLive)

	resp := env.call("raw.capability", rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.mp4"})
	if resp.Error == nil {
		t.Fatal("raw.capability succeeded for an ended session")
	}
	var data rpc.AuthErrorData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("unmarshal error data %s: %v", *resp.Error.Data, err)
	}
	if data.Reason != rpc.AuthReasonSessionExpired {
		t.Errorf("reason = %q, want %q", data.Reason, rpc.AuthReasonSessionExpired)
	}
}

func TestHandler_RawCapability_CommitNeedsGitRepo(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("raw.capability", rpc.RawCapabilityParams{Origin: "commit", Scope: "file", Hash: "abcdef0", Path: "a.txt"})
	if resp.Error == nil || resp.Error.Code != rpc.CodeNotGitRepo {
		t.Errorf("error = %+v, want CodeNotGitRepo", resp.Error)
	}
}

// The worktree a file capability reads from is the connection's, and the reply
// names it: a client that has just asked to switch cannot otherwise tell
// whether the request was answered before the switch or after.
func TestHandler_RawCapability_NamesTheBoundWorktree(t *testing.T) {
	dir := setupGitRepo(t)
	commitRawTestFile(t, dir, "a.txt")
	env := newWorkDirTestEnv(t, dir)
	createWorktree(t, env, "feature")
	if resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "feature"}); resp.Error != nil {
		t.Fatalf("worktree switch failed: %s", resp.Error.Message)
	}

	result := env.rawCapability(rpc.RawCapabilityParams{Origin: "file", Scope: "file", Path: "a.txt"})

	if result.Worktree != "feature" {
		t.Errorf("worktree = %q, want feature", result.Worktree)
	}
}
