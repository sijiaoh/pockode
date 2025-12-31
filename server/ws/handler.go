package ws

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

type Handler struct {
	token        string
	manager      *process.Manager
	devMode      bool
	sessionStore session.Store
}

func NewHandler(token string, manager *process.Manager, devMode bool, store session.Store) *Handler {
	return &Handler{
		token:        token,
		manager:      manager,
		devMode:      devMode,
		sessionStore: store,
	}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	queryToken := r.URL.Query().Get("token")
	if queryToken == "" {
		http.Error(w, "Missing token", http.StatusUnauthorized)
		return
	}

	if subtle.ConstantTimeCompare([]byte(queryToken), []byte(h.token)) != 1 {
		http.Error(w, "Invalid token", http.StatusUnauthorized)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: h.devMode,
	})
	if err != nil {
		slog.Error("failed to accept websocket", "error", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	h.handleConnection(r.Context(), conn)
}

// connectionState tracks which sessions this WebSocket connection is subscribed to.
// This duplicates information in Manager.subs for O(1) lookup per connection.
// Must be kept in sync: add to both on Subscribe, remove from both on Unsubscribe.
type connectionState struct {
	subscribed map[string]struct{}
}

func (h *Handler) handleConnection(ctx context.Context, conn *websocket.Conn) {
	connLog := slog.With("connId", uuid.Must(uuid.NewV7()).String())
	connLog.Info("new websocket connection")

	state := &connectionState{
		subscribed: make(map[string]struct{}),
	}
	defer func() {
		// Unsubscribe from all sessions (processes keep running)
		for sessionID := range state.subscribed {
			h.manager.Unsubscribe(sessionID, conn)
			connLog.Debug("unsubscribed from session", "sessionId", sessionID)
		}
		connLog.Info("connection closed", "subscriptions", len(state.subscribed))
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			connLog.Debug("websocket read error", "error", err)
			return
		}

		connLog.Debug("received message", "length", len(data))

		var msg ClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			connLog.Error("failed to unmarshal message", "error", err)
			h.sendError(ctx, conn, "Invalid message format")
			continue
		}

		log := connLog.With("sessionId", msg.SessionID)
		log.Debug("parsed message", "type", msg.Type)

		switch msg.Type {
		case "attach":
			if err := h.handleAttach(ctx, log, conn, msg.SessionID, state); err != nil {
				log.Error("attach error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "message":
			if err := h.handleMessage(ctx, log, msg); err != nil {
				log.Error("handleMessage error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "interrupt":
			if err := h.handleInterrupt(ctx, log, msg); err != nil {
				log.Error("interrupt error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "permission_response":
			if err := h.handlePermissionResponse(ctx, log, msg); err != nil {
				log.Error("permission response error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "question_response":
			if err := h.handleQuestionResponse(ctx, log, msg); err != nil {
				log.Error("question response error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		default:
			h.sendError(ctx, conn, "Unknown message type")
		}
	}
}

// handleAttach subscribes this connection to a session's events.
// It does NOT start a process - that only happens when a message is sent.
// Responds with attach_response indicating whether a process is currently running.
func (h *Handler) handleAttach(ctx context.Context, log *slog.Logger, conn *websocket.Conn, sessionID string, state *connectionState) error {
	// Verify session exists in store
	_, found, err := h.sessionStore.Get(sessionID)
	if err != nil {
		return fmt.Errorf("failed to get session: %w", err)
	}
	if !found {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	// Subscribe to session events (idempotent)
	if _, exists := state.subscribed[sessionID]; !exists {
		h.manager.Subscribe(sessionID, conn)
		state.subscribed[sessionID] = struct{}{}
	}

	// Tell client whether a process is running
	processRunning := h.manager.HasProcess(sessionID)
	if err := h.sendAttachResponse(ctx, conn, sessionID, processRunning); err != nil {
		return fmt.Errorf("failed to send attach response: %w", err)
	}

	log.Info("subscribed to session", "processRunning", processRunning)
	return nil
}

// getOrCreateProcess returns an existing process or creates a new one.
func (h *Handler) getOrCreateProcess(ctx context.Context, log *slog.Logger, sessionID string) (agent.Session, error) {
	meta, found, err := h.sessionStore.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}

	resume := meta.Activated

	proc, created, err := h.manager.GetOrCreateProcess(ctx, sessionID, resume)
	if err != nil {
		return nil, err
	}

	// Mark as activated on first process creation to enable resume on reconnect
	if created && !resume {
		if err := h.sessionStore.Activate(ctx, sessionID); err != nil {
			log.Error("failed to activate session", "error", err)
		}
	}

	if created {
		log.Info("process created", "resume", resume)
	}

	return proc.AgentSession(), nil
}

func (h *Handler) handleMessage(ctx context.Context, log *slog.Logger, msg ClientMessage) error {
	sess, err := h.getOrCreateProcess(ctx, log, msg.SessionID)
	if err != nil {
		return err
	}

	log.Info("received prompt", "length", len(msg.Content))

	if err := h.sessionStore.AppendToHistory(ctx, msg.SessionID, msg); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	return sess.SendMessage(msg.Content)
}

// handleInterrupt sends a soft stop signal that preserves the session for future messages.
func (h *Handler) handleInterrupt(ctx context.Context, log *slog.Logger, msg ClientMessage) error {
	sess, err := h.getOrCreateProcess(ctx, log, msg.SessionID)
	if err != nil {
		return err
	}

	if err := sess.SendInterrupt(); err != nil {
		return fmt.Errorf("failed to send interrupt: %w", err)
	}

	log.Info("sent interrupt")
	return nil
}

func (h *Handler) handlePermissionResponse(ctx context.Context, log *slog.Logger, msg ClientMessage) error {
	sess, err := h.getOrCreateProcess(ctx, log, msg.SessionID)
	if err != nil {
		return err
	}

	data := agent.PermissionRequestData{
		RequestID:             msg.RequestID,
		ToolInput:             msg.ToolInput,
		ToolUseID:             msg.ToolUseID,
		PermissionSuggestions: msg.PermissionSuggestions,
	}
	if err := sess.SendPermissionResponse(data, parsePermissionChoice(msg.Choice)); err != nil {
		return err
	}

	if err := h.sessionStore.AppendToHistory(ctx, msg.SessionID, msg); err != nil {
		log.Error("failed to append permission_response to history", "error", err)
	}
	return nil
}

func (h *Handler) handleQuestionResponse(ctx context.Context, log *slog.Logger, msg ClientMessage) error {
	sess, err := h.getOrCreateProcess(ctx, log, msg.SessionID)
	if err != nil {
		return err
	}

	data := agent.QuestionRequestData{
		RequestID: msg.RequestID,
		ToolUseID: msg.ToolUseID,
	}
	if err := sess.SendQuestionResponse(data, msg.Answers); err != nil {
		return err
	}

	if err := h.sessionStore.AppendToHistory(ctx, msg.SessionID, msg); err != nil {
		log.Error("failed to append question_response to history", "error", err)
	}
	return nil
}

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

func (h *Handler) sendAttachResponse(ctx context.Context, conn *websocket.Conn, sessionID string, processRunning bool) error {
	data, err := json.Marshal(ServerMessage{
		Type:           "attach_response",
		SessionID:      sessionID,
		ProcessRunning: processRunning,
	})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func (h *Handler) sendError(ctx context.Context, conn *websocket.Conn, errMsg string) error {
	data, err := json.Marshal(ServerMessage{
		Type:  "error",
		Error: errMsg,
	})
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}
