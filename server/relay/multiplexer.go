package relay

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"sync"

	"github.com/coder/websocket"
	"github.com/sourcegraph/jsonrpc2"
)

// Envelope wraps JSON-RPC messages for multiplexing over a single WebSocket.
// Multiple client connections are multiplexed by connection_id.
// Type "disconnected" signals that a client has disconnected.
type Envelope struct {
	ConnectionID string          `json:"connection_id"`
	Type         string          `json:"type,omitempty"`
	Payload      json.RawMessage `json:"payload,omitempty"`
}

type Multiplexer struct {
	conn        *websocket.Conn
	streams     map[string]*VirtualStream
	streamsMu   sync.RWMutex
	writeMu     sync.Mutex
	newStreamCh chan<- *VirtualStream
	log         *slog.Logger
}

func NewMultiplexer(conn *websocket.Conn, newStreamCh chan<- *VirtualStream, log *slog.Logger) *Multiplexer {
	return &Multiplexer{
		conn:        conn,
		streams:     make(map[string]*VirtualStream),
		newStreamCh: newStreamCh,
		log:         log,
	}
}

func (m *Multiplexer) Run(ctx context.Context) error {
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
		case "disconnected":
			m.closeStream(env.ConnectionID)
		default:
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

// VirtualStream abstracts a single client connection multiplexed over a shared
// relay WebSocket. The relay uses connection_id to distinguish clients, but
// VirtualStream hides this, presenting each client as an independent stream.
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
