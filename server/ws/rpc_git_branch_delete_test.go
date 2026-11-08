package ws

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// The delete carries back the tip the inspect read, and a branch that moved
// in between is refused with a code of its own: the client has to tell the
// user to look again, not show a git failure.
func TestHandler_GitBranchDelete(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")
	runGitIn(t, dir, "branch", "moved")
	runGitIn(t, dir, "branch", "spike")
	env := newWorkDirTestEnv(t, dir)

	inspect := func(name string) git.BranchInspection {
		t.Helper()
		resp := env.call("git.branch.inspect", rpc.GitBranchInspectParams{Name: name})
		if resp.Error != nil {
			t.Fatalf("git.branch.inspect error: %s", resp.Error.Message)
		}
		var result git.BranchInspection
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			t.Fatalf("failed to unmarshal inspection: %v", err)
		}
		return result
	}

	stale := inspect("moved").Tip
	runGitIn(t, dir, "commit", "--allow-empty", "-m", "later")
	runGitIn(t, dir, "branch", "-f", "moved", "HEAD")
	resp := env.call("git.branch.delete", rpc.GitBranchDeleteParams{Name: "moved", Tip: stale})
	if resp.Error == nil || resp.Error.Code != rpc.CodeGitBranchChanged {
		t.Fatalf("delete of a moved branch = %+v, want CodeGitBranchChanged", resp.Error)
	}
	if data := branchChangedData(t, resp.Error); data.Gone {
		t.Error("a moved branch reported as gone")
	}

	resp = env.call("git.branch.inspect", rpc.GitBranchInspectParams{Name: "never"})
	if resp.Error == nil || resp.Error.Code != rpc.CodeGitBranchChanged {
		t.Fatalf("inspect of a missing branch = %+v, want CodeGitBranchChanged", resp.Error)
	}
	if data := branchChangedData(t, resp.Error); !data.Gone {
		t.Error("a missing branch not reported as gone")
	}

	resp = env.call("git.branch.delete", rpc.GitBranchDeleteParams{Name: "spike", Tip: inspect("spike").Tip})
	if resp.Error != nil {
		t.Fatalf("git.branch.delete error: %s", resp.Error.Message)
	}
	exists := exec.Command("git", "rev-parse", "--verify", "--quiet", "refs/heads/spike")
	exists.Dir = dir
	if err := exists.Run(); err == nil {
		t.Error("spike still exists")
	}
}

// The server, not only the UI, refuses the current branch — as a refusal
// naming where it is checked out, not as a git failure.
func TestHandler_GitBranchDelete_CheckedOut(t *testing.T) {
	dir := setupGitRepo(t)
	runGitIn(t, dir, "commit", "--allow-empty", "-m", "initial")
	env := newWorkDirTestEnv(t, dir)
	current := gitOutputIn(t, dir, "symbolic-ref", "--short", "HEAD")
	tip := gitOutputIn(t, dir, "rev-parse", "HEAD")

	resp := env.call("git.branch.delete", rpc.GitBranchDeleteParams{Name: current, Tip: tip})

	if resp.Error == nil || resp.Error.Code != rpc.CodeGitBranchCheckedOut {
		t.Fatalf("delete of the current branch = %+v, want CodeGitBranchCheckedOut", resp.Error)
	}
	var data rpc.GitBranchCheckedOutData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	if data.Worktree != "" {
		t.Errorf("data.worktree = %q, want empty for the current branch", data.Worktree)
	}
}

func branchChangedData(t *testing.T, e *jsonrpc2.Error) rpc.GitBranchChangedData {
	t.Helper()
	if e.Data == nil {
		t.Fatal("branch-changed error carries no data")
	}
	var data rpc.GitBranchChangedData
	if err := json.Unmarshal(*e.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	return data
}
