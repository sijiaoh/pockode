package ws

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/sourcegraph/jsonrpc2"
)

// RPCHandler handles JSON-RPC 2.0 over WebSocket.
type RPCHandler struct {
	token        string
	manager      *process.Manager
	devMode      bool
	sessionStore session.Store
}

// NewRPCHandler creates a new JSON-RPC handler.
func NewRPCHandler(token string, manager *process.Manager, devMode bool, store session.Store) *RPCHandler {
	return &RPCHandler{
		token:        token,
		manager:      manager,
		devMode:      devMode,
		sessionStore: store,
	}
}

func (h *RPCHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: h.devMode,
	})
	if err != nil {
		slog.Error("failed to accept websocket", "error", err)
		return
	}

	h.handleConnection(r.Context(), conn)
}

func (h *RPCHandler) handleConnection(ctx context.Context, wsConn *websocket.Conn) {
	connID := uuid.Must(uuid.NewV7()).String()
	log := slog.With("connId", connID)
	log.Info("new websocket connection")

	// Create ObjectStream adapter for coder/websocket
	stream := newWebSocketStream(wsConn)

	// Create connection state for tracking subscriptions
	state := &rpcConnState{
		subscribed: make(map[string]struct{}),
		manager:    h.manager,
		log:        log,
	}

	// Create handler that requires auth
	handler := &rpcMethodHandler{
		RPCHandler:    h,
		state:         state,
		log:           log,
		authenticated: false,
	}

	// Create JSON-RPC connection
	rpcConn := jsonrpc2.NewConn(ctx, stream, jsonrpc2.AsyncHandler(handler))
	state.setConn(rpcConn)

	// Wait for connection to close
	<-rpcConn.DisconnectNotify()

	// Cleanup: unsubscribe from all sessions
	state.cleanup()
	log.Info("connection closed", "subscriptions", len(state.subscribed))
}

// rpcConnState tracks per-connection state.
type rpcConnState struct {
	mu         sync.Mutex
	subscribed map[string]struct{}
	manager    *process.Manager
	conn       *jsonrpc2.Conn
	log        *slog.Logger
}

func (s *rpcConnState) setConn(conn *jsonrpc2.Conn) {
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
}

func (s *rpcConnState) subscribe(sessionID string, conn *jsonrpc2.Conn) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.subscribed[sessionID]; !exists {
		s.manager.SubscribeRPC(sessionID, conn)
		s.subscribed[sessionID] = struct{}{}
	}
}

func (s *rpcConnState) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	conn := s.conn
	for sessionID := range s.subscribed {
		s.manager.UnsubscribeRPC(sessionID, conn)
		s.log.Debug("unsubscribed from session", "sessionId", sessionID)
	}
}

// rpcMethodHandler handles JSON-RPC method calls.
type rpcMethodHandler struct {
	*RPCHandler
	state         *rpcConnState
	log           *slog.Logger
	authenticated bool
	authMu        sync.Mutex
}

func (h *rpcMethodHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	h.log.Debug("received request", "method", req.Method, "id", req.ID)

	// Auth must be the first request
	if !h.isAuthenticated() {
		if req.Method != "auth" {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "first request must be auth")
			conn.Close()
			return
		}
		h.handleAuth(ctx, conn, req)
		return
	}

	// Dispatch to method handlers
	switch req.Method {
	case "chat.attach":
		h.handleAttach(ctx, conn, req)
	case "chat.message":
		h.handleMessage(ctx, conn, req)
	case "chat.interrupt":
		h.handleInterrupt(ctx, conn, req)
	case "chat.permission_response":
		h.handlePermissionResponse(ctx, conn, req)
	case "chat.question_response":
		h.handleQuestionResponse(ctx, conn, req)
	default:
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeMethodNotFound, "method not found: "+req.Method)
	}
}

func (h *rpcMethodHandler) isAuthenticated() bool {
	h.authMu.Lock()
	defer h.authMu.Unlock()
	return h.authenticated
}

func (h *rpcMethodHandler) setAuthenticated() {
	h.authMu.Lock()
	h.authenticated = true
	h.authMu.Unlock()
}

func (h *rpcMethodHandler) handleAuth(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AuthParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		conn.Close()
		return
	}

	if subtle.ConstantTimeCompare([]byte(params.Token), []byte(h.token)) != 1 {
		h.log.Warn("invalid auth token")
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "invalid token")
		conn.Close()
		return
	}

	h.setAuthenticated()
	h.log.Info("authenticated")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send auth response", "error", err)
	}
}

func (h *rpcMethodHandler) handleAttach(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AttachParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	// Verify session exists
	_, found, err := h.sessionStore.Get(params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get session")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	// Subscribe to session events
	h.state.subscribe(params.SessionID, conn)

	// Return whether process is running
	processRunning := h.manager.HasProcess(params.SessionID)
	result := rpc.AttachResult{ProcessRunning: processRunning}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send attach response", "error", err)
		return
	}

	log.Info("subscribed to session", "processRunning", processRunning)
}

func (h *rpcMethodHandler) handleMessage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.MessageParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	log.Info("received prompt", "length", len(params.Content))

	// Persist user message to history
	event := agent.MessageEvent{Content: params.Content}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(event)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	// Send message to agent
	if err := sess.SendMessage(params.Content); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send message response", "error", err)
	}
}

func (h *rpcMethodHandler) handleInterrupt(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.InterruptParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := sess.SendInterrupt(); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	log.Info("sent interrupt")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send interrupt response", "error", err)
	}
}

func (h *rpcMethodHandler) handlePermissionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.PermissionResponseParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	data := agent.PermissionRequestData{
		RequestID:             params.RequestID,
		ToolInput:             params.ToolInput,
		ToolUseID:             params.ToolUseID,
		PermissionSuggestions: params.PermissionSuggestions,
	}
	choice := parsePermissionChoice(params.Choice)

	if err := sess.SendPermissionResponse(data, choice); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist permission response to history
	permEvent := agent.PermissionResponseEvent{RequestID: params.RequestID, Choice: params.Choice}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(permEvent)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	log.Info("sent permission response", "choice", params.Choice)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send permission response", "error", err)
	}
}

func (h *rpcMethodHandler) handleQuestionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.QuestionResponseParams
	if err := json.Unmarshal(*req.Params, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	data := agent.QuestionRequestData{
		RequestID: params.RequestID,
		ToolUseID: params.ToolUseID,
	}

	if err := sess.SendQuestionResponse(data, params.Answers); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist question response to history
	qEvent := agent.QuestionResponseEvent{RequestID: params.RequestID, Answers: params.Answers}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(qEvent)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	log.Info("sent question response", "cancelled", params.Answers == nil)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send question response", "error", err)
	}
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

func (h *rpcMethodHandler) getOrCreateProcess(ctx context.Context, log *slog.Logger, sessionID string) (agent.Session, error) {
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

	// Mark as activated on first process creation
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

func (h *rpcMethodHandler) replyError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, code int64, message string) {
	err := &jsonrpc2.Error{
		Code:    code,
		Message: message,
	}
	if replyErr := conn.ReplyWithError(ctx, id, err); replyErr != nil {
		h.log.Error("failed to send error response", "error", replyErr)
	}
}

// webSocketStream adapts coder/websocket to jsonrpc2.ObjectStream.
type webSocketStream struct {
	conn *websocket.Conn
	mu   sync.Mutex // protects writes
}

func newWebSocketStream(conn *websocket.Conn) *webSocketStream {
	return &webSocketStream{conn: conn}
}

func (s *webSocketStream) ReadObject(v interface{}) error {
	_, data, err := s.conn.Read(context.Background())
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

func (s *webSocketStream) WriteObject(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.Write(context.Background(), websocket.MessageText, data)
}

func (s *webSocketStream) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "")
}

// Ensure webSocketStream implements ObjectStream
var _ jsonrpc2.ObjectStream = (*webSocketStream)(nil)
