package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// seedHistory writes n records to a session's history and returns the worktree
// holding it. Written through the store rather than by streaming events so the
// test says what it means: paging is about records already on disk.
func seedHistory(t *testing.T, env *testEnv, sessionID string, n int) *worktree.Worktree {
	t.Helper()
	wt := env.getMainWorktree()
	if _, err := wt.SessionStore.Create(bgCtx, sessionID, session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	for i := 1; i <= n; i++ {
		record := agent.TextRecord{Content: fmt.Sprintf("m%d", i)}
		if _, err := wt.SessionStore.AppendToHistory(bgCtx, sessionID, record, session.HistoryTurn{}); err != nil {
			t.Fatalf("append record %d: %v", i, err)
		}
	}
	return wt
}

func (e *testEnv) subscribeChatMessagesWithLimit(sessionID string, limit int) rpc.ChatMessagesSubscribeResult {
	e.t.Helper()
	resp := e.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{
		ID: e.nextSubID(), SessionID: sessionID, Limit: limit,
	})
	if resp.Error != nil {
		e.t.Fatalf("subscribe failed: %s", resp.Error.Message)
	}
	var result rpc.ChatMessagesSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("failed to unmarshal result: %v", err)
	}
	return result
}

func (e *testEnv) chatHistoryPage(sessionID string, before session.HistorySeq, limit int) rpc.ChatMessagesHistoryResult {
	e.t.Helper()
	resp := e.call("chat.messages.history", rpc.ChatMessagesHistoryParams{
		SessionID: sessionID, BeforeSeq: before, Limit: limit,
	})
	if resp.Error != nil {
		e.t.Fatalf("chat.messages.history failed: %s", resp.Error.Message)
	}
	var result rpc.ChatMessagesHistoryResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("failed to unmarshal result: %v", err)
	}
	return result
}

// contentsOf reads a page's text items back as the client sees them: the text
// it would render, paired with the address it would quote to ask for more.
func contentsOf(page projection.Page) []string {
	var out []string
	for _, turn := range page.Turns {
		for _, item := range turn.Items {
			if item.Text != nil {
				out = append(out, fmt.Sprintf("%s@%d", item.Text.Content, item.Seq))
			}
		}
	}
	return out
}

func itemsOf(page projection.Page) []projection.PageItem {
	var out []projection.PageItem
	for _, turn := range page.Turns {
		out = append(out, turn.Items...)
	}
	return out
}

// TestChatMessagesSubscribe_ReturnsNewestPage is the reason the protocol
// changed: opening a long session must not ship its whole history.
func TestChatMessagesSubscribe_ReturnsNewestPage(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 10)

	result := env.subscribeChatMessagesWithLimit("sess", 3)

	got := strings.Join(contentsOf(*result.Page), " ")
	if got != "m8@8 m9@9 m10@10" {
		t.Fatalf("subscribe returned %q, want the newest three items", got)
	}
	if !result.HasMore {
		t.Error("HasMore = false, but seven older records exist")
	}
	if result.NextBeforeSeq != 8 {
		t.Errorf("NextBeforeSeq = %d, want 8", result.NextBeforeSeq)
	}
}

func TestChatMessagesSubscribe_ShortHistoryHasNoMore(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 2)

	result := env.subscribeChatMessagesWithLimit("sess", 50)

	if got := len(itemsOf(*result.Page)); got != 2 {
		t.Fatalf("subscribe returned %d items, want 2", got)
	}
	if result.HasMore || result.NextBeforeSeq != session.NoHistorySeq {
		t.Errorf("HasMore = %v, NextBeforeSeq = %d, want false and 0", result.HasMore, result.NextBeforeSeq)
	}
}

// A client re-subscribing with the transcript it holds is resumed only by the
// server instance it read it from: seqs from another may have been handed to
// other records since (rpc.AuthResult.ServerInstance), so that client is
// given a snapshot — and the reply says which of the two it is.
func TestChatMessagesSubscribe_ResumesOnlyTheSameInstance(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := seedHistory(t, env, "sess", 3)
	held := env.subscribeChatMessages("sess")
	if held.Delivery != rpc.ChatDeliverySnapshot || held.Page == nil {
		t.Fatalf("a subscribe that did not ask to resume = %+v, want a snapshot", held)
	}
	if _, err := wt.SessionStore.AppendToHistory(bgCtx, "sess", agent.TextRecord{Content: "m4"}, session.HistoryTurn{}); err != nil {
		t.Fatalf("append: %v", err)
	}

	subscribe := func(instance string) (rpc.ChatMessagesSubscribeResult, map[string]json.RawMessage) {
		t.Helper()
		resp := env.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{
			ID: env.nextSubID(), SessionID: "sess",
			Resume: &rpc.ChatResume{ServerInstance: instance, AfterSeq: held.ThroughSeq},
		})
		if resp.Error != nil {
			t.Fatalf("subscribe failed: %s", resp.Error.Message)
		}
		var result rpc.ChatMessagesSubscribeResult
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(resp.Result, &result); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(resp.Result, &fields); err != nil {
			t.Fatal(err)
		}
		return result, fields
	}

	resumed, fields := subscribe(env.handler.instance)
	if resumed.Delivery != rpc.ChatDeliveryResume || resumed.Update == nil {
		t.Fatalf("resume from this instance = %+v, want an update", resumed)
	}
	if _, ok := fields["turns"]; ok {
		t.Errorf("a resume carries a page's turns too: %s", fields["turns"])
	}
	if len(resumed.Update.Items) != 1 || resumed.Update.Items[0].Item.Text.Content != "m4" {
		t.Errorf("resumed items = %+v, want only m4, written since", resumed.Update.Items)
	}

	other, _ := subscribe("another-instance")
	if other.Delivery != rpc.ChatDeliverySnapshot || other.Update != nil || other.Page == nil {
		t.Fatalf("resume from another instance = %+v, want a snapshot", other)
	}
	if got := strings.Join(contentsOf(*other.Page), " "); got != "m1@1 m2@2 m3@3 m4@4" {
		t.Errorf("snapshot = %q, want the newest page", got)
	}
}

// TestChatMessagesSubscribe_RejectsNegativeLimit pins that subscribing refuses a
// page size it cannot honour instead of quietly falling back to the default.
func TestChatMessagesSubscribe_RejectsNegativeLimit(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 3)

	resp := env.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{ID: "client-1", SessionID: "sess", Limit: -1})

	if resp.Error == nil {
		t.Fatalf("expected an error, got result %s", resp.Result)
	}
	if !strings.Contains(resp.Error.Message, "invalid history page size") {
		t.Errorf("error = %q, want it to name the bad page size", resp.Error.Message)
	}
}

// TestChatMessagesHistory_PagesBackToTheTop follows the cursors the way a
// client scrolling up does, and pins that the walk reproduces the history
// exactly once — the guarantee paging has to make.
func TestChatMessagesHistory_PagesBackToTheTop(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 7)

	sub := env.subscribeChatMessagesWithLimit("sess", 3)
	seen := contentsOf(*sub.Page)
	hasMore, before := sub.HasMore, sub.NextBeforeSeq

	for pages := 0; hasMore; pages++ {
		if pages > 7 {
			t.Fatal("paging did not terminate")
		}
		page := env.chatHistoryPage("sess", before, 3)
		seen = append(contentsOf(page.Page), seen...)
		hasMore, before = page.HasMore, page.NextBeforeSeq
	}

	got := strings.Join(seen, " ")
	want := "m1@1 m2@2 m3@3 m4@4 m5@5 m6@6 m7@7"
	if got != want {
		t.Fatalf("walking back gave %q, want %q", got, want)
	}
}

// TestChatMessagesHistory_LiveEventsDoNotShiftOlderPages: a record streamed
// while the client is scrolled up is appended after the page it is reading, so
// the cursor it holds must still name the same place.
func TestChatMessagesHistory_LiveEventsDoNotShiftOlderPages(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := seedHistory(t, env, "sess", 6)

	sub := env.subscribeChatMessagesWithLimit("sess", 2) // m5, m6

	if _, err := wt.SessionStore.AppendToHistory(bgCtx, "sess",
		agent.TextRecord{Content: "m7"}, session.HistoryTurn{}); err != nil {
		t.Fatalf("append live record: %v", err)
	}

	page := env.chatHistoryPage("sess", sub.NextBeforeSeq, 2)
	if got := strings.Join(contentsOf(page.Page), " "); got != "m3@3 m4@4" {
		t.Fatalf("older page returned %q after a newer record was appended, want %q", got, "m3@3 m4@4")
	}
}

func TestChatMessagesHistory_RejectsBadRequests(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 5)

	tests := []struct {
		name   string
		params rpc.ChatMessagesHistoryParams
		want   string
	}{
		{
			name:   "cursor past the end",
			params: rpc.ChatMessagesHistoryParams{SessionID: "sess", BeforeSeq: 99},
			want:   "invalid history cursor",
		},
		{
			name:   "negative cursor",
			params: rpc.ChatMessagesHistoryParams{SessionID: "sess", BeforeSeq: -1},
			want:   "invalid history cursor",
		},
		{
			name:   "negative limit",
			params: rpc.ChatMessagesHistoryParams{SessionID: "sess", Limit: -1},
			want:   "invalid history page size",
		},
		{
			name:   "unknown session",
			params: rpc.ChatMessagesHistoryParams{SessionID: "nope"},
			want:   "session not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp := env.call("chat.messages.history", tt.params)
			if resp.Error == nil {
				t.Fatalf("expected an error, got result %s", resp.Result)
			}
			if !strings.Contains(resp.Error.Message, tt.want) {
				t.Errorf("error = %q, want it to mention %q", resp.Error.Message, tt.want)
			}
		})
	}
}

// The sender is sent its own message like every other subscriber, under the
// id it minted: that is how it knows the record for the message it drew.
func TestChatMessage_TheSenderReceivesItsOwnRecord(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	if _, err := env.getMainWorktree().SessionStore.Create(bgCtx, "sess", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	env.subscribeChatMessages("sess")

	id := env.sendMessage("sess", "hello")

	env.awaitUpdate(func(u chatUpdate) bool {
		for _, it := range u.Items {
			if it.Item.Kind == projection.KindMessage && it.Item.Message.MessageID == id {
				if it.Item.Message.Content != "hello" || it.Item.Message.ObservedAt == nil {
					t.Errorf("the sender's own item = %+v, want the record as written", it.Item)
				}
				return true
			}
		}
		return false
	})
}

// A send retried under the id of one already recorded — its reply lost with
// the connection, say — is answered as sent and sends nothing: no second
// record, nothing more for the agent.
func TestChatMessage_ARetryUnderTheSameIDSendsNothing(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row, _ := env.createSession()

	id := uuid.NewString()
	for attempt := range 2 {
		resp := env.call("chat.message", rpc.MessageParams{SessionID: row.ID, MessageID: id, Content: "once"})
		if resp.Error != nil {
			t.Fatalf("attempt %d: %s", attempt, resp.Error.Message)
		}
	}

	if records := messageRecords(t, env, row.ID); len(records) != 1 || records[0].MessageID != id {
		t.Errorf("message records = %+v, want one, under %s", records, id)
	}
	if got := mock.sentMessagesFor(row.ID); len(got) != 1 {
		t.Errorf("agent was sent %q, want the message once", got)
	}
}

// A message id is the client's to mint, but only as a UUID in canonical form:
// anything else is refused before anything is written.
func TestChatMessage_RefusesAMessageIDThatIsNotAUUID(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)
	row, _ := env.createSession()
	id := uuid.NewString()

	for _, bad := range []string{"m1", strings.ToUpper(id), "{" + id + "}", strings.ReplaceAll(id, "-", "")} {
		resp := env.call("chat.message", rpc.MessageParams{SessionID: row.ID, MessageID: bad, Content: "hi"})
		if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams || !strings.Contains(resp.Error.Message, "message_id") {
			t.Errorf("message_id %q: error = %+v, want invalid params naming message_id", bad, resp.Error)
		}
		resp = env.call("chat.html_action", rpc.HTMLActionParams{SessionID: row.ID, MessageID: bad, Page: "p1", Action: "go"})
		if resp.Error == nil || resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Errorf("html_action message_id %q: error = %+v, want invalid params", bad, resp.Error)
		}
	}
	if records := messageRecords(t, env, row.ID); len(records) != 0 {
		t.Errorf("message records = %+v, want none", records)
	}
	if got := mock.sentMessagesFor(row.ID); len(got) != 0 {
		t.Errorf("agent was sent %q, want nothing", got)
	}
}

// A call still running in a page is counted from its started_at
// against the server's clock, never the phone's, so both replies carry a
// reading of it.
func TestChatMessages_RepliesCarryTheServerClock(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	seedHistory(t, env, "sess", 4)

	before := time.Now()
	subscribed := env.subscribeChatMessagesWithLimit("sess", 2)
	page := env.chatHistoryPage("sess", subscribed.NextBeforeSeq, 2)
	after := time.Now()

	for name, at := range map[string]time.Time{"subscribe": subscribed.ServerTime, "history": page.ServerTime} {
		if at.Before(before) || at.After(after) {
			t.Errorf("%s server_time = %v, want between %v and %v", name, at, before, after)
		}
	}
}
