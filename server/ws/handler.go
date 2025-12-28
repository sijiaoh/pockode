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
	"github.com/pockode/server/session"
)

const (
	// promptLogMaxLen limits prompt length in logs for privacy.
	promptLogMaxLen = 50
)

// Handler handles WebSocket connections for chat.
type Handler struct {
	token        string
	agent        agent.Agent
	workDir      string
	devMode      bool
	sessionStore session.Store
}

// NewHandler creates a new WebSocket handler.
func NewHandler(token string, ag agent.Agent, workDir string, devMode bool, store session.Store) *Handler {
	return &Handler{
		token:        token,
		agent:        ag,
		workDir:      workDir,
		devMode:      devMode,
		sessionStore: store,
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

// connectionState holds agent processes for a single WebSocket connection.
// Agent processes are connection-scoped; session metadata lives in sessionStore.
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

		logger.Debug("handleConnection: parsed message type=%s, sessionID=%s", msg.Type, msg.SessionID)

		switch msg.Type {
		case "message":
			if err := h.handleMessage(ctx, conn, msg, state); err != nil {
				logger.Error("handleConnection: handleMessage error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		case "interrupt":
			if err := h.handleInterrupt(msg, state); err != nil {
				logger.Error("handleConnection: interrupt error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		case "permission_response":
			if err := h.handlePermissionResponse(ctx, conn, msg, state); err != nil {
				logger.Error("handleConnection: permission response error: %v", err)
				h.sendErrorWithLock(ctx, conn, state, err.Error())
			}

		case "question_response":
			if err := h.handleQuestionResponse(ctx, conn, msg, state); err != nil {
				logger.Error("handleConnection: question response error: %v", err)
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
		// Check if session is activated (has been used before)
		meta, found, err := h.sessionStore.Get(msg.SessionID)
		if err != nil {
			return fmt.Errorf("failed to get session: %w", err)
		}
		if !found {
			return fmt.Errorf("session not found: %s", msg.SessionID)
		}

		resume := meta.Activated

		sess, err = h.agent.Start(ctx, h.workDir, msg.SessionID, resume)
		if err != nil {
			return err
		}

		state.mu.Lock()
		state.sessions[msg.SessionID] = sess
		state.mu.Unlock()

		// Mark session as activated on first use
		if !resume {
			if err := h.sessionStore.Activate(msg.SessionID); err != nil {
				logger.Error("handleMessage: failed to activate session: %v", err)
			}
		}

		// Start goroutine to stream events from this session.
		go h.streamEvents(ctx, conn, msg.SessionID, sess, state)

		logger.Info("handleMessage: started session %s (resume=%v)", msg.SessionID, resume)
	}

	logger.Info("handleMessage: prompt=%q, sessionID=%s", logger.Truncate(msg.Content, promptLogMaxLen), msg.SessionID)

	// Persist user message to history
	if err := h.sessionStore.AppendToHistory(msg.SessionID, msg); err != nil {
		logger.Error("handleMessage: failed to append to history: %v", err)
	}

	return sess.SendMessage(msg.Content)
}

// handleInterrupt sends an interrupt signal to stop the current task.
// This is a soft stop that preserves the session for future messages.
func (h *Handler) handleInterrupt(msg ClientMessage, state *connectionState) error {
	state.mu.Lock()
	sess, exists := state.sessions[msg.SessionID]
	state.mu.Unlock()

	if !exists {
		return fmt.Errorf("session not found: %s", msg.SessionID)
	}

	if err := sess.SendInterrupt(); err != nil {
		return fmt.Errorf("failed to send interrupt: %w", err)
	}

	logger.Info("handleInterrupt: sent interrupt to session %s", msg.SessionID)
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

	choice := parsePermissionChoice(msg.Choice)
	return sess.SendPermissionResponse(msg.RequestID, choice)
}

// handleQuestionResponse routes a question response to the correct session.
// If msg.Answers is nil, the question is cancelled.
func (h *Handler) handleQuestionResponse(ctx context.Context, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	state.mu.Lock()
	sess, exists := state.sessions[msg.SessionID]
	state.mu.Unlock()

	if !exists {
		return fmt.Errorf("session not found: %s", msg.SessionID)
	}

	return sess.SendQuestionResponse(msg.RequestID, msg.Answers)
}

// parsePermissionChoice converts a string choice to PermissionChoice enum.
func parsePermissionChoice(choice string) agent.PermissionChoice {
	switch choice {
	case "allow":
		return agent.PermissionAllow
	case "always_allow":
		return agent.PermissionAlwaysAllow
	default:
		return agent.PermissionDeny
	}
}

// streamEvents reads events from the agent session and sends them to the client.
func (h *Handler) streamEvents(ctx context.Context, conn *websocket.Conn, sessionID string, sess agent.Session, state *connectionState) {
	for event := range sess.Events() {
		logger.Debug("streamEvents: sessionID=%s, type=%s", sessionID, event.Type)

		serverMsg := ServerMessage{
			Type:                  string(event.Type),
			SessionID:             sessionID,
			Content:               event.Content,
			ToolName:              event.ToolName,
			ToolInput:             event.ToolInput,
			ToolUseID:             event.ToolUseID,
			ToolResult:            event.ToolResult,
			Error:                 event.Error,
			RequestID:             event.RequestID,
			PermissionSuggestions: event.PermissionSuggestions,
			Questions:             event.Questions,
		}

		// Persist event to history
		if err := h.sessionStore.AppendToHistory(sessionID, serverMsg); err != nil {
			logger.Error("streamEvents: failed to append to history: %v", err)
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
