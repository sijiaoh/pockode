package ws

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
)

// The wire contract of git.log: a cursor from one page fetches the next, and
// a request the client got wrong is invalid params rather than a git failure.
func TestHandler_GitLog(t *testing.T) {
	dir := setupGitRepo(t)
	for _, message := range []string{"first", "second"} {
		runGitIn(t, dir, "commit", "--allow-empty", "-m", message)
	}
	env := newWorkDirTestEnv(t, dir)

	page := func(params rpc.GitLogParams) git.HistoryPage {
		t.Helper()
		resp := env.call("git.log", params)
		if resp.Error != nil {
			t.Fatalf("git.log error: %s", resp.Error.Message)
		}
		var result git.HistoryPage
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			t.Fatalf("failed to unmarshal page: %v", err)
		}
		return result
	}

	first := page(rpc.GitLogParams{Limit: 1})
	if len(first.Commits) != 1 || first.Commits[0].Subject != "second" || first.Next == nil {
		t.Fatalf("first page = %+v, want \"second\" and a next cursor", first)
	}
	second := page(rpc.GitLogParams{Limit: 1, Cursor: first.Next})
	if len(second.Commits) != 1 || second.Commits[0].Subject != "first" || second.Next != nil {
		t.Fatalf("second page = %+v, want \"first\" and no next cursor", second)
	}

	for name, params := range map[string]rpc.GitLogParams{
		"unknown scope":  {Scope: "everything"},
		"escaping path":  {Path: "../outside"},
		"malformed tips": {Cursor: &git.HistoryCursor{Tips: []string{"HEAD"}}},
	} {
		if resp := env.call("git.log", params); resp.Error == nil || resp.Error.Code != -32602 {
			t.Errorf("git.log with %s = %+v, want invalid params", name, resp.Error)
		}
	}
	if resp := env.call("git.branch.create", rpc.GitBranchCreateParams{Name: "x", Start: "--orphan"}); resp.Error == nil || resp.Error.Code != -32602 {
		t.Errorf("git.branch.create from an option = %+v, want invalid params", resp.Error)
	}
}
