package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/commitdraft"
	"github.com/pockode/server/git"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// oneShotMockAgent is the claude agent of a test that drafts commit messages.
type oneShotMockAgent struct {
	*mockAgent
	run func(ctx context.Context, req agent.OneShotRequest) (string, error)
}

func (a oneShotMockAgent) RunOneShot(ctx context.Context, req agent.OneShotRequest) (string, error) {
	return a.run(ctx, req)
}

func newDraftTestEnv(t *testing.T, run func(ctx context.Context, req agent.OneShotRequest) (string, error)) (*testEnv, string) {
	t.Helper()
	dir := setupGitRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "div.go"), []byte("package calc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	runGitIn(t, dir, "add", "div.go")
	mock := &mockAgent{}
	return newTestEnvWithAgent(t, mock, oneShotMockAgent{mockAgent: mock, run: run}, dir), dir
}

func draftFailureReason(t *testing.T, resp rpcResponse) string {
	t.Helper()
	if resp.Error == nil {
		t.Fatalf("got result %s, want an error", resp.Result)
	}
	if resp.Error.Code != rpc.CodeCommitDraftFailed || resp.Error.Data == nil {
		t.Fatalf("error = %d %q, want CodeCommitDraftFailed with data", resp.Error.Code, resp.Error.Message)
	}
	var data rpc.CommitDraftFailedData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("failed to unmarshal error data: %v", err)
	}
	return data.Reason
}

func TestHandler_GitCommitDraft(t *testing.T) {
	env, dir := newDraftTestEnv(t, func(_ context.Context, req agent.OneShotRequest) (string, error) {
		return "Add div\n", nil
	})

	resp := env.call("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude})
	if resp.Error != nil {
		t.Fatalf("error: %s", resp.Error.Message)
	}
	var result rpc.GitCommitDraftResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatal(err)
	}
	if result.Message != "Add div" {
		t.Errorf("message = %q", result.Message)
	}
	// A draft is only text: nothing is committed.
	if count := gitOutputIn(t, dir, "rev-list", "--all", "--count"); count != "0" {
		t.Errorf("%s commits after drafting, want none", count)
	}
}

func TestHandler_GitCommitDraft_UnknownAgent(t *testing.T) {
	env, _ := newDraftTestEnv(t, nil)

	// Codex is not registered in this server.
	resp := env.call("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeCodex})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want invalid params", resp.Error)
	}
}

// The engine is checked as a session's would be, so a model the agent does
// not offer is refused before any CLI runs.
func TestHandler_GitCommitDraft_InvalidEngine(t *testing.T) {
	env, _ := newDraftTestEnv(t, func(context.Context, agent.OneShotRequest) (string, error) {
		t.Error("the CLI was asked with an invalid engine")
		return "", nil
	})

	resp := env.call("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude, Model: "gpt-5"})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want invalid params", resp.Error)
	}
}

// The sheet never offers amend without a commit, so asking is a client error,
// not a failed draft and not the server's.
func TestHandler_GitCommitDraft_AmendWithoutCommit(t *testing.T) {
	env, _ := newDraftTestEnv(t, nil)

	resp := env.call("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude, Amend: true})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("got %+v, want invalid params", resp.Error)
	}
}

func TestHandler_GitCommitDraft_NothingStaged(t *testing.T) {
	env, dir := newDraftTestEnv(t, func(context.Context, agent.OneShotRequest) (string, error) {
		t.Error("the CLI was asked about an empty change")
		return "", nil
	})
	runGitIn(t, dir, "reset", "-q")

	resp := env.call("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude})
	if reason := draftFailureReason(t, resp); reason != rpc.CommitDraftNothingStaged {
		t.Errorf("reason = %q", reason)
	}
}

// Cancelling has to reach the CLI: the draft's context is what kills it, so
// the runner seeing its context end is the CLI being stopped.
func TestHandler_GitCommitDraftCancel(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	env, _ := newDraftTestEnv(t, func(ctx context.Context, _ agent.OneShotRequest) (string, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return "", ctx.Err()
	})

	draftID := env.send("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude})
	<-started

	if resp := env.call("git.commit.draft.cancel", rpc.GitCommitDraftCancelParams{DraftID: "d1"}); resp.Error != nil {
		t.Fatalf("cancel: %s", resp.Error.Message)
	}
	<-stopped
	if reason := draftFailureReason(t, env.awaitResponse(draftID)); reason != rpc.CommitDraftCancelled {
		t.Errorf("reason = %q", reason)
	}
}

// Requests are handled concurrently, so a cancel sent right behind its draft
// can be handled first. It must still stop the draft — and cancelling an id
// that is not running is not an error either way.
func TestCommitDrafts_CancelBeforeStart(t *testing.T) {
	var drafts commitDrafts
	drafts.cancel("d1")

	ctx, ok := drafts.start(context.Background(), "d1")
	if !ok {
		t.Fatal("start refused")
	}
	if ctx.Err() == nil {
		t.Error("a draft cancelled before it was registered runs anyway")
	}
	drafts.finish("d1")

	// Another id is untouched by it.
	ctx, ok = drafts.start(context.Background(), "d2")
	if !ok || ctx.Err() != nil {
		t.Errorf("a fresh id: ok=%v err=%v", ok, ctx.Err())
	}
	if _, ok := drafts.start(context.Background(), "d2"); ok {
		t.Error("a second draft under a running id was accepted")
	}
}

func TestHandler_GitCommitDraft_StoppedByDisconnect(t *testing.T) {
	started := make(chan struct{})
	stopped := make(chan struct{})
	env, _ := newDraftTestEnv(t, func(ctx context.Context, _ agent.OneShotRequest) (string, error) {
		close(started)
		<-ctx.Done()
		close(stopped)
		return "", ctx.Err()
	})

	env.send("git.commit.draft", rpc.GitCommitDraftParams{DraftID: "d1", AgentType: session.AgentTypeClaude})
	<-started
	if err := env.conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatalf("close: %v", err)
	}

	ctx, cancel := env.opCtx()
	defer cancel()
	select {
	case <-stopped:
	case <-ctx.Done():
		t.Fatal("the CLI outlived the connection")
	}
}

// send writes a request without waiting for its reply, for a test that has to
// do something while the request is running.
func (e *testEnv) send(method string, params any) int {
	e.t.Helper()
	reqID := e.nextID()
	data, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: reqID, Method: method, Params: params})
	ctx, cancel := e.opCtx()
	defer cancel()
	if err := e.conn.Write(ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}
	return reqID
}

// awaitResponse returns the reply to a request sent with send, which a later
// call may already have read past and buffered.
func (e *testEnv) awaitResponse(reqID int) rpcResponse {
	e.t.Helper()
	for {
		var resp rpcResponse
		if err := json.Unmarshal(e.readFrame(), &resp); err != nil {
			e.t.Fatalf("failed to unmarshal response: %v", err)
		}
		if resp.ID == reqID {
			return resp
		}
	}
}

func TestCommitDraftReason(t *testing.T) {
	tests := []struct {
		err  error
		want string
	}{
		{git.ErrNothingStaged, rpc.CommitDraftNothingStaged},
		{fmt.Errorf("start: %w", &agent.BinaryNotFoundError{Name: "claude"}), rpc.CommitDraftCLINotFound},
		{&agent.OneShotAuthError{Agent: session.AgentTypeCodex}, rpc.CommitDraftAuthFailed},
		{context.DeadlineExceeded, rpc.CommitDraftTimeout},
		{context.Canceled, rpc.CommitDraftCancelled},
		{agent.ErrOneShotToolUse, rpc.CommitDraftToolUse},
		{commitdraft.ErrEmptyAnswer, rpc.CommitDraftEmpty},
		{&agent.OneShotFailedError{Message: "overloaded"}, rpc.CommitDraftFailed},
	}
	for _, tt := range tests {
		if got, ok := commitDraftReason(tt.err); !ok || got != tt.want {
			t.Errorf("commitDraftReason(%v) = %q, %v; want %q", tt.err, got, ok, tt.want)
		}
	}
	// A git command that failed is the server's problem, with no copy of its own.
	if _, ok := commitDraftReason(errors.New("git diff failed")); ok {
		t.Error("an unexpected error was given a reason")
	}
}
