package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/relay"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// relayTunnel stands in for the cloud relay: a websocket pair whose far end the
// test drives directly, so it can push envelopes for a virtual connection and
// read back whatever the multiplexer writes. Dropping it reproduces what a lost
// network route does to a live tunnel.
type relayTunnel struct {
	t       *testing.T
	cloud   *websocket.Conn
	streams chan *relay.VirtualStream
	cancel  context.CancelFunc
	runDone chan struct{}
	reqID   int
}

func newRelayTunnel(t *testing.T) *relayTunnel {
	t.Helper()

	accepted := make(chan *websocket.Conn, 1)
	serverDone := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		accepted <- conn
		<-serverDone
	}))

	client, _, err := websocket.Dial(bgCtx, "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if err != nil {
		srv.Close()
		t.Fatalf("dial relay stub: %v", err)
	}

	ctx, cancel := context.WithCancel(bgCtx)
	tun := &relayTunnel{
		t:       t,
		cloud:   <-accepted,
		streams: make(chan *relay.VirtualStream, 4),
		cancel:  cancel,
		runDone: make(chan struct{}),
	}

	mux := relay.NewMultiplexer(client, tun.streams, nil, slog.New(slog.DiscardHandler))
	go func() {
		defer close(tun.runDone)
		mux.Run(ctx)
	}()

	t.Cleanup(func() {
		tun.drop()
		close(serverDone)
		srv.Close()
	})

	return tun
}

// drop kills the tunnel and waits for Run to unwind, which is when the
// multiplexer is supposed to close the streams it owned.
func (r *relayTunnel) drop() {
	r.cancel()
	<-r.runDone
}

// call sends a JSON-RPC request for connectionID the way the cloud forwards one
// from a browser, then returns the matching response, skipping notifications.
func (r *relayTunnel) call(connectionID, method string, params any) rpcResponse {
	r.t.Helper()

	r.reqID++
	reqID := r.reqID
	r.write(connectionID, rpcRequest{JSONRPC: "2.0", ID: reqID, Method: method, Params: params})

	for {
		var resp rpcResponse
		payload := r.nextPayload(connectionID)
		if err := json.Unmarshal(payload, &resp); err != nil {
			r.t.Fatalf("unmarshal response: %v", err)
		}
		if resp.ID == reqID {
			return resp
		}
	}
}

func (r *relayTunnel) write(connectionID string, msg any) {
	r.t.Helper()

	payload, err := json.Marshal(msg)
	if err != nil {
		r.t.Fatalf("marshal payload: %v", err)
	}
	data, err := json.Marshal(relay.Envelope{
		ConnectionID: connectionID,
		Type:         relay.EnvelopeTypeMessage,
		Payload:      payload,
	})
	if err != nil {
		r.t.Fatalf("marshal envelope: %v", err)
	}
	if err := r.cloud.Write(bgCtx, websocket.MessageText, data); err != nil {
		r.t.Fatalf("write envelope: %v", err)
	}
}

// nextPayload returns the payload of the next envelope addressed to
// connectionID. Envelopes for other connections are not expected here, so they
// fail the test rather than being silently dropped.
func (r *relayTunnel) nextPayload(connectionID string) json.RawMessage {
	r.t.Helper()

	ctx, cancel := context.WithTimeout(bgCtx, 5*time.Second)
	defer cancel()

	_, data, err := r.cloud.Read(ctx)
	if err != nil {
		r.t.Fatalf("read envelope: %v", err)
	}
	var env relay.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		r.t.Fatalf("unmarshal envelope: %v", err)
	}
	if env.ConnectionID != connectionID {
		r.t.Fatalf("envelope addressed to %q, want %q", env.ConnectionID, connectionID)
	}
	return env.Payload
}

// connect brings a virtual connection up the way the cloud does: deliver the
// browser's first request, hand the stream it creates to the RPC handler, and
// wait for the auth reply. The returned channel closes when HandleStream
// unwinds.
func (r *relayTunnel) connect(h *RPCHandler, connectionID string) <-chan struct{} {
	r.t.Helper()

	r.reqID++
	reqID := r.reqID
	r.write(connectionID, rpcRequest{
		JSONRPC: "2.0",
		ID:      reqID,
		Method:  "auth",
		Params:  rpc.AuthParams{Token: "test-token"},
	})

	done := r.serve(h, connectionID)

	var resp rpcResponse
	if err := json.Unmarshal(r.nextPayload(connectionID), &resp); err != nil {
		r.t.Fatalf("unmarshal auth response: %v", err)
	}
	if resp.ID != reqID {
		r.t.Fatalf("auth reply carried id %d, want %d", resp.ID, reqID)
	}
	if resp.Error != nil {
		r.t.Fatalf("auth over relay failed: %s", resp.Error.Message)
	}
	return done
}

// serve waits for the multiplexer to surface the stream for connectionID and
// hands it to the RPC handler, mirroring what main.go does for every new
// virtual connection. The returned channel closes when HandleStream unwinds.
func (r *relayTunnel) serve(h *RPCHandler, connectionID string) <-chan struct{} {
	r.t.Helper()

	var stream *relay.VirtualStream
	select {
	case stream = <-r.streams:
	case <-time.After(5 * time.Second):
		r.t.Fatal("multiplexer never surfaced a stream for the incoming message")
	}
	if stream.ConnectionID() != connectionID {
		r.t.Fatalf("stream for connection %q, want %q", stream.ConnectionID(), connectionID)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		h.HandleStream(bgCtx, stream, stream.ConnectionID())
	}()
	return done
}

// A dead tunnel must tear its connections down all the way up the stack: the
// multiplexer closing its streams is only useful if the resulting EOF actually
// unwinds HandleStream and runs cleanup. Otherwise every network blip strands a
// goroutine holding a worktree reference and its watcher subscriptions for the
// rest of the process's life.
func TestHandleStream_ReleasesResourcesWhenRelayTunnelDies(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	defer env.worktreeManager.Release(wt)

	// env's own connection is already bound, so compare against its count
	// rather than zero.
	baseline := wt.SubscriberCount()
	if env.handler.workListWatcher.HasSubscriptions() {
		t.Fatal("work list watcher has subscriptions before the test subscribed")
	}

	// Several outages in a row, because what makes a leak a leak is that it
	// accumulates: one cycle cannot tell "released" apart from "released this
	// time".
	for cycle := range 5 {
		connectionID := fmt.Sprintf("c%d", cycle)

		tun := newRelayTunnel(t)
		handleDone := tun.connect(env.handler, connectionID)

		if resp := tun.call(connectionID, "work.list.subscribe", struct{}{}); resp.Error != nil {
			t.Fatalf("cycle %d: work.list.subscribe over relay failed: %s", cycle, resp.Error.Message)
		}
		if got := wt.SubscriberCount(); got != baseline+1 {
			t.Fatalf("cycle %d: relay connection did not bind the worktree: subscribers=%d, want %d", cycle, got, baseline+1)
		}
		if !env.handler.workListWatcher.HasSubscriptions() {
			t.Fatalf("cycle %d: work.list.subscribe did not register a watcher subscription", cycle)
		}

		tun.drop()

		select {
		case <-handleDone:
		case <-time.After(5 * time.Second):
			t.Fatalf("cycle %d: HandleStream still blocked after the tunnel died; its worktree reference and subscriptions leak", cycle)
		}

		if got := wt.SubscriberCount(); got != baseline {
			t.Fatalf("cycle %d: worktree still has %d subscribers after the tunnel died, want %d", cycle, got, baseline)
		}
		if env.handler.workListWatcher.HasSubscriptions() {
			t.Fatalf("cycle %d: watcher subscription outlived the tunnel it belonged to", cycle)
		}
	}
}

// Reconnecting is only worth anything if the fresh tunnel is fully functional:
// a stream must be surfaced for the new connection ID the cloud assigns, and
// server-pushed notifications must reach it.
func TestHandleStream_ServesStreamsAfterRelayReconnect(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	first := newRelayTunnel(t)
	firstDone := first.connect(env.handler, "c1")
	first.drop()
	<-firstDone

	// The cloud hands out a fresh connection ID after a reconnect.
	second := newRelayTunnel(t)
	second.connect(env.handler, "c2")

	if resp := second.call("c2", "work.list.subscribe", struct{}{}); resp.Error != nil {
		t.Fatalf("subscribe on the reconnected tunnel failed: %s", resp.Error.Message)
	}

	if _, err := env.workStore.Create(bgCtx, work.Work{Type: work.WorkTypeStory, Title: "after reconnect", AgentRoleID: env.testRoleID}); err != nil {
		t.Fatalf("create work: %v", err)
	}

	var notif rpcNotification
	if err := json.Unmarshal(second.nextPayload("c2"), &notif); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if notif.Method != "work.list.changed" {
		t.Fatalf("got %q over the reconnected tunnel, want a work.list.changed push", notif.Method)
	}
}
