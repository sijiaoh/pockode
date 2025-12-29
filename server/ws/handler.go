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

// connectionState tracks attached sessions for a single WebSocket connection.
// Sessions are globally managed; this only tracks which sessions this connection subscribes to.
type connectionState struct {
	attached map[string]*process.Entry // sessionID -> entry
}

func (h *Handler) handleConnection(ctx context.Context, conn *websocket.Conn) {
	connLog := slog.With("connId", uuid.Must(uuid.NewV7()).String())
	connLog.Info("new websocket connection")

	state := &connectionState{
		attached: make(map[string]*process.Entry),
	}
	defer func() {
		// Detach all sessions (but keep processes running)
		for sessionID, entry := range state.attached {
			entry.Detach(conn)
			connLog.Debug("detached session", "sessionId", sessionID)
		}
		connLog.Info("connection closed", "attachedSessions", len(state.attached))
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
			if _, err := h.getOrCreateSession(ctx, log, conn, msg.SessionID, state); err != nil {
				log.Error("attach error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "message":
			if err := h.handleMessage(ctx, log, conn, msg, state); err != nil {
				log.Error("handleMessage error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "interrupt":
			if err := h.handleInterrupt(ctx, log, conn, msg, state); err != nil {
				log.Error("interrupt error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "permission_response":
			if err := h.handlePermissionResponse(ctx, log, conn, msg, state); err != nil {
				log.Error("permission response error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		case "question_response":
			if err := h.handleQuestionResponse(ctx, log, conn, msg, state); err != nil {
				log.Error("question response error", "error", err)
				h.sendError(ctx, conn, err.Error())
			}

		default:
			h.sendError(ctx, conn, "Unknown message type")
		}
	}
}

// getOrCreateSession gets or creates a session and attaches this connection.
func (h *Handler) getOrCreateSession(ctx context.Context, log *slog.Logger, conn *websocket.Conn, sessionID string, state *connectionState) (agent.Session, error) {
	if entry, exists := state.attached[sessionID]; exists {
		h.manager.Touch(sessionID)
		return entry.Session(), nil
	}

	meta, found, err := h.sessionStore.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}

	resume := meta.Activated

	entry, created, err := h.manager.GetOrCreate(ctx, sessionID, resume)
	if err != nil {
		return nil, err
	}

	entry.Attach(conn)
	state.attached[sessionID] = entry

	// Mark as activated on first message to enable resume on reconnect
	if created && !resume {
		if err := h.sessionStore.Activate(ctx, sessionID); err != nil {
			log.Error("failed to activate session", "error", err)
		}
	}

	log.Info("attached to session", "resume", resume, "created", created)

	return entry.Session(), nil
}

func (h *Handler) handleMessage(ctx context.Context, log *slog.Logger, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	sess, err := h.getOrCreateSession(ctx, log, conn, msg.SessionID, state)
	if err != nil {
		return err
	}

	log.Info("received prompt", "length", len(msg.Content))

	if err := h.sessionStore.AppendToHistory(ctx, msg.SessionID, msg); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	return sess.SendMessage(msg.Content)
}

// Soft stop that preserves the session for future messages.
func (h *Handler) handleInterrupt(ctx context.Context, log *slog.Logger, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	sess, err := h.getOrCreateSession(ctx, log, conn, msg.SessionID, state)
	if err != nil {
		return err
	}

	if err := sess.SendInterrupt(); err != nil {
		return fmt.Errorf("failed to send interrupt: %w", err)
	}

	log.Info("sent interrupt")
	return nil
}

func (h *Handler) handlePermissionResponse(ctx context.Context, log *slog.Logger, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	sess, err := h.getOrCreateSession(ctx, log, conn, msg.SessionID, state)
	if err != nil {
		return err
	}

	if err := h.sessionStore.AppendToHistory(ctx, msg.SessionID, msg); err != nil {
		log.Error("failed to append permission_response to history", "error", err)
	}

	choice := parsePermissionChoice(msg.Choice)
	return sess.SendPermissionResponse(msg.RequestID, choice)
}

func (h *Handler) handleQuestionResponse(ctx context.Context, log *slog.Logger, conn *websocket.Conn, msg ClientMessage, state *connectionState) error {
	sess, err := h.getOrCreateSession(ctx, log, conn, msg.SessionID, state)
	if err != nil {
		return err
	}

	return sess.SendQuestionResponse(msg.RequestID, msg.Answers)
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
