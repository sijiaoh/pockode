package ws

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
)

// Handler handles WebSocket connections for chat.
type Handler struct {
	token   string
	agent   agent.Agent
	workDir string
}

// NewHandler creates a new WebSocket handler.
func NewHandler(token string, ag agent.Agent, workDir string) *Handler {
	return &Handler{
		token:   token,
		agent:   ag,
		workDir: workDir,
	}
}

// ServeHTTP handles HTTP requests and upgrades to WebSocket.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Validate token from query parameter
	queryToken := r.URL.Query().Get("token")
	if queryToken == "" {
		http.Error(w, "Missing token", http.StatusUnauthorized)
		return
	}

	if subtle.ConstantTimeCompare([]byte(queryToken), []byte(h.token)) != 1 {
		http.Error(w, "Invalid token", http.StatusUnauthorized)
		return
	}

	// Accept WebSocket connection
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Allow all origins for development; restrict in production
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("Failed to accept websocket: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	h.handleConnection(r.Context(), conn)
}

// sessionState manages the state for a single WebSocket session.
type sessionState struct {
	mu     sync.Mutex
	cancel context.CancelFunc
}

func (s *sessionState) cancelCurrent() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
}

func (s *sessionState) setCancel(cancel context.CancelFunc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cancel != nil {
		s.cancel()
	}
	s.cancel = cancel
}

// handleConnection manages the WebSocket connection lifecycle.
func (h *Handler) handleConnection(ctx context.Context, conn *websocket.Conn) {
	log.Printf("handleConnection: new connection")
	session := &sessionState{}
	defer session.cancelCurrent()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			log.Printf("handleConnection: read error: %v", err)
			return
		}

		log.Printf("handleConnection: received: %s", string(data))

		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("handleConnection: unmarshal error: %v", err)
			h.sendError(ctx, conn, "", "Invalid message format")
			continue
		}

		log.Printf("handleConnection: parsed message type=%s, id=%s", msg.Type, msg.ID)

		switch msg.Type {
		case "message":
			msgCtx, cancel := context.WithCancel(ctx)
			session.setCancel(cancel)
			go h.handleMessage(msgCtx, conn, msg)

		case "cancel":
			session.cancelCurrent()

		default:
			h.sendError(ctx, conn, msg.ID, "Unknown message type")
		}
	}
}

// handleMessage processes a user message and streams the response.
func (h *Handler) handleMessage(ctx context.Context, conn *websocket.Conn, msg ClientMessage) {
	log.Printf("handleMessage: prompt=%q, workDir=%s", msg.Content, h.workDir)

	events, err := h.agent.Run(ctx, msg.Content, h.workDir)
	if err != nil {
		log.Printf("agent.Run error: %v", err)
		h.sendError(ctx, conn, msg.ID, err.Error())
		return
	}

	for event := range events {
		log.Printf("event: type=%s, content=%q, error=%q", event.Type, event.Content, event.Error)

		serverMsg := ServerMessage{
			Type:      string(event.Type),
			MessageID: msg.ID,
			Content:   event.Content,
			ToolName:  event.ToolName,
			ToolInput: event.ToolInput,
			Error:     event.Error,
		}

		if err := h.send(ctx, conn, serverMsg); err != nil {
			log.Printf("send error: %v", err)
			return
		}
	}
}

// send writes a message to the WebSocket connection.
func (h *Handler) send(ctx context.Context, conn *websocket.Conn, msg ServerMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

// sendError sends an error message to the client.
func (h *Handler) sendError(ctx context.Context, conn *websocket.Conn, msgID, errMsg string) {
	h.send(ctx, conn, ServerMessage{
		Type:      "error",
		MessageID: msgID,
		Error:     errMsg,
	})
}
