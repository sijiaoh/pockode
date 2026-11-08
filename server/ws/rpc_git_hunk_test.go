package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
)

// The wire contract of hunk staging: the IDs come with the diff, and a hunk
// the file no longer has is refused with a code of its own, so the client
// knows to reread the diff rather than show a git failure.
func TestHandler_GitHunk(t *testing.T) {
	dir := setupGitRepo(t)
	file := filepath.Join(dir, "test.txt")
	os.WriteFile(file, []byte("a\n"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")
	os.WriteFile(file, []byte("b\n"), 0644)

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{ID: "client-1", Path: "test.txt"})
	if resp.Error != nil {
		t.Fatalf("git.diff.subscribe error: %s", resp.Error.Message)
	}
	var diff git.DiffResult
	if err := json.Unmarshal(resp.Result, &diff); err != nil {
		t.Fatalf("failed to unmarshal diff: %v", err)
	}
	if len(diff.HunkIDs) != 1 {
		t.Fatalf("hunk_ids = %v, want one", diff.HunkIDs)
	}
	id := diff.HunkIDs[0]

	os.WriteFile(file, []byte("c\n"), 0644)
	resp = env.call("git.hunk.stage", rpc.GitHunkParams{Path: "test.txt", HunkID: id})
	if resp.Error == nil || resp.Error.Code != rpc.CodeGitHunkStale {
		t.Fatalf("git.hunk.stage of a stale hunk = %+v, want CodeGitHunkStale", resp.Error)
	}

	os.WriteFile(file, []byte("b\n"), 0644)
	if resp := env.call("git.hunk.stage", rpc.GitHunkParams{Path: "test.txt", HunkID: id}); resp.Error != nil {
		t.Fatalf("git.hunk.stage error: %s", resp.Error.Message)
	}
	if resp := env.call("git.hunk.unstage", rpc.GitHunkParams{Path: "test.txt", HunkID: id}); resp.Error == nil || resp.Error.Code != rpc.CodeGitHunkStale {
		t.Fatalf("git.hunk.unstage with the unstaged side's ID = %+v, want CodeGitHunkStale", resp.Error)
	}

	resp = env.call("git.hunk.stage", rpc.GitHunkParams{Path: "../outside", HunkID: id})
	if resp.Error == nil || resp.Error.Code != -32602 {
		t.Errorf("git.hunk.stage outside the repository = %+v, want invalid params", resp.Error)
	}
}
