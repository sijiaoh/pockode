package relay

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
)

// startTestTunnel runs the pockode end of a tunnel over an in-memory pipe and
// returns a client that reaches handler exactly the way the relay does: one
// yamux stream per request.
func startTestTunnel(t *testing.T, handler http.Handler) *http.Client {
	t.Helper()

	pockodeSide, relaySide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = serveTunnel(ctx, pockodeSide, handler, testLogger())
	}()

	relayConfig := yamux.DefaultConfig()
	relayConfig.LogOutput = io.Discard
	session, err := yamux.Server(relaySide, relayConfig)
	if err != nil {
		cancel()
		t.Fatalf("start yamux server: %v", err)
	}

	t.Cleanup(func() {
		cancel()
		_ = session.Close()
		_ = relaySide.Close()
		<-done
	})

	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(context.Context, string, string) (net.Conn, error) {
				return session.Open()
			},
			DisableKeepAlives: true,
		},
	}
}

func TestServeTunnelServesHandlerOnEveryStream(t *testing.T) {
	client := startTestTunnel(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("served " + r.URL.Path))
	}))

	for _, path := range []string{"/first", "/second", "/third"} {
		resp, err := client.Get("http://pockode.invalid" + path)
		if err != nil {
			t.Fatalf("get %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK || string(body) != "served "+path {
			t.Errorf("%s = %d %q, want 200 %q", path, resp.StatusCode, body, "served "+path)
		}
	}
}

func TestServeTunnelRelaysWebSocketUpgrade(t *testing.T) {
	client := startTestTunnel(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		typ, msg, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		_ = conn.Write(r.Context(), typ, append([]byte("echo:"), msg...))
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws://pockode.invalid/ws", &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		t.Fatalf("dial over tunnel: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if string(got) != "echo:ping" {
		t.Errorf("response = %q, want %q", got, "echo:ping")
	}
}

// A stalled stream must not stop the tunnel from serving other requests: this
// is the head-of-line blocking the old envelope protocol could not avoid.
func TestServeTunnelInteractiveRequestSurvivesStalledTransfer(t *testing.T) {
	const largeSize = 8 << 20

	mux := http.NewServeMux()
	mux.HandleFunc("/large", func(w http.ResponseWriter, r *http.Request) {
		chunk := make([]byte, 64<<10)
		for written := 0; written < largeSize; written += len(chunk) {
			if _, err := w.Write(chunk); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/small", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("pong"))
	})
	client := startTestTunnel(t, mux)

	large, err := client.Get("http://pockode.invalid/large")
	if err != nil {
		t.Fatalf("start large transfer: %v", err)
	}
	defer large.Body.Close()

	// Read one byte to prove the transfer is under way, then stop consuming so
	// flow control wedges the stream with it still open.
	if _, err := io.ReadFull(large.Body, make([]byte, 1)); err != nil {
		t.Fatalf("read first byte: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://pockode.invalid/small", nil)
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	small, err := client.Do(req)
	if err != nil {
		t.Fatalf("interactive request behind a stalled transfer: %v", err)
	}
	defer small.Body.Close()
	body, _ := io.ReadAll(small.Body)
	if string(body) != "pong" {
		t.Errorf("interactive response = %q, want %q", body, "pong")
	}

	if n, err := io.Copy(io.Discard, large.Body); err != nil || n != largeSize-1 {
		t.Errorf("draining the stalled transfer delivered %d more bytes (err %v), want %d", n, err, largeSize-1)
	}
}

func TestServeTunnelReturnsWhenSessionEnds(t *testing.T) {
	pockodeSide, relaySide := net.Pipe()

	errCh := make(chan error, 1)
	go func() {
		errCh <- serveTunnel(context.Background(), pockodeSide, http.NotFoundHandler(), testLogger())
	}()

	_ = relaySide.Close()

	select {
	case <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("serveTunnel did not return after the session ended")
	}
}
