package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/work"
)

// TestHandler_SubscribeTakesTheClientsID covers every *.subscribe method at once,
// because what each one has to get right is the same thing and the way to get it
// wrong is to be the one that was missed: pass the client's id to the watcher.
//
// Each method is asked three times — without an id, with one, and with the same
// one again — which pins that the id reached the watcher (a request that ignored
// it could not refuse the second) and that an id the client cannot use is the
// client's mistake rather than a subscription it can never hear from or cancel.
func TestHandler_SubscribeTakesTheClientsID(t *testing.T) {
	dir := setupGitRepo(t)
	tracked := filepath.Join(dir, "tracked.txt")
	os.WriteFile(tracked, []byte("original"), 0644)
	runGitIn(t, dir, "add", "tracked.txt")
	runGitIn(t, dir, "commit", "-m", "initial")
	os.WriteFile(tracked, []byte("modified"), 0644)

	env := newWorkDirTestEnv(t, dir)
	if _, err := env.getMainWorktree().SessionStore.Create(bgCtx, "sess", session.CreateSpec{}); err != nil {
		t.Fatalf("create session: %v", err)
	}
	var item work.Work
	json.Unmarshal(env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Story",
	}).Result, &item)

	tests := []struct {
		method string
		params func(id string) any
	}{
		{"fs.subscribe", func(id string) any {
			return rpc.FSSubscribeParams{ID: id, Path: "tracked.txt"}
		}},
		{"git.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
		{"git.diff.subscribe", func(id string) any {
			return rpc.GitDiffSubscribeParams{ID: id, Path: "tracked.txt"}
		}},
		{"worktree.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
		{"settings.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
		{"session.list.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
		{"session.detail.subscribe", func(id string) any {
			return rpc.SessionDetailSubscribeParams{ID: id, SessionID: "sess"}
		}},
		{"chat.messages.subscribe", func(id string) any {
			return rpc.ChatMessagesSubscribeParams{ID: id, SessionID: "sess"}
		}},
		{"work.list.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
		{"work.detail.subscribe", func(id string) any {
			return rpc.WorkDetailSubscribeParams{ID: id, WorkID: item.ID}
		}},
		{"agent_role.list.subscribe", func(id string) any { return rpc.SubscribeParams{ID: id} }},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			if resp := env.call(tt.method, tt.params("")); resp.Error == nil ||
				!strings.Contains(resp.Error.Message, "subscription id is required") {
				t.Errorf("subscribe without an id: expected a missing-id error, got %+v", resp)
			}

			id := env.nextSubID()
			if resp := env.call(tt.method, tt.params(id)); resp.Error != nil {
				t.Fatalf("subscribe failed: %s", resp.Error.Message)
			}
			if resp := env.call(tt.method, tt.params(id)); resp.Error == nil ||
				!strings.Contains(resp.Error.Message, "already in use") {
				t.Errorf("subscribe reusing %q: expected a reused-id error, got %+v", id, resp)
			}
		})
	}
}

// A subscription id is unique within its watcher, not across them: a client is
// free to name its work-list subscription and its settings subscription the
// same thing, and two clients that each pick "1" collide on neither. What the
// server must not do is treat them as one subscription — unsubscribing one
// would then silently take the other's notifications away, and a disconnect
// would give only one of them back.
func TestHandler_SameIDOnTwoWatchers(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	const id = "same-on-both"

	if resp := env.call("work.list.subscribe", rpc.SubscribeParams{ID: id}); resp.Error != nil {
		t.Fatalf("work.list.subscribe: %s", resp.Error.Message)
	}
	if resp := env.call("settings.subscribe", rpc.SubscribeParams{ID: id}); resp.Error != nil {
		t.Fatalf("settings.subscribe: %s", resp.Error.Message)
	}

	// Ending one leaves the other in place.
	if resp := env.call("work.list.unsubscribe", unsubscribeParams{ID: id}); resp.Error != nil {
		t.Fatalf("work.list.unsubscribe: %s", resp.Error.Message)
	}
	if env.handler.workListWatcher.HasSubscriptions() {
		t.Error("the work list subscription outlived its unsubscribe")
	}
	if !env.handler.settingsWatcher.HasSubscriptions() {
		t.Fatal("unsubscribing the work list also took the settings subscription")
	}

	// And the connection still knows about the other one, so closing gives it back.
	env.conn.CloseNow()
	deadline := time.Now().Add(5 * time.Second)
	for env.handler.settingsWatcher.HasSubscriptions() {
		if time.Now().After(deadline) {
			t.Fatal("the settings subscription was never released when the connection went away")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
