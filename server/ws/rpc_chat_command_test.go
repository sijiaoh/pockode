package ws

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func newBranchTestEnv(t *testing.T, mock *mockAgent, branch string) *testEnv {
	t.Helper()
	dir := setupGitRepo(t)
	runGitIn(t, dir, "symbolic-ref", "HEAD", "refs/heads/"+branch)
	return newTestEnvWithWorkDir(t, mock, dir)
}

func messageRecords(t *testing.T, env *testEnv, sessionID string) []agent.EventRecord {
	t.Helper()
	raws, err := env.getMainWorktree().SessionStore.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	var out []agent.EventRecord
	for _, raw := range raws {
		var rec agent.EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatalf("unmarshal record: %v", err)
		}
		if rec.Type == agent.EventTypeMessage {
			out = append(out, rec)
		}
	}
	return out
}

// The agent reads the expanded prompt, and the record keeps both halves: the
// prompt as content and the command as typed, as the user's own message.
func TestHandler_MessagePockodeCommandIsExpanded(t *testing.T) {
	mock := &mockAgent{}
	env := newBranchTestEnv(t, mock, "feature/x")
	row, _ := env.createSession()

	result := env.sendMessage(row.ID, "/pockode-lead  API first")

	want := agent.CommandInvocation{Name: "pockode-lead", Args: "API first"}
	if result.Command == nil || *result.Command != want {
		t.Errorf("reply command = %+v, want %+v", result.Command, want)
	}
	if !strings.Contains(result.Content, "merge its branch into feature/x") ||
		!strings.HasSuffix(result.Content, "Additional instructions from the user:\nAPI first") {
		t.Errorf("reply content is not the expanded prompt:\n%s", result.Content)
	}

	if sent := mock.sentMessagesFor(row.ID); len(sent) != 1 || sent[0] != result.Content {
		t.Errorf("agent was sent %q, want the expanded prompt", sent)
	}

	records := messageRecords(t, env, row.ID)
	if len(records) != 1 {
		t.Fatalf("message records = %+v, want one", records)
	}
	rec := records[0]
	if rec.Content != result.Content || rec.Command == nil || *rec.Command != want {
		t.Errorf("record = content %q, command %+v; want the reply's", rec.Content, rec.Command)
	}
	if rec.Origin != "" {
		t.Errorf("record origin = %q, want the user's", rec.Origin)
	}
	if first := env.handler.commandStore.List()[0]; first.Name != "pockode-lead" {
		t.Errorf("most recent command = %q, want the delivered pockode-lead", first.Name)
	}
}

// Use is recorded only once the agent has the message, so a slash command
// whose send failed does not rise to the top of the palette.
func TestHandler_MessageSlashCommandUnrecordedWhenSendFails(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	if _, err := env.handler.commandStore.Use("earlier"); err != nil {
		t.Fatalf("Use: %v", err)
	}

	resp := env.call("chat.message", rpc.MessageParams{SessionID: "no-such-session", Content: "/review"})
	if resp.Error == nil {
		t.Fatal("send to a missing session succeeded")
	}

	if first := env.handler.commandStore.List()[0]; first.Name != "earlier" {
		t.Errorf("most recent command = %q, want the failed one unrecorded", first.Name)
	}
}

// An ordinary message carries neither, so a client can tell the two apart by
// their presence.
func TestHandler_MessageOrdinaryHasNoCommand(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()

	result := env.sendMessage(row.ID, "/review")

	if result.Command != nil || result.Content != "" {
		t.Errorf("reply = %+v, want only a seq", result)
	}
}

func TestHandler_MessagePockodeCommandRefusals(t *testing.T) {
	tests := []struct {
		name    string
		env     func(t *testing.T, mock *mockAgent) *testEnv
		content string
		answer  bool
		want    string
	}{
		{
			name:    "unknown command lists the available ones",
			env:     func(t *testing.T, mock *mockAgent) *testEnv { return newBranchTestEnv(t, mock, "main") },
			content: "/pockode-nope",
			want:    "/pockode-lead",
		},
		{
			name: "detached HEAD",
			env: func(t *testing.T, mock *mockAgent) *testEnv {
				dir := setupGitRepo(t)
				runGitIn(t, dir, "commit", "--allow-empty", "-m", "init")
				runGitIn(t, dir, "checkout", "--detach")
				return newTestEnvWithWorkDir(t, mock, dir)
			},
			content: "/pockode-lead",
			want:    "Check out a branch",
		},
		{
			name:    "sent as an answer",
			env:     func(t *testing.T, mock *mockAgent) *testEnv { return newBranchTestEnv(t, mock, "main") },
			content: "/pockode-lead",
			answer:  true,
			want:    "together with answers",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockAgent{}
			env := tt.env(t, mock)
			row, _ := env.createSession()

			if _, err := env.handler.commandStore.Use("earlier"); err != nil {
				t.Fatalf("Use: %v", err)
			}

			params := rpc.MessageParams{SessionID: row.ID, Content: tt.content}
			if tt.answer {
				id := post(t, env, row.ID, "Database")
				params.Answering = []rpc.QuestionAnswerParams{{RequestID: id, Answers: []string{"Postgres"}}}
			}

			resp := env.call("chat.message", params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
				t.Fatalf("error = %+v, want CodeInvalidParams", resp.Error)
			}
			if !strings.Contains(resp.Error.Message, tt.want) {
				t.Errorf("error = %q, want it to mention %q", resp.Error.Message, tt.want)
			}

			if sent := mock.sentMessagesFor(row.ID); len(sent) != 0 {
				t.Errorf("agent was sent %q, want nothing", sent)
			}
			if records := messageRecords(t, env, row.ID); len(records) != 0 {
				t.Errorf("message records = %+v, want none", records)
			}
			// Recorded usage would put the refused command ahead of this one.
			if first := env.handler.commandStore.List()[0]; first.Name != "earlier" {
				t.Errorf("most recent command = %q, want the refused one unrecorded", first.Name)
			}
			if tt.answer && len(unanswered(t, env, row.ID)) != 1 {
				t.Error("the question was resolved by a refused message")
			}
		})
	}
}
