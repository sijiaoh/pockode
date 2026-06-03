package cluster

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pockode/server/logger"
	"github.com/sourcegraph/jsonrpc2"
)

// AuthParams mirrors rpc.AuthParams but without worktree (cluster mode doesn't use worktrees).
type AuthParams struct {
	Token string `json:"token"`
}

// AuthResult mirrors rpc.AuthResult but with cluster-specific fields.
type AuthResult struct {
	Version string `json:"version"`
}

type wsHandler struct {
	token   string
	version string
	log     *slog.Logger
}

func newWSHandler(token, version string, log *slog.Logger) *wsHandler {
	return &wsHandler{
		token:   token,
		version: version,
		log:     log.With("component", "ws"),
	}
}

func (h *wsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		h.log.Error("failed to accept websocket", "error", err)
		return
	}

	h.handleConnection(r.Context(), conn)
}

func (h *wsHandler) handleConnection(ctx context.Context, wsConn *websocket.Conn) {
	stream := newWebSocketStream(wsConn)
	connID := uuid.Must(uuid.NewV7()).String()
	h.handleStream(ctx, stream, connID)
}

func (h *wsHandler) handleStream(ctx context.Context, stream jsonrpc2.ObjectStream, connID string) {
	defer func() {
		if r := recover(); r != nil {
			logger.LogPanic(r, "cluster websocket connection crashed", "connId", connID)
		}
	}()

	log := h.log.With("connId", connID)
	log.Info("new connection")

	handler := &clusterRPCHandler{
		token:         h.token,
		version:       h.version,
		log:           log,
		authenticated: false,
	}

	rpcConn := jsonrpc2.NewConn(ctx, stream, jsonrpc2.AsyncHandler(handler))
	<-rpcConn.DisconnectNotify()
	log.Info("connection closed")
}

type clusterRPCHandler struct {
	token         string
	version       string
	log           *slog.Logger
	authenticated bool
	mu            sync.Mutex
}

func (h *clusterRPCHandler) Handle(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	h.mu.Lock()
	authenticated := h.authenticated
	h.mu.Unlock()

	if !authenticated {
		if req.Method != "auth" {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidRequest, "not authenticated")
			conn.Close()
			return
		}
		h.handleAuth(ctx, conn, req)
		return
	}

	// After authentication, cluster mode only supports basic methods
	switch req.Method {
	case "ping":
		if err := conn.Reply(ctx, req.ID, "pong"); err != nil {
			h.log.Error("failed to send pong", "error", err)
		}
	default:
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeMethodNotFound, "method not found")
	}
}

func (h *clusterRPCHandler) handleAuth(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params AuthParams
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

	h.mu.Lock()
	h.authenticated = true
	h.mu.Unlock()

	h.log.Info("authenticated")

	result := AuthResult{
		Version: h.version,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send auth response", "error", err)
	}
}

func (h *clusterRPCHandler) replyError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, code int64, message string) {
	err := &jsonrpc2.Error{
		Code:    code,
		Message: message,
	}
	if replyErr := conn.ReplyWithError(ctx, id, err); replyErr != nil {
		h.log.Error("failed to send error response", "error", replyErr)
	}
}

func unmarshalParams(req *jsonrpc2.Request, v interface{}) error {
	if req.Params == nil {
		return errors.New("params required")
	}
	return json.Unmarshal(*req.Params, v)
}

// webSocketStream wraps a websocket.Conn as a jsonrpc2.ObjectStream.
type webSocketStream struct {
	conn *websocket.Conn
	mu   sync.Mutex
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
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.conn.Write(context.Background(), websocket.MessageText, data)
}

func (s *webSocketStream) Close() error {
	return s.conn.Close(websocket.StatusNormalClosure, "")
}

var _ jsonrpc2.ObjectStream = (*webSocketStream)(nil)
var _ io.Closer = (*webSocketStream)(nil)
