package ws

import (
	"encoding/json"
	"testing"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

func setHTMLFirst(env *testEnv, sessionID string, htmlFirst bool) rpcResponse {
	return env.call("session.set_html_first", rpc.SessionSetHTMLFirstParams{SessionID: sessionID, HTMLFirst: htmlFirst})
}

// htmlFirstRefusal is the reason a refused session.set_html_first carries,
// which is what the client branches on.
func htmlFirstRefusal(t *testing.T, resp rpcResponse) string {
	t.Helper()
	if resp.Error == nil {
		t.Fatalf("expected a refusal, got result %s", resp.Result)
	}
	if resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("code = %d, want CodeInvalidParams", resp.Error.Code)
	}
	if resp.Error.Data == nil {
		t.Fatalf("refusal %q carries no data; clients branch on data.reason", resp.Error.Message)
	}
	var data rpc.SessionSetHTMLFirstErrorData
	if err := json.Unmarshal(*resp.Error.Data, &data); err != nil {
		t.Fatalf("unmarshal error data: %v", err)
	}
	return data.Reason
}

// The switch holds until the first message, the agent starts with what it was
// switched to, and it is fixed from then on.
func TestHandler_SessionSetHTMLFirst_FixedByFirstMessage(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row, _ := env.createSession()
	if row.HTMLFirst {
		t.Fatal("a new session must start as an ordinary chat")
	}

	for _, value := range []bool{true, false, true} {
		if resp := setHTMLFirst(env, row.ID, value); resp.Error != nil {
			t.Fatalf("set_html_first(%v) before the first message: %s", value, resp.Error.Message)
		}
	}
	meta, _, _ := env.getMainWorktree().SessionStore.Get(row.ID)
	if !meta.HTMLFirst || meta.Started {
		t.Fatalf("stored session = html_first %v, started %v; want true, false", meta.HTMLFirst, meta.Started)
	}

	env.sendMessage(row.ID, "hello")

	starts := mock.starts()
	if len(starts) != 1 || !starts[0].htmlFirst {
		t.Fatalf("agent starts = %+v, want one HTML-first start", starts)
	}

	if reason := htmlFirstRefusal(t, setHTMLFirst(env, row.ID, false)); reason != rpc.SessionHTMLFirstStarted {
		t.Errorf("reason = %q, want %q", reason, rpc.SessionHTMLFirstStarted)
	}
	meta, _, _ = env.getMainWorktree().SessionStore.Get(row.ID)
	if !meta.HTMLFirst || !meta.Started {
		t.Errorf("stored session = html_first %v, started %v; want true, true", meta.HTMLFirst, meta.Started)
	}
}

// A first message that is refused never reached the agent, so the session has
// not started — but the CLI was spawned to ask it, with the value the session
// had then. Switching afterwards must still get the next message an agent told
// the new value, not the process left over.
func TestHandler_SessionSetHTMLFirst_RefusedFirstMessage(t *testing.T) {
	mock := &mockAgent{} // its sessions take no files, so a message with one is refused
	env := newTestEnv(t, mock)
	wt := env.getMainWorktree()
	row, _ := env.createSession()
	id, err := attachments.NewStore(wt.DataDir, row.ID).Put(pngPixel, ".png")
	if err != nil {
		t.Fatal(err)
	}

	resp := env.call("chat.message", rpc.MessageParams{
		SessionID:   row.ID,
		Content:     "look",
		Attachments: []rpc.MessageAttachmentParams{{ID: id}},
	})
	if resp.Error == nil {
		t.Fatal("expected the message with a file to be refused")
	}
	if !wt.ProcessManager.HasProcess(row.ID) {
		t.Fatal("fixture: the refused message is expected to leave its process running")
	}

	if resp := setHTMLFirst(env, row.ID, true); resp.Error != nil {
		t.Fatalf("set_html_first after a refused first message: %s", resp.Error.Message)
	}

	env.sendMessage(row.ID, "hello")

	starts := mock.starts()
	if len(starts) != 2 || starts[0].htmlFirst || !starts[1].htmlFirst {
		t.Fatalf("agent starts = %+v, want an ordinary start replaced by an HTML-first one", starts)
	}
	if got := mock.sentMessagesFor(row.ID); len(got) != 1 || got[0] != "hello" {
		t.Errorf("agent was sent %q, want the one delivered message", got)
	}
}

// A fork's history was told under its source's guidance: it keeps the value and
// is never offered the switch.
func TestHandler_SessionFork_CopiesHTMLFirst(t *testing.T) {
	env := newForkableTestEnv(t)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "source", session.CreateSpec{AgentType: session.AgentTypeClaude})
	if resp := setHTMLFirst(env, "source", true); resp.Error != nil {
		t.Fatalf("set_html_first: %s", resp.Error.Message)
	}
	store.AppendToHistory(bgCtx, "source", map[string]string{"type": "message", "content": "hello"})
	anchor, _ := store.AppendToHistory(bgCtx, "source", map[string]string{"type": "text", "content": "a page"})

	resp := env.call("session.fork", rpc.SessionForkParams{SessionID: "source", AnchorSeq: anchor})
	if resp.Error != nil {
		t.Fatalf("session.fork: %s", resp.Error.Message)
	}
	var fork rpc.SessionListItem
	if err := json.Unmarshal(resp.Result, &fork); err != nil {
		t.Fatal(err)
	}
	if !fork.HTMLFirst {
		t.Error("expected the fork's row to carry html_first")
	}
	if reason := htmlFirstRefusal(t, setHTMLFirst(env, fork.ID, false)); reason != rpc.SessionHTMLFirstStarted {
		t.Errorf("reason = %q, want %q", reason, rpc.SessionHTMLFirstStarted)
	}
}

func TestHandler_SessionSetHTMLFirst_WorkSessionRefused(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	_, sessionID := startWorkWaiting(t, env, work.WaitNone)

	if reason := htmlFirstRefusal(t, setHTMLFirst(env, sessionID, true)); reason != rpc.SessionHTMLFirstWorkSession {
		t.Errorf("reason = %q, want %q", reason, rpc.SessionHTMLFirstWorkSession)
	}
	if meta, _, _ := env.getMainWorktree().SessionStore.Get(sessionID); meta.HTMLFirst {
		t.Error("a work's session must stay an ordinary chat")
	}
}

func TestHandler_SessionSetHTMLFirst_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := setHTMLFirst(env, "non-existent", true)
	if resp.Error == nil || resp.Error.Message != "session not found" {
		t.Errorf("expected session not found, got %+v", resp)
	}
}
