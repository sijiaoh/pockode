package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/projection"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/worktree"
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

	got := strings.Join(contentsOf(result.Page), " ")
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

	if got := len(itemsOf(result.Page)); got != 2 {
		t.Fatalf("subscribe returned %d items, want 2", got)
	}
	if result.HasMore || result.NextBeforeSeq != session.NoHistorySeq {
		t.Errorf("HasMore = %v, NextBeforeSeq = %d, want false and 0", result.HasMore, result.NextBeforeSeq)
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
	seen := contentsOf(sub.Page)
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

// The sender is left out of the broadcast of its own message, so the reply is
// the one place it learns how that record is named — by seq to fork from it,
// by message_id to find it again when a later record (a Stop discarding it) is
// about it — and by observed_at for when the reply it opens began. All have to
// be the record's own, as a reload would show them.
func TestChatMessage_ReplyNamesTheRecord(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	if _, err := env.getMainWorktree().SessionStore.Create(bgCtx, "sess", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}

	reply := env.sendMessage("sess", "hello")

	page := env.subscribeChatMessagesWithLimit("sess", 10)
	items := itemsOf(page.Page)
	if len(items) == 0 {
		t.Fatal("transcript is empty, want the message")
	}
	item := items[0]
	if item.Kind != projection.KindMessage || item.Message.MessageID == "" || item.Message.ObservedAt == nil {
		t.Fatalf("first item = %+v, want the message carrying its id and moment", item)
	}
	if reply.Seq != item.Seq || reply.MessageID != item.Message.MessageID {
		t.Errorf("reply named seq %d id %q, want the item's seq %d id %q",
			reply.Seq, reply.MessageID, item.Seq, item.Message.MessageID)
	}
	// The sender draws the reply this message opens from the reply alone, so it
	// is told when that reply began — the record's moment, not one of its own.
	if reply.ObservedAt == nil || !reply.ObservedAt.Equal(*item.Message.ObservedAt) {
		t.Errorf("reply observed_at = %v, want the record's %v", reply.ObservedAt, *item.Message.ObservedAt)
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
