package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// createWorktreeWork creates a work item pinned to the given worktree.
func createWorktreeWork(t *testing.T, env *testEnv, worktree, title string) work.Work {
	t.Helper()
	w, err := env.workStore.Create(bgCtx, work.Work{
		Title:       title,
		AgentRoleID: env.testRoleID,
	})
	if err != nil {
		t.Fatalf("create work: %v", err)
	}
	if err := env.workStore.SetWorktree(bgCtx, w.ID, worktree); err != nil {
		t.Fatalf("set worktree: %v", err)
	}
	got, _, _ := env.workStore.Get(w.ID)
	return got
}

func TestHandler_WorktreeDelete_BlockedByOpenWork(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	if resp := env.call("worktree.create", rpc.WorktreeCreateParams{Name: "feature", Branch: "feature-branch"}); resp.Error != nil {
		t.Fatalf("create failed: %s", resp.Error.Message)
	}

	w := createWorktreeWork(t, env, "feature", "Unfinished work")

	resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"})
	if resp.Error == nil {
		t.Fatal("expected delete to be rejected while work is not closed")
	}
	// The error must be locatable: naming the count and the blocking work.
	if !strings.Contains(resp.Error.Message, "not closed") ||
		!strings.Contains(resp.Error.Message, w.ID) ||
		!strings.Contains(resp.Error.Message, "Unfinished work") {
		t.Errorf("error should identify the blocking work, got %q", resp.Error.Message)
	}

	// Worktree must still exist since deletion was refused.
	listResp := env.call("worktree.list", nil)
	var listResult rpc.WorktreeListResult
	if err := json.Unmarshal(listResp.Result, &listResult); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if !worktreeInList(listResult, "feature") {
		t.Error("worktree should remain after refused deletion")
	}
}

func TestHandler_WorktreeDelete_AllowedWhenWorkClosed(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	if resp := env.call("worktree.create", rpc.WorktreeCreateParams{Name: "feature", Branch: "feature-branch"}); resp.Error != nil {
		t.Fatalf("create failed: %s", resp.Error.Message)
	}

	w := createWorktreeWork(t, env, "feature", "Finished work")

	// Drive the work to closed: open → active → closed (no steps).
	if _, err := env.workStore.Start(bgCtx, w.ID, "sess-1"); err != nil {
		t.Fatalf("start work: %v", err)
	}
	if _, err := env.workStore.StepDone(bgCtx, w.ID, 0); err != nil {
		t.Fatalf("step done: %v", err)
	}

	resp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"})
	if resp.Error != nil {
		t.Fatalf("delete should succeed once all work is closed, got %q", resp.Error.Message)
	}

	listResp := env.call("worktree.list", nil)
	var listResult rpc.WorktreeListResult
	if err := json.Unmarshal(listResp.Result, &listResult); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if worktreeInList(listResult, "feature") {
		t.Error("worktree should be gone after successful deletion")
	}
}

func worktreeInList(list rpc.WorktreeListResult, name string) bool {
	for _, wt := range list.Worktrees {
		if wt.Name == name {
			return true
		}
	}
	return false
}

// A project without a repository is told so by every entry point the client
// reads it from, and a git request there is refused with a code of its own
// rather than whatever git printed. Once `git init` runs, the next read says so
// straight away — not after the registry's cache happens to expire — and the
// subscriber that was already open is told as well.
func TestHandler_Worktree_GitRepoState(t *testing.T) {
	dir := t.TempDir()
	env := newWorkDirTestEnv(t, dir)

	var list rpc.WorktreeListResult
	resp := env.call("worktree.list", nil)
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if list.IsGitRepo || len(list.Worktrees) != 1 || !list.Worktrees[0].IsMain {
		t.Fatalf("non-git project listed as %+v, want is_git_repo=false and main alone", list)
	}

	var sub rpc.WorktreeSubscribeResult
	resp = env.call("worktree.subscribe", rpc.SubscribeParams{ID: "before-init"})
	if err := json.Unmarshal(resp.Result, &sub); err != nil {
		t.Fatalf("subscribe unmarshal: %v", err)
	}
	if sub.IsGitRepo {
		t.Fatal("worktree.subscribe reported is_git_repo=true for a non-git project")
	}

	for _, call := range []struct {
		method string
		params any
	}{
		{"git.status", nil},
		{"git.log", nil},
		{"worktree.create", rpc.WorktreeCreateParams{Name: "feature", Branch: "feature"}},
	} {
		resp := env.call(call.method, call.params)
		if resp.Error == nil || resp.Error.Code != rpc.CodeNotGitRepo {
			t.Errorf("%s: got %+v, want error code %d", call.method, resp.Error, rpc.CodeNotGitRepo)
		}
	}
	// Subscribing runs no git, and is how a panel left open hears about the
	// repository once it exists.
	if resp := env.call("git.subscribe", rpc.SubscribeParams{ID: "git-panel"}); resp.Error != nil {
		t.Errorf("git.subscribe refused in a non-git project: %s", resp.Error.Message)
	}

	runGitIn(t, dir, "init")

	resp = env.call("worktree.subscribe", rpc.SubscribeParams{ID: "after-init"})
	if err := json.Unmarshal(resp.Result, &sub); err != nil {
		t.Fatalf("subscribe unmarshal: %v", err)
	}
	if !sub.IsGitRepo {
		t.Error("worktree.subscribe still reports is_git_repo=false after git init")
	}

	notified := map[string]bool{}
	for range 2 {
		n := env.readNotification()
		if n.Method != "worktree.changed" {
			t.Fatalf("got %s, want worktree.changed", n.Method)
		}
		var params struct {
			ID        string `json:"id"`
			IsGitRepo bool   `json:"is_git_repo"`
		}
		if err := json.Unmarshal(n.Params, &params); err != nil {
			t.Fatalf("notification unmarshal: %v", err)
		}
		notified[params.ID] = params.IsGitRepo
	}
	if !notified["before-init"] || !notified["after-init"] {
		t.Errorf("worktree.changed after git init = %v, want is_git_repo=true for both subscribers", notified)
	}

	resp = env.call("worktree.list", nil)
	if err := json.Unmarshal(resp.Result, &list); err != nil {
		t.Fatalf("list unmarshal: %v", err)
	}
	if !list.IsGitRepo {
		t.Error("worktree.list still reports is_git_repo=false after the change was announced")
	}
	if resp := env.call("git.status", nil); resp.Error != nil {
		t.Errorf("git.status after git init: %s", resp.Error.Message)
	}
}
