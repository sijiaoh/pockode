package ws

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/hashicorp/yamux"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

// socketBuffer shrinks the kernel buffers between a test server and its
// client, so that a client that does not read blocks the server's write after a
// few messages rather than after the megabytes loopback buffers hold by
// default.
const socketBuffer = 64 << 10

// bigMessage fills socketBuffer by itself.
var bigMessage = strings.Repeat("x", 64<<10)

// streamCount is enough bigMessages to block a write to a client that does
// not read, while staying well under maxQueuedBytes.
const streamCount = 64

// dialTestStream connects a client to a fresh server and returns the server's
// end as a WebSocketStream built by newStream, and the client's raw end.
func dialTestStream(t *testing.T, newStream func(*websocket.Conn) *WebSocketStream) (*WebSocketStream, *websocket.Conn) {
	t.Helper()

	handler, accepted := acceptTestConn(t)
	server := httptest.NewUnstartedServer(handler)
	server.Config.ConnContext = func(ctx context.Context, c net.Conn) context.Context {
		if err := c.(*net.TCPConn).SetWriteBuffer(socketBuffer); err != nil {
			t.Errorf("shrink server send buffer: %v", err)
		}
		return ctx
	}
	server.Start()
	t.Cleanup(server.Close)

	client := dialStreamClient(t, "ws"+strings.TrimPrefix(server.URL, "http"), func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		return c, c.(*net.TCPConn).SetReadBuffer(socketBuffer)
	})

	stream := newStream(<-accepted)
	t.Cleanup(func() { stream.Close() })
	return stream, client
}

// dialRelayedTestStream is dialTestStream over a yamux stream, the way a
// relayed connection arrives. Unlike a socket, closing a yamux stream does not
// end a read in progress on it; only the peer's FIN does.
func dialRelayedTestStream(t *testing.T, newStream func(*websocket.Conn) *WebSocketStream) (*WebSocketStream, *websocket.Conn) {
	t.Helper()

	pockodeEnd, relayEnd := net.Pipe()
	pockodeSession, err := yamux.Client(pockodeEnd, nil)
	if err != nil {
		t.Fatalf("yamux client: %v", err)
	}
	relaySession, err := yamux.Server(relayEnd, nil)
	if err != nil {
		t.Fatalf("yamux server: %v", err)
	}
	t.Cleanup(func() {
		relaySession.Close()
		pockodeSession.Close()
	})

	handler, accepted := acceptTestConn(t)
	server := &http.Server{Handler: handler}
	go server.Serve(pockodeSession)
	t.Cleanup(func() { server.Close() })

	client := dialStreamClient(t, "ws://relayed", func(context.Context, string, string) (net.Conn, error) {
		return relaySession.Open()
	})

	stream := newStream(<-accepted)
	t.Cleanup(func() { stream.Close() })
	return stream, client
}

// dialStuckTestStream is dialTestStream with a server end whose writes never
// complete until it is closed. The returned channel is closed once the writer
// is stuck in one, so a test can act while a write is certainly in progress —
// which no client that merely stops reading can promise.
func dialStuckTestStream(t *testing.T, newStream func(*websocket.Conn) *WebSocketStream) (*WebSocketStream, <-chan struct{}) {
	t.Helper()

	handler, accepted := acceptTestConn(t)
	server := httptest.NewUnstartedServer(handler)
	conns := make(chan *stuckConn, 1)
	server.Listener = stuckListener{server.Listener, conns}
	server.Start()
	t.Cleanup(server.Close)

	dialStreamClient(t, "ws"+strings.TrimPrefix(server.URL, "http"), (&net.Dialer{}).DialContext)

	stream := newStream(<-accepted)
	t.Cleanup(func() { stream.Close() })
	conn := <-conns
	conn.armed.Store(true)
	return stream, conn.stuck
}

type stuckListener struct {
	net.Listener
	conns chan<- *stuckConn
}

func (l stuckListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	conn := &stuckConn{Conn: c, stuck: make(chan struct{}), closed: make(chan struct{})}
	l.conns <- conn
	return conn, nil
}

// stuckConn lets the handshake through, then, once armed, blocks every write
// until it is closed.
type stuckConn struct {
	net.Conn
	armed     atomic.Bool
	stuck     chan struct{}
	stuckOnce sync.Once
	closed    chan struct{}
	closeOnce sync.Once
}

func (c *stuckConn) Write(p []byte) (int, error) {
	if !c.armed.Load() {
		return c.Conn.Write(p)
	}
	c.stuckOnce.Do(func() { close(c.stuck) })
	<-c.closed
	return 0, net.ErrClosed
}

func (c *stuckConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return c.Conn.Close()
}

// acceptTestConn accepts with compression off, so that compression cannot
// shrink bigMessage back under the buffers.
func acceptTestConn(t *testing.T) (http.Handler, <-chan *websocket.Conn) {
	accepted := make(chan *websocket.Conn, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{CompressionMode: websocket.CompressionDisabled})
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		accepted <- conn
	}), accepted
}

func dialStreamClient(t *testing.T, url string, dial func(ctx context.Context, network, addr string) (net.Conn, error)) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	client, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
		HTTPClient:      &http.Client{Transport: &http.Transport{DialContext: dial}},
	})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	client.SetReadLimit(-1)
	t.Cleanup(func() { client.CloseNow() })
	return client
}

// noopHandler serves a jsonrpc2 connection the tests only send on.
var noopHandler = jsonrpc2.HandlerWithError(func(context.Context, *jsonrpc2.Conn, *jsonrpc2.Request) (any, error) {
	return nil, nil
})

func newDefaultStream(conn *websocket.Conn) *WebSocketStream {
	return NewWebSocketStream(conn, slog.Default())
}

func newTestStream(maxQueued int, timeout time.Duration) func(*websocket.Conn) *WebSocketStream {
	return func(conn *websocket.Conn) *WebSocketStream {
		return newWebSocketStream(conn, slog.Default(), maxQueued, timeout)
	}
}

// waitForReadError reports whether the stream's read side fails within d —
// how the rest of the server, jsonrpc2 included, learns a connection is gone.
func waitForReadError(stream *WebSocketStream, d time.Duration) bool {
	failed := make(chan struct{})
	go func() {
		var v any
		for stream.ReadObject(&v) == nil {
		}
		close(failed)
	}()
	select {
	case <-failed:
		return true
	case <-time.After(d):
		return false
	}
}

// waitForWriter reports whether the stream's writer goroutine exits within d.
func waitForWriter(stream *WebSocketStream, d time.Duration) bool {
	select {
	case <-stream.done:
		return true
	case <-time.After(d):
		return false
	}
}

func readString(t *testing.T, client *websocket.Conn) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	_, data, err := client.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var s string
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatalf("unmarshal %q: %v", data, err)
	}
	return s
}

func TestWebSocketStream_PreservesOrder(t *testing.T) {
	stream, client := dialTestStream(t, newDefaultStream)

	const n = 200
	for i := range n {
		if err := stream.WriteObject(strings.Repeat("m", i)); err != nil {
			t.Fatalf("write %d: %v", i, err)
		}
	}
	for i := range n {
		if got := readString(t, client); len(got) != i {
			t.Fatalf("message %d arrived as message of length %d", i, len(got))
		}
	}
}

// An auth refusal is replied to and then closed on at once; the reply must
// not be lost to the close.
func TestWebSocketStream_CloseFlushesQueuedMessages(t *testing.T) {
	stream, client := dialTestStream(t, newDefaultStream)

	for _, m := range []string{"a", "b", "c"} {
		if err := stream.WriteObject(m); err != nil {
			t.Fatalf("write %q: %v", m, err)
		}
	}
	stream.Close()

	for _, want := range []string{"a", "b", "c"} {
		if got := readString(t, client); got != want {
			t.Fatalf("got %q, want %q", got, want)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), opTimeout)
	defer cancel()
	_, _, err := client.Read(ctx)
	if status := websocket.CloseStatus(err); status != websocket.StatusNormalClosure {
		t.Fatalf("after the queued messages: err = %v, want a normal closure", err)
	}
	if err := stream.WriteObject("late"); err == nil {
		t.Fatal("WriteObject after Close succeeded")
	}
}

// The writer must not outlive its connection. A client that vanishes is the
// common case: nothing is being written, so only jsonrpc2 closing the stream
// on the failed read can end the writer.
func TestWebSocketStream_WriterExitsWhenClientVanishes(t *testing.T) {
	stream, client := dialTestStream(t, newDefaultStream)
	conn := jsonrpc2.NewConn(context.Background(), stream, noopHandler)

	client.CloseNow()

	select {
	case <-conn.DisconnectNotify():
	case <-time.After(opTimeout):
		t.Fatal("jsonrpc2 connection still open after the client vanished")
	}
	if !waitForWriter(stream, opTimeout) {
		t.Fatal("writer still running after the client vanished")
	}
}

// A file read's reply can be larger than the whole queue budget; it must
// still go out.
func TestWebSocketStream_SendsAMessageLargerThanTheQueue(t *testing.T) {
	stream, client := dialTestStream(t, newTestStream(1, writeTimeout))

	if err := stream.WriteObject(bigMessage); err != nil {
		t.Fatalf("write: %v", err)
	}
	if got := readString(t, client); got != bigMessage {
		t.Fatalf("got a message of length %d, want %d", len(got), len(bigMessage))
	}
}

func TestWebSocketStream_ClosesWhenQueueOverflows(t *testing.T) {
	// A write timeout far beyond the test, so only the overflow can close.
	stream, _ := dialTestStream(t, newTestStream(len(bigMessage)*4, time.Hour))

	var err error
	for range 10 * streamCount {
		if err = stream.WriteObject(bigMessage); err != nil {
			break
		}
	}
	if !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("writing to a client that does not read: err = %v, want %v", err, errWriteQueueFull)
	}
	if !waitForReadError(stream, opTimeout) {
		t.Fatal("connection still open after the queue overflowed")
	}
	if !waitForWriter(stream, opTimeout) {
		t.Fatal("writer still running after the queue overflowed")
	}
}

// The overflow has to end a write already in progress, or the connection would
// stay open — holding the message being written — for up to writeTimeout after
// the stream has given up on it.
func TestWebSocketStream_OverflowEndsTheWriteInProgress(t *testing.T) {
	// A write timeout far beyond the test, so only the overflow can close.
	stream, stuck := dialStuckTestStream(t, newTestStream(len(bigMessage), time.Hour))

	if err := stream.WriteObject("stuck"); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case <-stuck:
	case <-time.After(opTimeout):
		t.Fatal("writer never started writing")
	}
	if err := stream.WriteObject(bigMessage); err != nil {
		t.Fatalf("write into the empty queue: %v", err)
	}
	if err := stream.WriteObject(bigMessage); !errors.Is(err, errWriteQueueFull) {
		t.Fatalf("write past the queue: err = %v, want %v", err, errWriteQueueFull)
	}
	if !waitForReadError(stream, opTimeout) {
		t.Fatal("connection still open after the queue overflowed")
	}
	if !waitForWriter(stream, opTimeout) {
		t.Fatal("writer still running after the queue overflowed")
	}
}

// Giving up on a client must not wait on its connection. On a relayed one,
// closing waits for the read in progress — jsonrpc2 always has one — and only
// the peer can end that read.
func TestWebSocketStream_OverflowDoesNotWaitOnARelayedConnection(t *testing.T) {
	stream, _ := dialRelayedTestStream(t, newTestStream(len(bigMessage)*4, time.Hour))
	go func() {
		var v any
		stream.ReadObject(&v)
	}()

	overflowed := make(chan error, 1)
	go func() {
		var err error
		for range 10 * streamCount {
			if err = stream.WriteObject(bigMessage); err != nil {
				break
			}
		}
		overflowed <- err
	}()

	select {
	case err := <-overflowed:
		if !errors.Is(err, errWriteQueueFull) {
			t.Fatalf("writing to a client that does not read: err = %v, want %v", err, errWriteQueueFull)
		}
	case <-time.After(opTimeout):
		t.Fatal("WriteObject held up by closing the connection")
	}
}

func TestWebSocketStream_ClosesWhenWriteTimesOut(t *testing.T) {
	stream, _ := dialTestStream(t, newTestStream(maxQueuedBytes, 200*time.Millisecond))

	// The timeout may close the connection while this is still writing, which
	// refuses the rest; only an overflow would mean the test went wrong.
	for range streamCount {
		if err := stream.WriteObject(bigMessage); err != nil {
			if errors.Is(err, errWriteQueueFull) {
				t.Fatalf("queue overflowed; only the write timeout should close: %v", err)
			}
			break
		}
	}
	if !waitForReadError(stream, opTimeout) {
		t.Fatal("connection still open after a write timed out")
	}
	if !waitForWriter(stream, opTimeout) {
		t.Fatal("writer still running after a write timed out")
	}
	if err := stream.WriteObject("late"); err == nil {
		t.Fatal("WriteObject after a write timed out succeeded")
	}
}

// The case the stream's queue exists for: a watcher notifies its subscribers
// one after another, so a write that blocks on one client would hold up every
// other client behind it — for as long as the dead client's socket lasts.
// Bounded below writeTimeout: being held up only until the stalled write times
// out is still being held up.
func TestWebSocketStream_StalledClientDoesNotDelayOtherSubscribers(t *testing.T) {
	ctx := context.Background()

	watcher := watch.NewBaseWatcher()
	t.Cleanup(watcher.CancelAndWait)
	subscribe := func(id string) *websocket.Conn {
		stream, client := dialTestStream(t, newDefaultStream)
		conn := jsonrpc2.NewConn(ctx, stream, noopHandler)
		t.Cleanup(func() { conn.Close() })
		if err := watcher.AddSubscription(&watch.Subscription{ID: id, Notifier: NewJSONRPCNotifier(conn)}); err != nil {
			t.Fatalf("subscribe %s: %v", id, err)
		}
		return client
	}
	subscribe("stalled") // never read from
	healthy := subscribe("healthy")

	received := make(chan error, 1)
	go func() {
		for i := range streamCount {
			readCtx, cancel := context.WithTimeout(ctx, opTimeout)
			_, _, err := healthy.Read(readCtx)
			cancel()
			if err != nil {
				received <- fmt.Errorf("notification %d: %w", i, err)
				return
			}
		}
		received <- nil
	}()

	notified := make(chan struct{})
	go func() {
		for range streamCount {
			watcher.NotifyAll("test.changed", func(*watch.Subscription) any { return bigMessage })
		}
		close(notified)
	}()

	select {
	case <-notified:
	case <-time.After(writeTimeout / 2):
		t.Fatal("notifying was held up by the client that does not read")
	}
	if err := <-received; err != nil {
		t.Fatalf("healthy subscriber: %v", err)
	}
}
