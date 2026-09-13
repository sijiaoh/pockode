package ws

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/rpc"
)

// killedClient is a second connection to the test server that can be made to
// vanish without a close handshake, the way a phone losing its network does.
// The connection under test has to be its own, not env's: what is being watched
// is what the server releases when a client disappears.
type killedClient struct {
	t     *testing.T
	env   *testEnv
	conn  *websocket.Conn
	reqID int
}

func newKilledClient(t *testing.T, env *testEnv) *killedClient {
	t.Helper()

	conn, err := dialTestClient(env.ctx, env.server.URL)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &killedClient{t: t, env: env, conn: conn}

	if resp := c.call("auth", rpc.AuthParams{Token: "test-token"}); resp.Error != nil {
		t.Fatalf("auth failed: %s", resp.Error.Message)
	}
	return c
}

func (c *killedClient) call(method string, params interface{}) rpcResponse {
	c.t.Helper()
	c.reqID++
	data, _ := json.Marshal(rpcRequest{JSONRPC: "2.0", ID: c.reqID, Method: method, Params: params})
	if err := c.conn.Write(c.env.ctx, websocket.MessageText, data); err != nil {
		c.t.Fatalf("write %s: %v", method, err)
	}
	for {
		_, respData, err := c.conn.Read(c.env.ctx)
		if err != nil {
			c.t.Fatalf("read %s: %v", method, err)
		}
		var resp rpcResponse
		if err := json.Unmarshal(respData, &resp); err != nil {
			c.t.Fatalf("unmarshal %s response: %v", method, err)
		}
		if resp.ID == c.reqID {
			return resp
		}
	}
}

// kill drops the socket without a close handshake, which is what the server
// sees when the network goes away rather than the client.
func (c *killedClient) kill() {
	c.conn.CloseNow()
}

// A connection that disappears must run its cleanup all the way down: the read
// has to fail, unwind handleStream, and reach state.cleanup. Otherwise each
// network blip — and on a phone there are many — strands a goroutine holding a
// worktree and its watcher subscriptions for the rest of the process's life.
//
// Cleanup gives back three things on three separate lines: the watcher
// subscriptions, the worktree's notifier, and the worktree reference. All
// three are asserted, because leaking the reference alone pins the worktree
// past idle cleanup — the manager will not reclaim one that still has holders
// — while the other two look clean.
func TestConnection_ReleasesResourcesWhenClientVanishes(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	defer env.worktreeManager.Release(wt)

	// env's own connection is already bound, and so is the reference this test
	// holds, so compare against the current counts rather than zero.
	baseSubscribers := wt.SubscriberCount()
	baseRefs := env.worktreeManager.RefCount(wt)
	if env.handler.workListWatcher.HasSubscriptions() {
		t.Fatal("work list watcher has subscriptions before the test subscribed")
	}

	// Several outages in a row, because what makes a leak a leak is that it
	// accumulates: one cycle cannot tell "released" apart from "released this
	// time".
	for cycle := range 5 {
		client := newKilledClient(t, env)

		if resp := client.call("work.list.subscribe", rpc.SubscribeParams{ID: "client-1"}); resp.Error != nil {
			t.Fatalf("cycle %d: work.list.subscribe failed: %s", cycle, resp.Error.Message)
		}
		if got := wt.SubscriberCount(); got != baseSubscribers+1 {
			t.Fatalf("cycle %d: connection did not bind the worktree: subscribers=%d, want %d", cycle, got, baseSubscribers+1)
		}
		if got := env.worktreeManager.RefCount(wt); got != baseRefs+1 {
			t.Fatalf("cycle %d: connection did not take a worktree reference: refs=%d, want %d", cycle, got, baseRefs+1)
		}
		if !env.handler.workListWatcher.HasSubscriptions() {
			t.Fatalf("cycle %d: work.list.subscribe did not register a watcher subscription", cycle)
		}

		client.kill()

		// Asserted apart so a failure names which one leaked: they are released
		// by different lines of cleanup, and the first two have failed
		// independently before.
		if !waitForCleanup(func() bool { return !env.handler.workListWatcher.HasSubscriptions() }) {
			t.Fatalf("cycle %d: the watcher subscription outlived the connection that made it", cycle)
		}
		if !waitForCleanup(func() bool { return wt.SubscriberCount() == baseSubscribers }) {
			t.Fatalf("cycle %d: worktree still has %d subscribers, want %d; cleanup never reached it",
				cycle, wt.SubscriberCount(), baseSubscribers)
		}
		if !waitForCleanup(func() bool { return env.worktreeManager.RefCount(wt) == baseRefs }) {
			t.Fatalf("cycle %d: worktree still has %d references, want %d; the connection never gave its reference back",
				cycle, env.worktreeManager.RefCount(wt), baseRefs)
		}
	}
}

// waitForCleanup polls until cond holds, reporting whether it ever did. Cleanup
// runs on the connection's own goroutine once its read fails, so there is
// nothing to synchronise on from here.
func waitForCleanup(cond func() bool) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return false
}
