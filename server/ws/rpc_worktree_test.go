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
		Type:        work.WorkTypeStory,
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

	// Drive the work to closed: open → in_progress → closed (no steps).
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
