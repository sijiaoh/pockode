package ws

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pockode/server/command"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/process"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/watch"
	"github.com/sourcegraph/jsonrpc2"
)

// RPCHandler handles JSON-RPC 2.0 over WebSocket.
type RPCHandler struct {
	token        string
	version      string
	manager      *process.Manager
	devMode      bool
	sessionStore session.Store
	commandStore *command.Store
	workDir      string
	watcher      *watch.FSWatcher
	gitWatcher   *watch.GitWatcher
}

func NewRPCHandler(token, version string, manager *process.Manager, devMode bool, sessionStore session.Store, commandStore *command.Store, workDir string, watcher *watch.FSWatcher, gitWatcher *watch.GitWatcher) *RPCHandler {
	return &RPCHandler{
		token:        token,
		version:      version,
		manager:      manager,
		devMode:      devMode,
		sessionStore: sessionStore,
		commandStore: commandStore,
		workDir:      workDir,
		watcher:      watcher,
		gitWatcher:   gitWatcher,
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
	stream := newWebSocketStream(wsConn)
	connID := uuid.Must(uuid.NewV7()).String()
	h.HandleStream(ctx, stream, connID)
}

func (h *RPCHandler) HandleStream(ctx context.Context, stream jsonrpc2.ObjectStream, connID string) {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "websocket connection crashed", "connId", connID)
		}
	}()

	log := slog.With("connId", connID)
	log.Info("new connection")

	state := &rpcConnState{
		connID:     connID,
		subscribed: make(map[string]struct{}),
		manager:    h.manager,
		watcher:    h.watcher,
		gitWatcher: h.gitWatcher,
		log:        log,
	}

	handler := &rpcMethodHandler{
		RPCHandler:    h,
		state:         state,
		log:           log,
		authenticated: false,
	}

	rpcConn := jsonrpc2.NewConn(ctx, stream, jsonrpc2.AsyncHandler(handler))
	state.setConn(rpcConn)

	<-rpcConn.DisconnectNotify()

	state.cleanup()
	log.Info("connection closed", "subscriptions", len(state.subscribed))
}

// rpcConnState tracks per-connection state.
type rpcConnState struct {
	mu         sync.Mutex
	connID     string
	subscribed map[string]struct{}
	manager    *process.Manager
	watcher    *watch.FSWatcher
	gitWatcher *watch.GitWatcher
	conn       *jsonrpc2.Conn
	log        *slog.Logger
}

func (s *rpcConnState) getConnID() string {
	return s.connID
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

	// Clean up watch subscriptions
	s.watcher.CleanupConnection(s.connID)
	s.gitWatcher.CleanupConnection(s.connID)
}

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
	// chat namespace
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
	// session namespace
	case "session.list":
		h.handleSessionList(ctx, conn, req)
	case "session.create":
		h.handleSessionCreate(ctx, conn, req)
	case "session.delete":
		h.handleSessionDelete(ctx, conn, req)
	case "session.update_title":
		h.handleSessionUpdateTitle(ctx, conn, req)
	case "session.get_history":
		h.handleSessionGetHistory(ctx, conn, req)
	// file namespace
	case "file.get":
		h.handleFileGet(ctx, conn, req)
	// git namespace
	case "git.status":
		h.handleGitStatus(ctx, conn, req)
	case "git.diff":
		h.handleGitDiff(ctx, conn, req)
	case "git.subscribe":
		h.handleGitSubscribe(ctx, conn, req)
	case "git.unsubscribe":
		h.handleGitUnsubscribe(ctx, conn, req)
	// command namespace
	case "command.list":
		h.handleCommandList(ctx, conn, req)
	// watch namespace
	case "watch.subscribe":
		h.handleWatchSubscribe(ctx, conn, req)
	case "watch.unsubscribe":
		h.handleWatchUnsubscribe(ctx, conn, req)
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
	if err := unmarshalParams(req, &params); err != nil {
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

	title := filepath.Base(h.workDir)
	if err := conn.Reply(ctx, req.ID, rpc.AuthResult{Version: h.version, Title: title}); err != nil {
		h.log.Error("failed to send auth response", "error", err)
	}
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

func unmarshalParams(req *jsonrpc2.Request, v interface{}) error {
	return json.Unmarshal(*req.Params, v)
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
		// Treat normal close frames as EOF so jsonrpc2 shuts down gracefully
		switch websocket.CloseStatus(err) {
		case websocket.StatusNormalClosure, websocket.StatusGoingAway:
			return io.EOF
		}
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
