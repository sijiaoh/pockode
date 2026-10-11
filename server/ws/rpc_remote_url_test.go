package ws

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/coder/websocket"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/internal/authsessiontest"
	"github.com/pockode/server/rpc"
)

// A connection that authenticated before the relay moved hears about the move
// without reconnecting: the subscription is routed, and RemoteURLChanged — what
// the relay calls — reaches it. What the watcher sends for each kind of change
// is pinned in the watch package.
func TestHandler_RemoteURLSubscribe_ReachesAConnectedClient(t *testing.T) {
	const (
		oldURL = "https://abc123.cloud.pockode.com"
		newURL = "https://def456.cloud.pockode.com"
	)
	var remoteURLMu sync.Mutex
	remoteURL := oldURL
	setRemoteURL := func(url string) {
		remoteURLMu.Lock()
		defer remoteURLMu.Unlock()
		remoteURL = url
	}
	h := newMinimalTestHandler(t, testPassword, func() string {
		remoteURLMu.Lock()
		defer remoteURLMu.Unlock()
		return remoteURL
	}, authsessiontest.New(), authsession.NewTickets())
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)

	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	conn, err := dialTestClient(ctx, server.URL)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if resp := exchange(t, ctx, conn, 1, "auth", rpc.AuthParams{Password: testPassword}); resp.Error != nil {
		t.Fatalf("auth failed: %v", resp.Error)
	}
	resp := exchange(t, ctx, conn, 2, "remote_url.subscribe", rpc.SubscribeParams{ID: "remote-1"})
	if resp.Error != nil {
		t.Fatalf("remote_url.subscribe failed: %v", resp.Error)
	}
	// Decoded by wire name, which is what the web client reads.
	var result struct {
		RemoteURL string `json:"remote_url"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if result.RemoteURL != oldURL {
		t.Errorf("subscribe remote_url = %q, want %q", result.RemoteURL, oldURL)
	}

	setRemoteURL(newURL)
	h.RemoteURLChanged()

	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("waiting for remote_url.changed: %v", err)
	}
	var notif struct {
		Method string `json:"method"`
		Params struct {
			ID        string `json:"id"`
			RemoteURL string `json:"remote_url"`
		} `json:"params"`
	}
	if err := json.Unmarshal(data, &notif); err != nil {
		t.Fatalf("unmarshal notification: %v", err)
	}
	if notif.Method != "remote_url.changed" || notif.Params.ID != "remote-1" || notif.Params.RemoteURL != newURL {
		t.Errorf("got %s, want remote_url.changed for remote-1 carrying %q", data, newURL)
	}
}
