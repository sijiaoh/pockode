package relay

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/logger"
	"github.com/sourcegraph/jsonrpc2"
)

// Keepalive detects half-open connections (e.g. after the host machine wakes
// from sleep) so runWithReconnect can re-establish the relay tunnel. Without an
// active ping, m.conn.Read blocks forever on a silently-dead connection and the
// reconnect logic never fires. Worst-case detection latency is roughly
// pingInterval + pingTimeout.
const (
	pingInterval = 15 * time.Second
	pingTimeout  = 10 * time.Second
)

type EnvelopeType string

const (
	EnvelopeTypeMessage      EnvelopeType = "message"
	EnvelopeTypeDisconnected EnvelopeType = "disconnected"
	EnvelopeTypeHTTPRequest  EnvelopeType = "http_request"
	EnvelopeTypeHTTPResponse EnvelopeType = "http_response"
)

type Envelope struct {
	ConnectionID string          `json:"connection_id"`
	Type         EnvelopeType    `json:"type,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	HTTPRequest  *HTTPRequest    `json:"http_request,omitempty"`
	HTTPResponse *HTTPResponse   `json:"http_response,omitempty"`
}

type Multiplexer struct {
	conn        *websocket.Conn
	streams     map[string]*VirtualStream
	streamsMu   sync.RWMutex
	writeMu     sync.Mutex
	newStreamCh chan<- *VirtualStream
	httpHandler *HTTPHandler
	log         *slog.Logger

	pingInterval time.Duration
	pingTimeout  time.Duration
}

func NewMultiplexer(conn *websocket.Conn, newStreamCh chan<- *VirtualStream, httpHandler *HTTPHandler, log *slog.Logger) *Multiplexer {
	return &Multiplexer{
		conn:         conn,
		streams:      make(map[string]*VirtualStream),
		newStreamCh:  newStreamCh,
		httpHandler:  httpHandler,
		log:          log,
		pingInterval: pingInterval,
		pingTimeout:  pingTimeout,
	}
}

func (m *Multiplexer) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	go m.keepAlive(ctx, cancel)

	for {
		_, data, err := m.conn.Read(ctx)
		if err != nil {
			return err
		}

		var env Envelope
		if err := json.Unmarshal(data, &env); err != nil {
			m.log.Warn("invalid envelope", "error", err)
			continue
		}

		switch env.Type {
		case EnvelopeTypeMessage:
			stream, isNew := m.getOrCreateStream(env.ConnectionID)
			if isNew {
				select {
				case m.newStreamCh <- stream:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if !stream.deliver(env.Payload) {
				m.closeStream(env.ConnectionID)
			}
		case EnvelopeTypeDisconnected:
			m.closeStream(env.ConnectionID)
		case EnvelopeTypeHTTPRequest:
			go m.handleHTTPRequest(ctx, env.ConnectionID, env.HTTPRequest)
		default:
			m.log.Warn("unknown envelope type", "type", env.Type)
		}
	}
}

// keepAlive pings the relay server on m.pingInterval and, on failure, cancels
// the read context so Run's blocked Read returns. Ping must run concurrently
// with that reader, which is what reads the pong. Canceling the context (which
// closes the underlying conn) is used instead of a graceful Close because a
// dead peer never completes the close handshake, leaving Read blocked.
func (m *Multiplexer) keepAlive(ctx context.Context, cancel context.CancelFunc) {
	ticker := time.NewTicker(m.pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, m.pingTimeout)
			err := m.conn.Ping(pingCtx)
			pingCancel()
			if err == nil {
				continue
			}
			if ctx.Err() != nil {
				return
			}
			m.log.Warn("relay keepalive ping failed, closing connection", "error", err)
			cancel()
			return
		}
	}
}

func (m *Multiplexer) getOrCreateStream(connectionID string) (*VirtualStream, bool) {
	m.streamsMu.Lock()
	defer m.streamsMu.Unlock()

	if stream, ok := m.streams[connectionID]; ok {
		return stream, false
	}

	stream := &VirtualStream{
		connectionID: connectionID,
		incoming:     make(chan json.RawMessage, 16),
		multiplexer:  m,
		log:          m.log.With("connectionId", connectionID),
	}
	m.streams[connectionID] = stream
	m.log.Info("new virtual stream", "connectionId", connectionID)
	return stream, true
}

func (m *Multiplexer) handleHTTPRequest(ctx context.Context, connectionID string, req *HTTPRequest) {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "http proxy request failed", "connectionId", connectionID)
		}
	}()

	if req == nil {
		m.log.Warn("nil http request", "connectionId", connectionID)
		return
	}

	resp := m.httpHandler.Handle(ctx, req)

	env := Envelope{
		ConnectionID: connectionID,
		Type:         EnvelopeTypeHTTPResponse,
		HTTPResponse: resp,
	}

	m.writeMu.Lock()
	defer m.writeMu.Unlock()

	envData, err := json.Marshal(env)
	if err != nil {
		m.log.Error("failed to marshal http response", "error", err)
		return
	}

	if err := m.conn.Write(ctx, websocket.MessageText, envData); err != nil {
		m.log.Error("failed to send http response", "error", err)
	}
}

func (m *Multiplexer) closeStream(connectionID string) {
	m.streamsMu.Lock()
	stream, ok := m.streams[connectionID]
	if ok {
		delete(m.streams, connectionID)
	}
	m.streamsMu.Unlock()

	if ok {
		close(stream.incoming)
		m.log.Info("virtual stream closed", "connectionId", connectionID)
	}
}

func (m *Multiplexer) send(connectionID string, payload interface{}) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	env := Envelope{
		ConnectionID: connectionID,
		Type:         EnvelopeTypeMessage,
		Payload:      data,
	}

	m.writeMu.Lock()
	defer m.writeMu.Unlock()

	envData, err := json.Marshal(env)
	if err != nil {
		return err
	}

	return m.conn.Write(context.Background(), websocket.MessageText, envData)
}

type VirtualStream struct {
	connectionID string
	incoming     chan json.RawMessage
	multiplexer  *Multiplexer
	log          *slog.Logger
}

func (s *VirtualStream) deliver(payload json.RawMessage) bool {
	select {
	case s.incoming <- payload:
		return true
	default:
		s.log.Error("message buffer full, closing stream")
		return false
	}
}

func (s *VirtualStream) ReadObject(v interface{}) error {
	msg, ok := <-s.incoming
	if !ok {
		return io.EOF
	}
	return json.Unmarshal(msg, v)
}

func (s *VirtualStream) WriteObject(v interface{}) error {
	return s.multiplexer.send(s.connectionID, v)
}

func (s *VirtualStream) Close() error {
	return nil
}

func (s *VirtualStream) ConnectionID() string {
	return s.connectionID
}

var _ jsonrpc2.ObjectStream = (*VirtualStream)(nil)
