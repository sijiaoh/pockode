package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/git"
	"github.com/pockode/server/internal/githooktest"
	"github.com/pockode/server/rpc"
)

// A worktree already running a git operation answers the next one with a code
// of its own. This is the contract the panel renders from: the frontend has to
// tell "your request never ran, wait for X" apart from "git failed", and it
// must not have to pattern-match an English sentence to do it.
func TestHandler_GitAdd_WorktreeBusy(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	runGitIn(t, dir, "add", "test.txt")

	// The commit is started directly rather than over the connection: the lock
	// belongs to the worktree, not to a connection, and driving both requests
	// through one websocket would only test the test harness.
	hook := githooktest.Block(t, dir)
	commit := make(chan error, 1)
	go func() { commit <- git.CreateCommit(dir, "Blocked on its hook", false) }()
	hook.WaitStarted(t)
	defer func() {
		hook.Release(t)
		if err := <-commit; err != nil {
			t.Errorf("the blocked commit failed: %v", err)
		}
	}()

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.add", rpc.GitPathsParams{Paths: []string{"test.txt"}})

	if resp.Error == nil {
		t.Fatal("git.add during a commit succeeded, so nothing was serialised")
	}
	if resp.Error.Code != rpc.CodeGitBusy {
		t.Fatalf("error code = %d (%s), want CodeGitBusy", resp.Error.Code, resp.Error.Message)
	}
	if resp.Error.Data == nil {
		t.Fatal("busy error carries no data")
	}
	var data rpc.GitBusyData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	if data.Operation != "commit" {
		t.Errorf("data.operation = %q, want %q", data.Operation, "commit")
	}
}
