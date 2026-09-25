package ws

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/work"
	"github.com/sourcegraph/jsonrpc2"
)

func createStory(t *testing.T, env *testEnv, title string) work.Work {
	t.Helper()
	resp := env.call("work.create", rpc.WorkCreateParams{
		AgentRoleID: env.testRoleID,
		Title:       title,
	})
	if resp.Error != nil {
		t.Fatalf("work.create %q: %s", title, resp.Error.Message)
	}
	var created work.Work
	if err := json.Unmarshal(resp.Result, &created); err != nil {
		t.Fatalf("unmarshal work.create: %v", err)
	}
	return created
}

func subscribeWorkList(t *testing.T, env *testEnv, id string) rpc.WorkListSubscribeResult {
	t.Helper()
	resp := env.call("work.list.subscribe", rpc.SubscribeParams{ID: id})
	if resp.Error != nil {
		t.Fatalf("work.list.subscribe: %s", resp.Error.Message)
	}
	var result rpc.WorkListSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal subscribe: %v", err)
	}
	return result
}

// The archive is walked with the cursor the previous page handed back, and only
// closed work is in it.
func TestHandler_WorkListArchive_WalksTheClosedWork(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	var closed []string
	for _, title := range []string{"first", "second"} {
		story := createStory(t, env, title)
		// Closed through the store: there is no RPC that closes a work item
		// outright — an agent closes its own by finishing its last step, and a
		// step cannot be finished on a work that was never started.
		if _, err := env.workStore.Start(bgCtx, story.ID, "session-"+title); err != nil {
			t.Fatalf("start %q: %v", title, err)
		}
		if _, err := env.workStore.StepDone(bgCtx, story.ID, 1); err != nil {
			t.Fatalf("close %q: %v", title, err)
		}
		closed = append(closed, story.ID)
	}
	live := createStory(t, env, "still going")

	snapshot := subscribeWorkList(t, env, "client-1")
	for _, item := range snapshot.Items {
		if item.Status == work.StatusClosed {
			t.Errorf("the Current segment carried a closed work %q", item.ID)
		}
	}

	var seen []string
	cursor := ""
	for range 3 {
		resp := env.call("work.list.archive", rpc.WorkListArchiveParams{
			ID: "client-1", Cursor: cursor, Limit: 1,
		})
		if resp.Error != nil {
			t.Fatalf("work.list.archive: %s", resp.Error.Message)
		}
		var page rpc.WorkListArchiveResult
		if err := json.Unmarshal(resp.Result, &page); err != nil {
			t.Fatalf("unmarshal archive: %v", err)
		}
		for _, item := range page.Items {
			if item.ID == live.ID {
				t.Error("open work must never appear in the archive")
			}
			seen = append(seen, item.ID)
		}
		if !page.HasMore {
			break
		}
		cursor = page.NextCursor
	}

	// Newest first: the last one closed is the first row.
	want := []string{closed[1], closed[0]}
	if strings.Join(seen, ",") != strings.Join(want, ",") {
		t.Errorf("walked %v, want %v", seen, want)
	}
}

// Both page requests name a subscription, and an id the server does not hold is
// invalid params — the client's signal to subscribe afresh rather than retry.
//
// The *code* is the contract, not the sentence: `isInvalidParamsRejection` in
// web/src/lib/wsStore.ts reads nothing else, and an internal error carrying the
// same words would leave the user with a Retry that can only fail the same way
// forever. So it is asserted here and in every sibling below.
func TestHandler_WorkListPaging_UnknownSubscription(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	for _, call := range []struct {
		method string
		params any
	}{
		{"work.list.archive", rpc.WorkListArchiveParams{ID: "never-subscribed"}},
		{"work.list.earlier", rpc.WorkListEarlierParams{ID: "never-subscribed"}},
	} {
		resp := env.call(call.method, call.params)
		if resp.Error == nil || !strings.Contains(resp.Error.Message, "no such subscription") {
			t.Errorf("%s: expected a no-such-subscription error, got %+v", call.method, resp)
			continue
		}
		if resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Errorf("%s: code = %d, want InvalidParams (%d)", call.method, resp.Error.Code, jsonrpc2.CodeInvalidParams)
		}
	}
}

// The other half of the same contract, and the half that is easy to get wrong:
// a cursor this server did not hand out cannot be made to work by asking again,
// so it has to refuse the way an unknown subscription does. Both list endpoints
// share one triage (`replyListPageError`), and this is what holds it to both.
func TestHandler_ListPaging_MalformedCursorIsTheClientsToFix(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	if _, err := env.getMainWorktree().SessionStore.Create(bgCtx, "session-1", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	subscribeWorkList(t, env, "work-client")
	if resp := env.call("session.list.subscribe", rpc.SubscribeParams{ID: "session-client"}); resp.Error != nil {
		t.Fatalf("session.list.subscribe: %s", resp.Error.Message)
	}

	for _, call := range []struct {
		method string
		params any
	}{
		{"session.list.page", rpc.SessionListPageParams{ID: "session-client", Cursor: "not-a-cursor"}},
		{"work.list.archive", rpc.WorkListArchiveParams{ID: "work-client", Cursor: "not-a-cursor"}},
	} {
		resp := env.call(call.method, call.params)
		if resp.Error == nil {
			t.Errorf("%s: a malformed cursor was accepted: %+v", call.method, resp)
			continue
		}
		if resp.Error.Code != jsonrpc2.CodeInvalidParams {
			t.Errorf("%s: code = %d, want InvalidParams (%d)", call.method, resp.Error.Code, jsonrpc2.CodeInvalidParams)
		}
	}
}

// "Show earlier work" is a cap being lifted, not a page being fetched: one
// request, the whole group, no cursor.
func TestHandler_WorkListEarlier_ReturnsTheWholeGroup(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	total := watch.CurrentGroupCap + 2
	for i := range total {
		createStory(t, env, string(rune('a'+i%26))+"-story")
	}

	snapshot := subscribeWorkList(t, env, "client-1")
	if len(snapshot.Items) != watch.CurrentGroupCap {
		t.Fatalf("snapshot carried %d rows, want the cap %d", len(snapshot.Items), watch.CurrentGroupCap)
	}
	if snapshot.OpenHidden != 2 {
		t.Fatalf("open_hidden = %d, want 2", snapshot.OpenHidden)
	}

	resp := env.call("work.list.earlier", rpc.WorkListEarlierParams{ID: "client-1"})
	if resp.Error != nil {
		t.Fatalf("work.list.earlier: %s", resp.Error.Message)
	}
	var result rpc.WorkListEarlierResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal earlier: %v", err)
	}
	if len(result.Items) != total {
		t.Errorf("earlier returned %d rows, want the whole group %d", len(result.Items), total)
	}
}
