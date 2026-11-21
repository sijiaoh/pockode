package ws

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
)

// Every way a person could send a reviewer input, or change how it runs, is
// refused with a reason a client can act on, and nothing reaches the agent.
func TestHandler_PermissionReviewerTakesNoInputFromAPerson(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	main, _ := env.createSession()
	reviewer, _, err := store.EnsurePermissionReviewer(bgCtx, main.ID, "reviewer")
	if err != nil {
		t.Fatalf("create reviewer: %v", err)
	}

	calls := []struct {
		method string
		params any
	}{
		{"chat.message", rpc.MessageParams{SessionID: reviewer.ID, Content: "hello"}},
		{"chat.html_action", rpc.HTMLActionParams{SessionID: reviewer.ID, Page: "p1", Action: "go"}},
		{"chat.permission_response", rpc.PermissionResponseParams{SessionID: reviewer.ID, RequestID: "r1", Choice: "allow"}},
		{"session.set_agent_type", rpc.SessionSetAgentTypeParams{SessionID: reviewer.ID, AgentType: session.AgentTypeCodex}},
		{"session.set_mode", rpc.SessionSetModeParams{SessionID: reviewer.ID, Mode: session.ModeYolo}},
		{"session.set_model", rpc.SessionSetModelParams{SessionID: reviewer.ID, Model: "opus"}},
		{"session.set_effort", rpc.SessionSetEffortParams{SessionID: reviewer.ID, Effort: "high"}},
		{"session.set_html_first", rpc.SessionSetHTMLFirstParams{SessionID: reviewer.ID, HTMLFirst: true}},
	}
	for _, c := range calls {
		t.Run(c.method, func(t *testing.T) {
			resp := env.call(c.method, c.params)
			if resp.Error == nil {
				t.Fatal("expected the reviewer to refuse")
			}
			var data rpc.ChatErrorData
			if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil || data.Reason != rpc.ChatReasonPermissionReviewer {
				t.Errorf("error = %q, data %v; want reason %q", resp.Error.Message, resp.Error.Data, rpc.ChatReasonPermissionReviewer)
			}
		})
	}

	if got := mock.sentMessagesFor(reviewer.ID); len(got) != 0 {
		t.Errorf("reviewer's agent was sent %q", got)
	}
	unchanged, _, _ := store.Get(reviewer.ID)
	if unchanged.Mode != reviewer.Mode || unchanged.Model != reviewer.Model || unchanged.AgentType != reviewer.AgentType || unchanged.HTMLFirst {
		t.Errorf("reviewer changed: %+v", unchanged)
	}

	// The main session is an ordinary one.
	if resp := env.call("chat.message", rpc.MessageParams{SessionID: main.ID, Content: "hello"}); resp.Error != nil {
		t.Errorf("main session refused a message: %s", resp.Error.Message)
	}
}

// Deleting the main session takes the reviewer with it, process and all — the
// reviewer having been driven by Pockode, which is the only way it runs.
func TestHandler_SessionDelete_TakesThePermissionReviewer(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	main, _ := env.createSession()
	reviewer, _, err := wt.SessionStore.EnsurePermissionReviewer(bgCtx, main.ID, "reviewer")
	if err != nil {
		t.Fatalf("create reviewer: %v", err)
	}
	if err := wt.ChatClient.SendSystemMessage(bgCtx, reviewer.ID, "review this", "permission_review", nil); err != nil {
		t.Fatalf("send to reviewer: %v", err)
	}
	if !wt.ProcessManager.HasProcess(reviewer.ID) {
		t.Fatal("expected the reviewer to have a process")
	}

	if resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: main.ID}); resp.Error != nil {
		t.Fatalf("session.delete: %s", resp.Error.Message)
	}

	if _, found, _ := wt.SessionStore.Get(reviewer.ID); found {
		t.Error("the reviewer outlived its main session")
	}
	if wt.ProcessManager.HasProcess(reviewer.ID) {
		t.Error("the reviewer's process outlived its session")
	}
}

func TestHandler_SessionSetMode_Unattended(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	row, _ := env.createSession()

	if resp := env.call("session.set_mode", rpc.SessionSetModeParams{SessionID: row.ID, Mode: session.ModeUnattended}); resp.Error != nil {
		t.Fatalf("session.set_mode: %s", resp.Error.Message)
	}
	if meta, _, _ := env.getMainWorktree().SessionStore.Get(row.ID); meta.Mode != session.ModeUnattended {
		t.Errorf("mode = %q, want %q", meta.Mode, session.ModeUnattended)
	}
}

// Each agent's reviewer choice is judged against that agent, and a valid one is
// what settings read back.
func TestHandler_SettingsUpdate_PermissionReviewer(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	refused := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{
		PermissionReviewer: settings.PermissionReviewerSettings{Claude: settings.ReviewerEngine{Model: "gpt-5.6-sol"}},
	}})
	if refused.Error == nil {
		t.Fatal("expected a codex model for the claude reviewer to be refused")
	}

	want := settings.PermissionReviewerSettings{
		Claude: settings.ReviewerEngine{Model: "haiku", Effort: "low"},
		Codex:  settings.ReviewerEngine{Model: "gpt-5.6-luna"},
	}
	if resp := env.call("settings.update", rpc.SettingsUpdateParams{Settings: settings.Settings{PermissionReviewer: want}}); resp.Error != nil {
		t.Fatalf("settings.update: %s", resp.Error.Message)
	}
	if got := env.handler.settingsStore.Get().PermissionReviewer; got != want {
		t.Errorf("stored = %+v, want %+v", got, want)
	}
}
