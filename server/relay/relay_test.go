package relay

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestBuildRemoteURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "https://abc123def456ghi789jkl0123.cloud.pockode.com",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
			},
			want: "http://dev123.local.pockode.com",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRemoteURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRemoteURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestBuildRelayWSURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  *StoredConfig
		want string
	}{
		{
			name: "production",
			cfg: &StoredConfig{
				Subdomain:   "abc123def456ghi789jkl0123",
				RelayServer: "cloud.pockode.com",
			},
			want: "wss://abc123def456ghi789jkl0123.cloud.pockode.com/relay",
		},
		{
			name: "local development",
			cfg: &StoredConfig{
				Subdomain:   "dev123",
				RelayServer: "local.pockode.com",
			},
			want: "ws://dev123.local.pockode.com/relay",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildRelayWSURL(tt.cfg)
			if got != tt.want {
				t.Errorf("buildRelayWSURL() = %v, want %v", got, tt.want)
			}
		})
	}
}

// The uplink handshake is the only place compression is agreed, and its result
// is invisible afterwards — so it is checked here against a stand-in cloud
// configured the way the real one is.
//
// Offering no_context_takeover would let the cloud settle on it too, which
// costs interactive traffic all of its compression while bulk responses go on
// compressing normally. Nothing else in either repository would look broken.
func TestUplinkDialOptionsNegotiateContextTakeover(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
			// Mirrors the cloud's AcceptOptions (server/relay/ws.go in
			// pockode-cloud).
			CompressionMode: websocket.CompressionContextTakeover,
		})
		if err != nil {
			return
		}
		conn.Close(websocket.StatusNormalClosure, "")
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), uplinkDialOptions("secret-token"))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	if gotAuth != "Bearer secret-token" {
		t.Errorf("Authorization = %q, want %q", gotAuth, "Bearer secret-token")
	}
	got := resp.Header.Get("Sec-WebSocket-Extensions")
	if !strings.Contains(got, "permessage-deflate") {
		t.Fatalf("Sec-WebSocket-Extensions = %q, want permessage-deflate", got)
	}
	if strings.Contains(got, "no_context_takeover") {
		t.Errorf("Sec-WebSocket-Extensions = %q, want context takeover in both directions", got)
	}
}
