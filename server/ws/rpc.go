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
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/watch"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// RPCHandler handles JSON-RPC 2.0 over WebSocket.
type RPCHandler struct {
	token           string
	version         string
	devMode         bool
	commandStore    *command.Store
	worktreeManager *worktree.Manager
}

func NewRPCHandler(token, version string, devMode bool, commandStore *command.Store, worktreeManager *worktree.Manager) *RPCHandler {
	return &RPCHandler{
		token:           token,
		version:         version,
		devMode:         devMode,
		commandStore:    commandStore,
		worktreeManager: worktreeManager,
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
		log:        log,
		// worktree is set after auth
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

	state.cleanup(h.worktreeManager)
	log.Info("connection closed", "subscriptions", len(state.subscribed))
}

// rpcConnState tracks per-connection state.
type rpcConnState struct {
	mu         sync.Mutex
	connID     string
	subscribed map[string]struct{}
	conn       *jsonrpc2.Conn
	log        *slog.Logger
	worktree   *worktree.Worktree // set after auth
}

func (s *rpcConnState) getConnID() string {
	return s.connID
}

func (s *rpcConnState) getWorktree() *worktree.Worktree {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.worktree
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
		s.worktree.ProcessManager.SubscribeRPC(sessionID, conn)
		s.subscribed[sessionID] = struct{}{}
	}
}

func (s *rpcConnState) cleanup(worktreeManager *worktree.Manager) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Cleanup worktree watcher subscription (Manager-level, not worktree-specific)
	worktreeManager.WorktreeWatcher.CleanupConnection(s.connID)

	if s.worktree == nil {
		return // Not authenticated yet (e.g., connection closed before auth)
	}

	s.worktree.UnsubscribeConnection(s.conn, s.connID)
	worktreeManager.Release(s.worktree)

	// Reset state (safe even for connection close - no harm in resetting)
	s.worktree = nil
	s.subscribed = make(map[string]struct{})
}

type rpcMethodHandler struct {
	*RPCHandler
	state         *rpcConnState
	log           *slog.Logger
	authenticated bool
	authMu        sync.Mutex
}

func (h *rpcMethodHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "rpc handler panic", "method", req.Method, "connId", h.state.connID)
		}
	}()

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

	// Methods that don't require worktree (manager-level operations)
	switch req.Method {
	case "worktree.list":
		h.handleWorktreeList(ctx, conn, req)
		return
	case "worktree.create":
		h.handleWorktreeCreate(ctx, conn, req)
		return
	case "worktree.delete":
		h.handleWorktreeDelete(ctx, conn, req)
		return
	case "worktree.switch":
		h.handleWorktreeSwitch(ctx, conn, req)
		return
	case "worktree.subscribe":
		h.handleWorktreeSubscribe(ctx, conn, req)
		return
	case "worktree.unsubscribe":
		h.handleWatcherUnsubscribe(ctx, conn, req, h.worktreeManager.WorktreeWatcher, "worktree")
		return
	case "command.list":
		h.handleCommandList(ctx, conn, req)
		return
	}

	// All other methods require a valid worktree
	if h.state.getWorktree() == nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "no worktree bound")
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
	case "session.create":
		h.handleSessionCreate(ctx, conn, req)
	case "session.delete":
		h.handleSessionDelete(ctx, conn, req)
	case "session.update_title":
		h.handleSessionUpdateTitle(ctx, conn, req)
	case "session.get_history":
		h.handleSessionGetHistory(ctx, conn, req)
	case "session.list.subscribe":
		h.handleSessionListSubscribe(ctx, conn, req)
	case "session.list.unsubscribe":
		h.handleWatcherUnsubscribe(ctx, conn, req, h.state.worktree.SessionListWatcher, "session list")
	// file namespace
	case "file.get":
		h.handleFileGet(ctx, conn, req)
	// git namespace
	case "git.status":
		h.handleGitStatus(ctx, conn, req)
	case "git.subscribe":
		h.handleGitSubscribe(ctx, conn, req)
	case "git.unsubscribe":
		h.handleWatcherUnsubscribe(ctx, conn, req, h.state.worktree.GitWatcher, "git")
	case "git.diff.subscribe":
		h.handleGitDiffSubscribe(ctx, conn, req)
	case "git.diff.unsubscribe":
		h.handleWatcherUnsubscribe(ctx, conn, req, h.state.worktree.GitDiffWatcher, "git-diff")
	// fs namespace
	case "fs.subscribe":
		h.handleFSSubscribe(ctx, conn, req)
	case "fs.unsubscribe":
		h.handleWatcherUnsubscribe(ctx, conn, req, h.state.worktree.FSWatcher, "fs")
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

	wt, err := h.worktreeManager.Get(params.Worktree)
	if err != nil {
		h.log.Warn("worktree not found", "worktree", params.Worktree, "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "worktree not found")
		conn.Close()
		return
	}

	h.state.mu.Lock()
	h.state.worktree = wt
	h.state.mu.Unlock()

	wt.Subscribe(conn)

	h.setAuthenticated()
	h.log.Info("authenticated", "worktree", wt.Name, "workDir", wt.WorkDir)

	title := filepath.Base(h.worktreeManager.Registry().MainDir())
	result := rpc.AuthResult{
		Version:      h.version,
		Title:        title,
		WorkDir:      wt.WorkDir,
		WorktreeName: wt.Name,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
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

type unsubscribeParams struct {
	ID string `json:"id"`
}

func (h *rpcMethodHandler) handleWatcherUnsubscribe(
	ctx context.Context,
	conn *jsonrpc2.Conn,
	req *jsonrpc2.Request,
	watcher watch.Watcher,
	logName string,
) {
	var params unsubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	watcher.Unsubscribe(params.ID)
	h.log.Debug("unsubscribed", "watcher", logName, "watchId", params.ID)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		h.log.Error("failed to send "+logName+" unsubscribe response", "error", err)
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
