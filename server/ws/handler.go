package ws

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/logger"
)

const (
	// promptLogMaxLen limits prompt length in logs for privacy.
	promptLogMaxLen = 50
)

// Handler handles WebSocket connections for chat.
type Handler struct {
	token   string
	agent   agent.Agent
	workDir string
	devMode bool
}

// NewHandler creates a new WebSocket handler.
func NewHandler(token string, ag agent.Agent, workDir string, devMode bool) *Handler {
	return &Handler{
		token:   token,
		agent:   ag,
		workDir: workDir,
		devMode: devMode,
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
		InsecureSkipVerify: h.devMode,
	})
	if err != nil {
		logger.Error("Failed to accept websocket: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	h.handleConnection(r.Context(), conn)
}

// connectionState holds the state for a WebSocket connection.
//
// # Design: Connection-Scoped Sessions
//
// Sessions are scoped to individual WebSocket connections, not global.
// Each connection maintains its own session map and Claude processes.
//
// Behavior:
//   - Same sessionID on different connections → separate Claude processes
//   - Page refresh → new connection → new process (conversation restored via --resume)
//   - Multiple tabs → independent processes, no cross-tab sync
//
// Trade-offs:
//   - Pro: Simple architecture, no cross-connection synchronization needed
//   - Pro: Each tab operates independently, predictable behavior
//   - Pro: Connection close cleanly terminates its processes
//   - Con: Same sessionID may run multiple concurrent processes (resource waste)
//   - Con: No real-time sync between tabs viewing the same session
//
// Future consideration: If real-time multi-device sync becomes important,
// promote sessions to Handler level with subscriber pattern for event broadcast.
type connectionState struct {
	mu       sync.Mutex
	sessions map[string]agent.Session // sessionID -> session

	// writeMu protects WebSocket writes from concurrent access
	writeMu sync.Mutex
}

// handleConnection manages the WebSocket connection lifecycle.
func (h *Handler) handleConnection(ctx context.Context, conn *websocket.Conn) {
	logger.Info("handleConnection: new connection")

	state := &connectionState{
		sessions: make(map[string]agent.Session),
	}

	// Cleanup all sessions on connection close
	defer func() {
		state.mu.Lock()
		for sessionID, sess := range state.sessions {
			logger.Info("handleConnection: closing session %s", sessionID)
			sess.Close()
		}
		state.mu.Unlock()
	}()

	// Main loop: read messages from client
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			logger.Debug("handleConnection: read error: %v", err)
			return
		}

		logger.Debug("handleConnection: received message (len=%d)", len(data))

		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			logger.Error("handleConnection: unmarshal error: %v", err)
			h.sendErrorWithLock(ctx, conn, state, "Invalid message format")
			continue
		}

		logger.Debug("handleConnection: parsed message type=%s, id=%s, sessionID=%s", msg.Type, msg.ID, msg.SessionID)

		switch msg.Type {
		case "message":
			if err := h.handleMessage(ctx, conn, msg, state); err != nil {
				logger.Error("handleConnection: handleMessage error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		case "cancel":
			if err := h.handleCancel(msg, state); err != nil {
				logger.Error("handleConnection: cancel error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		case "permission_response":
			if err := h.handlePermissionResponse(ctx, conn, msg, state); err != nil {
				logger.Error("handleConnection: permission response error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		default:
			h.sendErrorWithLock(ctx, conn, state, "Unknown message type")
		}
	}
}

// handleMessage processes a user message, creating or reusing a session as needed.
func (h *Handler) handleMessage(ctx context.Context, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	state.mu.Lock()
	sess, exists := state.sessions[msg.SessionID]
	state.mu.Unlock()

	if !exists {
		// Create new session (or resume conversation history if sessionID is provided).
		var err error
		sess, err = h.agent.Start(ctx, h.workDir, msg.SessionID)
		if err != nil {
			return err
		}

		state.mu.Lock()
		state.sessions[msg.SessionID] = sess
		state.mu.Unlock()

		// Start goroutine to stream events from this session.
		// Pass sess directly to avoid race when session is cancelled and recreated.
		go h.streamEvents(ctx, conn, msg.SessionID, sess, state)

		logger.Info("handleMessage: created session %s", msg.SessionID)
	}

	logger.Info("handleMessage: prompt=%q, sessionID=%s", logger.Truncate(msg.Content, promptLogMaxLen), msg.SessionID)

	return sess.SendMessage(msg.Content)
}

// handleCancel terminates a specific session.
func (h *Handler) handleCancel(msg ClientMessage, state *connectionState) error {
	state.mu.Lock()
	sess, exists := state.sessions[msg.SessionID]
	if !exists {
		state.mu.Unlock()
		return fmt.Errorf("session not found: %s", msg.SessionID)
	}
	delete(state.sessions, msg.SessionID)
	state.mu.Unlock()

	sess.Close()
	logger.Info("handleCancel: cancelled session %s", msg.SessionID)
	return nil
}

// handlePermissionResponse routes a permission response to the correct session.
func (h *Handler) handlePermissionResponse(ctx context.Context, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	state.mu.Lock()
	sess, exists := state.sessions[msg.SessionID]
	state.mu.Unlock()

	if !exists {
		return fmt.Errorf("session not found: %s", msg.SessionID)
	}

	return sess.SendPermissionResponse(msg.RequestID, msg.Allow)
}

// streamEvents reads events from the agent session and sends them to the client.
// It takes the session directly to avoid race conditions when session is cancelled
// and recreated with the same sessionID.
func (h *Handler) streamEvents(ctx context.Context, conn *websocket.Conn, sessionID string, sess agent.Session, state *connectionState) {
	for event := range sess.Events() {
		logger.Debug("streamEvents: sessionID=%s, type=%s", sessionID, event.Type)

		serverMsg := ServerMessage{
			Type:       string(event.Type),
			Content:    event.Content,
			ToolName:   event.ToolName,
			ToolInput:  event.ToolInput,
			ToolUseID:  event.ToolUseID,
			ToolResult: event.ToolResult,
			Error:      event.Error,
			SessionID:  event.SessionID,
			RequestID:  event.RequestID,
		}

		if err := h.sendWithLock(ctx, conn, state, serverMsg); err != nil {
			logger.Error("streamEvents: send error: %v", err)
			return
		}
	}

	logger.Info("streamEvents: session %s ended", sessionID)
}

// sendWithLock writes a message to the WebSocket connection with mutex protection.
func (h *Handler) sendWithLock(ctx context.Context, conn *websocket.Conn, state *connectionState, msg ServerMessage) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	state.writeMu.Lock()
	defer state.writeMu.Unlock()
	return conn.Write(ctx, websocket.MessageText, data)
}

// sendErrorWithLock sends an error message to the client with mutex protection.
func (h *Handler) sendErrorWithLock(ctx context.Context, conn *websocket.Conn, state *connectionState, errMsg string) error {
	return h.sendWithLock(ctx, conn, state, ServerMessage{
		Type:  "error",
		Error: errMsg,
	})
}
