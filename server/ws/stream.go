package ws

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/sourcegraph/jsonrpc2"
)

// maxQueuedBytes bounds what a connection may have waiting behind the message
// being written; a message that would take it past this closes the connection
// instead. An empty queue accepts one message of any size, so none is too large
// to send.
//
// It bounds memory; catching a dead client is writeTimeout's job. Hence bytes,
// not messages: bursts are thousands of small deltas, which a healthy client on
// a slow link must be able to fall behind on, while a handful of file reads
// hold far more than any message count would suggest.
//
// 16 MiB is maxClientMessage, the most a client can make the server hold on the
// way in.
const maxQueuedBytes = 16 << 20 // 16 MiB

// writeTimeout bounds a single message write. It is the web client's
// RPC_TIMEOUT_MS: a client that has not taken a message in that long has
// already given up on whatever it was waiting for. It bounds the whole message,
// not progress through it, so a link too slow to carry one large message (a
// file read's reply) in that time is closed on too — by which time the client
// has stopped waiting for that reply anyway.
const writeTimeout = 30 * time.Second

var (
	errWriteQueueFull = errors.New("websocket write queue full")
	errStreamClosed   = errors.New("websocket stream closed")
)

// WebSocketStream adapts coder/websocket to jsonrpc2.ObjectStream.
// It is safe for concurrent use.
//
// Writes are queued and sent by a goroutine of the stream's own, so WriteObject
// never waits on the network and a client that stops reading cannot hold up
// delivery to other connections. Why, and when such a client is closed on, is
// in docs/code/websocket-rpc.md, "Outbound Delivery".
type WebSocketStream struct {
	conn           *websocket.Conn
	log            *slog.Logger
	writeTimeout   time.Duration
	maxQueuedBytes int
	// wake tells the writer the queue or the state changed. Buffered by one so
	// signalling never blocks and a signal sent while the writer is busy is not
	// lost.
	wake chan struct{}
	// done is closed when the writer exits, so that tests can check it does
	// not outlive its connection.
	done chan struct{}
	// Every write runs under writeCtx, so that abort ends the write in
	// progress once the stream gives up on the connection: cancelling never
	// blocks, unlike closing the connection (see discardLocked).
	writeCtx context.Context
	abort    context.CancelFunc

	queueMu     sync.Mutex // guards the fields below
	queue       [][]byte
	queuedBytes int
	closed      bool // no more messages are accepted
	flushing    bool // closed by Close: send what is queued, then close normally
}

// NewWebSocketStream creates a new WebSocketStream from a websocket connection
// and starts its writer. The writer exits once the stream is closed or a write
// fails; jsonrpc2 closes the stream whenever its connection ends.
func NewWebSocketStream(conn *websocket.Conn, log *slog.Logger) *WebSocketStream {
	return newWebSocketStream(conn, log, maxQueuedBytes, writeTimeout)
}

func newWebSocketStream(conn *websocket.Conn, log *slog.Logger, maxQueued int, timeout time.Duration) *WebSocketStream {
	writeCtx, abort := context.WithCancel(context.Background())
	s := &WebSocketStream{
		conn:           conn,
		log:            log,
		writeTimeout:   timeout,
		maxQueuedBytes: maxQueued,
		wake:           make(chan struct{}, 1),
		done:           make(chan struct{}),
		writeCtx:       writeCtx,
		abort:          abort,
	}
	go s.writeLoop()
	return s
}

// ReadObject reads a JSON object from the websocket connection.
func (s *WebSocketStream) ReadObject(v interface{}) error {
	_, data, err := s.conn.Read(context.Background())
	if err != nil {
		// Treat normal close frames as EOF so jsonrpc2 shuts down gracefully
		switch websocket.CloseStatus(err) {
		case websocket.StatusNormalClosure, websocket.StatusGoingAway:
			return io.EOF
		}
		return err
	}
	return json.Unmarshal(data, v)
}

// WriteObject queues a JSON object for writing. It never blocks on the
// network; a queue that would overflow closes the connection instead.
func (s *WebSocketStream) WriteObject(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}

	s.queueMu.Lock()
	if s.closed {
		s.queueMu.Unlock()
		return errStreamClosed
	}
	if len(s.queue) > 0 && s.queuedBytes+len(data) > s.maxQueuedBytes {
		queued := s.queuedBytes
		s.discardLocked()
		s.queueMu.Unlock()

		s.log.Warn("closing websocket: client is not keeping up", "queuedBytes", queued)
		s.signal()
		return errWriteQueueFull
	}
	s.queue = append(s.queue, data)
	s.queuedBytes += len(data)
	s.queueMu.Unlock()

	s.signal()
	return nil
}

// Close sends what is already queued and then closes the connection with a
// normal closure, so that a reply sent just before closing — an auth refusal —
// still reaches the client. It returns without waiting for either: jsonrpc2
// calls it while holding the lock every send takes.
func (s *WebSocketStream) Close() error {
	s.queueMu.Lock()
	if s.closed {
		s.queueMu.Unlock()
		return nil
	}
	s.closed = true
	s.flushing = true
	s.queueMu.Unlock()

	s.signal()
	return nil
}

// discardLocked gives up on the connection without flushing: there is no point
// sending more to a client that is not taking it. Refusing further messages
// keeps them from being accepted and silently lost before jsonrpc2 notices the
// connection is gone, and dropping the queue frees it now rather than when the
// stream is collected.
//
// Closing the connection is left to the writer. CloseNow can block: it waits
// for the read in progress to end, and on a connection relayed over a yamux
// stream closing does not end that read — only the peer's FIN does, or yamux's
// StreamCloseTimeout. Done from WriteObject, that would hold up the very caller
// the queue exists to keep moving.
func (s *WebSocketStream) discardLocked() {
	s.closed = true
	s.flushing = false
	s.queue = nil
	s.queuedBytes = 0
	s.abort()
}

func (s *WebSocketStream) signal() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *WebSocketStream) writeLoop() {
	defer close(s.done)
	for {
		data, ok := s.next()
		if !ok {
			return
		}
		s.write(data)
	}
}

// next waits for the next message to write. It reports false when there is
// none left to write, having closed the connection: normally if Close asked for
// that, at once if the stream gave up on it.
func (s *WebSocketStream) next() ([]byte, bool) {
	for {
		s.queueMu.Lock()
		if len(s.queue) > 0 {
			data := s.queue[0]
			s.queue[0] = nil
			s.queue = s.queue[1:]
			s.queuedBytes -= len(data)
			s.queueMu.Unlock()
			return data, true
		}
		closed, flushing := s.closed, s.flushing
		s.queueMu.Unlock()

		if flushing {
			if err := s.conn.Close(websocket.StatusNormalClosure, ""); err != nil {
				s.log.Debug("websocket close handshake failed", "error", err)
			}
			return nil, false
		}
		if closed {
			s.conn.CloseNow()
			return nil, false
		}
		<-s.wake
	}
}

// write sends one message, and on failure gives up on the connection.
func (s *WebSocketStream) write(data []byte) {
	ctx, cancel := context.WithTimeout(s.writeCtx, s.writeTimeout)
	defer cancel()
	err := s.conn.Write(ctx, websocket.MessageText, data)
	if err == nil {
		return
	}
	if errors.Is(err, context.DeadlineExceeded) {
		s.log.Warn("closing websocket: write timed out", "timeout", s.writeTimeout)
	} else {
		s.log.Debug("websocket write failed", "error", err)
	}
	s.queueMu.Lock()
	s.discardLocked()
	s.queueMu.Unlock()
}

// Ensure WebSocketStream implements ObjectStream
var _ jsonrpc2.ObjectStream = (*WebSocketStream)(nil)
