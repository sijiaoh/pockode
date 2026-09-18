package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// One page at a time, walked with the cursor the previous one handed back. The
// limit is small rather than the default so that the walk is the subject and
// thirty fixtures are not.
func TestHandler_SessionListPage_WalksTheList(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	for _, id := range []string{"session-1", "session-2", "session-3"} {
		if _, err := store.Create(bgCtx, id, session.CreateSpec{}); err != nil {
			t.Fatalf("create: %v", err)
		}
	}

	if resp := env.call("session.list.subscribe", rpc.SubscribeParams{ID: "client-1"}); resp.Error != nil {
		t.Fatalf("subscribe: %s", resp.Error.Message)
	}

	var seen []string
	cursor := ""
	for range 4 {
		resp := env.call("session.list.page", rpc.SessionListPageParams{
			ID:     "client-1",
			Cursor: cursor,
			Limit:  1,
		})
		if resp.Error != nil {
			t.Fatalf("page: %s", resp.Error.Message)
		}
		var page rpc.SessionListPageResult
		if err := json.Unmarshal(resp.Result, &page); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		for _, row := range page.Sessions {
			seen = append(seen, row.ID)
		}
		if !page.HasMore {
			break
		}
		cursor = page.NextCursor
	}

	// Newest first: the last one created is the first row.
	want := []string{"session-3", "session-2", "session-1"}
	if strings.Join(seen, ",") != strings.Join(want, ",") {
		t.Errorf("walked %v, want %v", seen, want)
	}
}

// A page belongs to a subscription, because that is what holds the filter it
// has to agree with. There is no list to page without one.
func TestHandler_SessionListPage_UnknownSubscription(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.list.page", rpc.SessionListPageParams{ID: "never-subscribed"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "no such subscription") {
		t.Fatalf("expected a no-such-subscription error, got %+v", resp)
	}
	// The code, not the sentence, is what the client acts on; see
	// TestHandler_WorkListPaging_UnknownSubscription.
	if resp.Error.Code != jsonrpc2.CodeInvalidParams {
		t.Errorf("code = %d, want InvalidParams (%d)", resp.Error.Code, jsonrpc2.CodeInvalidParams)
	}
}
