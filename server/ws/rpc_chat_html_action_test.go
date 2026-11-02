package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

// A page action reaches the agent as a user message naming the page, and its
// record and reply carry the structured action beside that text
// (docs/tool-call-ui.md § The action message).
func TestChatHTMLAction_SendsTheActionAsAUserMessage(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "One", HTML: `<button data-pk-send="approve">OK</button>`})
	storePage(t, env, created.ID, htmlpage.Draft{Title: "Two", HTML: "<p>2</p>"})

	// p1 while p2 is the latest: any page with an id may send.
	resp := env.call("chat.html_action", rpc.HTMLActionParams{
		SessionID: created.ID, Page: "p1", Action: "approve",
		Data: json.RawMessage(`{ "id": "42",  "tags": ["a", "b"] }`),
	})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	const wantContent = "Page action \"approve\" from p1:\n{\"id\":\"42\",\"tags\":[\"a\",\"b\"]}"
	var result rpc.MessageResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if result.Content != wantContent {
		t.Errorf("reply content = %q, want %q", result.Content, wantContent)
	}
	if a := result.HTMLAction; a == nil || a.Page != "p1" || a.Action != "approve" || string(a.Data) != `{"id":"42","tags":["a","b"]}` {
		t.Errorf("reply html_action = %+v", a)
	}
	if !result.Seq.Valid() || result.MessageID == "" {
		t.Errorf("reply does not name its record: seq=%v id=%q", result.Seq, result.MessageID)
	}

	if got := mock.sentMessagesFor(created.ID); len(got) != 1 || got[0] != wantContent {
		t.Errorf("agent was sent %q, want [%q]", got, wantContent)
	}

	records, err := env.getMainWorktree().SessionStore.GetHistory(bgCtx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	var rec agent.EventRecord
	if err := json.Unmarshal(records[0], &rec); err != nil {
		t.Fatal(err)
	}
	if rec.Type != agent.EventTypeMessage || rec.Origin != "" || rec.Content != wantContent || rec.MessageID != result.MessageID {
		t.Errorf("record = %+v", rec)
	}
	if a := rec.HTMLAction; a == nil || a.Page != "p1" || a.Action != "approve" {
		t.Errorf("record html_action = %+v", a)
	}
}

// Data the page left out is `{}`; any JSON it did send — null, a string — is
// passed on as it is.
func TestChatHTMLAction_Data(t *testing.T) {
	for _, tt := range []struct {
		name string
		data json.RawMessage
		want string
	}{
		{"omitted", nil, "{}"},
		{"null", json.RawMessage("null"), "null"},
		{"string", json.RawMessage(`"x"`), `"x"`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			mock := &mockAgent{}
			env := newTestEnv(t, mock)
			_, created := env.createSession()
			storePage(t, env, created.ID, htmlpage.Draft{Title: "One", HTML: "<p>1</p>"})

			resp := env.call("chat.html_action", rpc.HTMLActionParams{SessionID: created.ID, Page: "p1", Action: "refresh", Data: tt.data})
			if resp.Error != nil {
				t.Fatalf("unexpected error: %s", resp.Error.Message)
			}
			want := "Page action \"refresh\" from p1:\n" + tt.want
			if got := mock.sentMessagesFor(created.ID); len(got) != 1 || got[0] != want {
				t.Errorf("agent was sent %q, want [%q]", got, want)
			}
		})
	}
}

// Every refusal is InvalidParams with words naming what was wrong, and leaves
// no trace: not on the agent's stdin, not in the transcript.
func TestChatHTMLAction_Refusals(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "One", HTML: "<p>1</p>"})
	id := created.ID

	big := `"` + strings.Repeat("x", 64*1024) + `"`
	const badAction = "action must be 1–128 characters with no control characters"
	tests := []struct {
		name   string
		params rpc.HTMLActionParams
		want   string
	}{
		{"unknown session", rpc.HTMLActionParams{SessionID: "nope", Page: "p1", Action: "go"}, "session not found"},
		{"page that does not exist", rpc.HTMLActionParams{SessionID: id, Page: "p9", Action: "go"},
			"page p9 does not exist in this session"},
		{"no page", rpc.HTMLActionParams{SessionID: id, Action: "go"}, `page must be a page id such as p1, not ""`},
		{"not a page id", rpc.HTMLActionParams{SessionID: id, Page: "../history", Action: "go"},
			`page must be a page id such as p1, not "../history"`},
		// Another spelling of p1 would read p1 and name something else on the
		// record than the card's id.
		{"signed page id", rpc.HTMLActionParams{SessionID: id, Page: "p+1", Action: "go"},
			`page must be a page id such as p1, not "p+1"`},
		{"zero-padded page id", rpc.HTMLActionParams{SessionID: id, Page: "p01", Action: "go"},
			`page must be a page id such as p1, not "p01"`},
		{"empty action", rpc.HTMLActionParams{SessionID: id, Page: "p1"}, badAction},
		{"long action", rpc.HTMLActionParams{SessionID: id, Page: "p1", Action: strings.Repeat("あ", 129)}, badAction},
		{"control character", rpc.HTMLActionParams{SessionID: id, Page: "p1", Action: "go\n"}, badAction},
		{"data too large", rpc.HTMLActionParams{SessionID: id, Page: "p1", Action: "go", Data: json.RawMessage(big)},
			fmt.Sprintf("data is %d bytes, over the 64KB limit", len(big))},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call("chat.html_action", tt.params)
			if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || resp.Error.Message != tt.want {
				t.Errorf("error = %+v, want InvalidParams %q", resp.Error, tt.want)
			}
		})
	}
	if got := mock.sentMessages(); len(got) != 0 {
		t.Errorf("the agent was sent %q", got)
	}
	if records, err := env.getMainWorktree().SessionStore.GetHistory(bgCtx, id); err != nil || len(records) != 0 {
		t.Errorf("history = %d records (err %v), want none", len(records), err)
	}
}

// The bounds are inclusive: each limit itself is accepted.
func TestChatHTMLAction_AcceptsTheLimits(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	// The reply echoes the data back, past the test client's default limit.
	env.conn.SetReadLimit(-1)
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "One", HTML: "<p>1</p>"})

	data := `"` + strings.Repeat("x", 64*1024-2) + `"`
	for _, params := range []rpc.HTMLActionParams{
		{SessionID: created.ID, Page: "p1", Action: strings.Repeat("あ", 128)},
		{SessionID: created.ID, Page: "p1", Action: "go", Data: json.RawMessage(data)},
	} {
		if resp := env.call("chat.html_action", params); resp.Error != nil {
			t.Errorf("chat.html_action(%.20q…) refused: %s", params.Action, resp.Error.Message)
		}
	}
}

// While a permission request is open the action is refused with the words a
// typed message gets, and with a reason a page's send can be told apart by
// without reading them.
func TestChatHTMLAction_RefusedWhileAPermissionIsOpen(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "One", HTML: "<p>1</p>"})
	// The first turn has to be over before the prompt is raised: the mock ends
	// every turn it is sent, and that ending would take the prompt with it.
	env.subscribeChatMessages(created.ID)
	env.sendMessage(created.ID, "start")
	env.awaitResponseComplete()
	raisePrompt(t, env, created.ID, "req-1", agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"})

	resp := env.call("chat.html_action", rpc.HTMLActionParams{SessionID: created.ID, Page: "p1", Action: "go"})
	if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Fatalf("error = %+v, want InvalidParams", resp.Error)
	}
	if resp.Error.Message != "this turn is waiting for an answer to the request on screen: answer it, or stop the turn, then send" {
		t.Errorf("message = %q", resp.Error.Message)
	}
	var data rpc.ChatErrorData
	if resp.Error.Data == nil || json.Unmarshal(*resp.Error.Data, &data) != nil || data.Reason != rpc.ChatReasonAwaitingPermission {
		t.Errorf("data = %v, want reason %q", resp.Error.Data, rpc.ChatReasonAwaitingPermission)
	}
	if got := mock.sentMessagesFor(created.ID); len(got) != 1 {
		t.Errorf("the agent was sent %q, want only the first message", got)
	}
	// Refused before anything is recorded, so the transcript has no action.
	records, err := env.getMainWorktree().SessionStore.GetHistory(bgCtx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range records {
		var rec agent.EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatal(err)
		}
		if rec.HTMLAction != nil {
			t.Errorf("a refused action was recorded: %+v", rec)
		}
	}
}
