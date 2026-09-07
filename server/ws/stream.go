package ws

import (
	"context"
	"encoding/json"
	"io"
	"sync"

	"github.com/coder/websocket"
	"github.com/sourcegraph/jsonrpc2"
)

// WebSocketStream adapts coder/websocket to jsonrpc2.ObjectStream.
// It is safe for concurrent use.
type WebSocketStream struct {
	conn *websocket.Conn
	mu   sync.Mutex // protects writes
}

// NewWebSocketStream creates a new WebSocketStream from a websocket connection.
func NewWebSocketStream(conn *websocket.Conn) *WebSocketStream {
	return &WebSocketStream{conn: conn}
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

// WriteObject writes a JSON object to the websocket connection.
func (s *WebSocketStream) WriteObject(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Write(context.Background(), websocket.MessageText, data)
}

// Close closes the websocket connection with a normal closure status.
func (s *WebSocketStream) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "")
}

// Ensure WebSocketStream implements ObjectStream
var _ jsonrpc2.ObjectStream = (*WebSocketStream)(nil)
