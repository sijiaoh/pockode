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

// An abort of an operation that is not the one in progress is a refusal with
// a code of its own and the operation that is: the user confirmed losing the
// work of one particular merge, and the client has to be able to say that it
// already ended rather than show a git failure.
func TestHandler_GitAbort_OperationChanged(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.abort", rpc.GitAbortParams{Kind: "merge"})

	if resp.Error == nil {
		t.Fatal("git.abort with nothing in progress succeeded")
	}
	if resp.Error.Code != rpc.CodeGitOperationChanged {
		t.Fatalf("error code = %d (%s), want CodeGitOperationChanged", resp.Error.Code, resp.Error.Message)
	}
	if resp.Error.Data == nil {
		t.Fatal("operation-changed error carries no data")
	}
	var data rpc.GitOperationChangedData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	if data.Current != "" {
		t.Errorf("data.current = %q, want empty", data.Current)
	}
}

func TestHandler_GitAbort_Merge(t *testing.T) {
	dir := setupConflictedMerge(t)

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.abort", rpc.GitAbortParams{Kind: "merge"})

	if resp.Error != nil {
		t.Fatalf("git.abort error: %s", resp.Error.Message)
	}
	var result rpc.GitAbortResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if result.HeadKept {
		t.Error("head_kept = true for a merge, which always rolls back")
	}
	status := env.call("git.status", nil)
	var gitStatus git.GitStatus
	if err := json.Unmarshal(status.Result, &gitStatus); err != nil {
		t.Fatalf("failed to unmarshal status: %v", err)
	}
	if gitStatus.Operation != nil {
		t.Errorf("operation after abort = %+v, want none", gitStatus.Operation)
	}
}

func TestHandler_GitAbort_UnknownKind(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.abort", rpc.GitAbortParams{Kind: "bisect"})

	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("git.abort of an unknown kind = %+v, want invalid params", resp.Error)
	}
}

// setupConflictedMerge is a repository stopped on a conflict in test.txt,
// merging topic into the default branch.
func setupConflictedMerge(t *testing.T) string {
	t.Helper()
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("base\n"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "base")
	runGitIn(t, dir, "checkout", "-q", "-b", "topic")
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("topic\n"), 0644)
	runGitIn(t, dir, "commit", "-qam", "topic")
	runGitIn(t, dir, "checkout", "-q", "-")
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("main\n"), 0644)
	runGitIn(t, dir, "commit", "-qam", "main")
	merge := exec.Command("git", "merge", "topic")
	merge.Dir = dir
	if out, err := merge.CombinedOutput(); err == nil {
		t.Fatalf("merge succeeded, want a conflict\n%s", out)
	}
	return dir
}

// A write the operation would be finished or derailed by is a refusal with
// the operation named, not a git failure.
func TestHandler_GitWriteDuringOperation(t *testing.T) {
	dir := setupConflictedMerge(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.commit", rpc.GitCommitParams{Message: "stray"})

	if resp.Error == nil || resp.Error.Code != rpc.CodeGitOperationInProgress {
		t.Fatalf("error = %+v, want CodeGitOperationInProgress", resp.Error)
	}
	var data rpc.GitOperationInProgressData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	if data.Kind != git.OperationMerge {
		t.Errorf("data.kind = %q, want merge", data.Kind)
	}
}

// A stage, unstage or discard of a conflicted path is a refusal naming the
// write and the paths; only a stage that says it resolves goes through.
func TestHandler_GitWriteConflicted(t *testing.T) {
	tests := []struct {
		method string
		params any
		action string
	}{
		{"git.add", rpc.GitAddParams{Paths: []string{"test.txt"}}, "stage"},
		{"git.reset", rpc.GitPathsParams{Paths: []string{"test.txt"}}, "unstage"},
		{"git.discard", rpc.GitPathsParams{Paths: []string{"test.txt"}}, "discard"},
	}
	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			dir := setupConflictedMerge(t)
			env := newWorkDirTestEnv(t, dir)

			resp := env.call(tt.method, tt.params)

			if resp.Error == nil || resp.Error.Code != rpc.CodeGitConflicted {
				t.Fatalf("error = %+v, want CodeGitConflicted", resp.Error)
			}
			var data rpc.GitConflictedData
			if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
				t.Fatalf("failed to unmarshal error data: %v", err)
			}
			if data.Action != tt.action || len(data.Paths) != 1 || data.Paths[0] != "test.txt" {
				t.Errorf("data = %+v, want action %q and paths [test.txt]", data, tt.action)
			}
		})
	}
}

func TestHandler_GitAddResolve(t *testing.T) {
	dir := setupConflictedMerge(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.add", rpc.GitAddParams{Paths: []string{"test.txt"}, Resolve: true})

	if resp.Error != nil {
		t.Fatalf("error = %+v, want none", resp.Error)
	}
	status, err := git.Status(dir)
	if err != nil {
		t.Fatalf("Status() error: %v", err)
	}
	if len(status.Conflicted) != 0 {
		t.Errorf("Conflicted = %v, want none after resolving", status.Conflicted)
	}
}
