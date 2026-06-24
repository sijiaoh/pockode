package cluster

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/pockode/server/cluster/node"
	"github.com/pockode/server/logger"
	"github.com/pockode/server/ws"
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
	token          string
	version        string
	devMode        bool
	nodeStore      node.Store
	processManager *node.ProcessManager
	log            *slog.Logger
}

func newWSHandler(token, version string, devMode bool, nodeStore node.Store, processManager *node.ProcessManager, log *slog.Logger) *wsHandler {
	return &wsHandler{
		token:          token,
		version:        version,
		devMode:        devMode,
		nodeStore:      nodeStore,
		processManager: processManager,
		log:            log.With("component", "ws"),
	}
}

func (h *wsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: h.devMode,
	})
	if err != nil {
		h.log.Error("failed to accept websocket", "error", err)
		return
	}

	h.handleConnection(r.Context(), conn)
}

func (h *wsHandler) handleConnection(ctx context.Context, wsConn *websocket.Conn) {
	stream := ws.NewWebSocketStream(wsConn)
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
		token:          h.token,
		version:        h.version,
		nodeStore:      h.nodeStore,
		processManager: h.processManager,
		log:            log,
		authenticated:  false,
	}

	rpcConn := jsonrpc2.NewConn(ctx, stream, jsonrpc2.AsyncHandler(handler))
	<-rpcConn.DisconnectNotify()
	log.Info("connection closed")
}

type clusterRPCHandler struct {
	token          string
	version        string
	nodeStore      node.Store
	processManager *node.ProcessManager
	log            *slog.Logger
	authenticated  bool
	mu             sync.Mutex
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

	// After authentication, cluster mode supports node management and basic methods
	switch req.Method {
	case "ping":
		if err := conn.Reply(ctx, req.ID, "pong"); err != nil {
			h.log.Error("failed to send pong", "error", err)
		}
	case "node.list":
		h.handleNodeList(ctx, conn, req)
	case "node.get":
		h.handleNodeGet(ctx, conn, req)
	case "node.create":
		h.handleNodeCreate(ctx, conn, req)
	case "node.update":
		h.handleNodeUpdate(ctx, conn, req)
	case "node.delete":
		h.handleNodeDelete(ctx, conn, req)
	case "node.status":
		h.handleNodeStatus(ctx, conn, req)
	case "node.start":
		h.handleNodeStart(ctx, conn, req)
	case "node.stop":
		h.handleNodeStop(ctx, conn, req)
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

// --- Node RPC types ---

type NodeGetParams struct {
	ID string `json:"id"`
}

type NodeCreateParams struct {
	Path string `json:"path"`
	Name string `json:"name,omitempty"`
}

type NodeUpdateParams struct {
	ID   string  `json:"id"`
	Path *string `json:"path,omitempty"`
	Name *string `json:"name,omitempty"`
}

type NodeDeleteParams struct {
	ID string `json:"id"`
}

type NodeStatusParams struct {
	ID string `json:"id"`
}

type NodeStartParams struct {
	ID    string `json:"id"`
	Token string `json:"token"`
}

type NodeStopParams struct {
	ID string `json:"id"`
}

// NodeWithStatus combines a Node with its runtime status.
type NodeWithStatus struct {
	node.Node
	Status node.NodeStatus `json:"status"`
}

// --- Node RPC handlers ---

func (h *clusterRPCHandler) handleNodeList(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	nodes, err := h.nodeStore.List()
	if err != nil {
		h.log.Error("failed to list nodes", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}

	result := make([]NodeWithStatus, len(nodes))
	for i, n := range nodes {
		result[i] = NodeWithStatus{
			Node:   n,
			Status: h.processManager.GetNodeStatus(n),
		}
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send node.list response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeGet(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeGetParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	n, found, err := h.nodeStore.Get(params.ID)
	if err != nil {
		h.log.Error("failed to get node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
		return
	}

	result := NodeWithStatus{
		Node:   n,
		Status: h.processManager.GetNodeStatus(n),
	}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send node.get response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeCreate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeCreateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.Path == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "path is required")
		return
	}

	n, err := h.nodeStore.Create(params.Path, params.Name)
	if err != nil {
		if errors.Is(err, node.ErrInvalidNode) || errors.Is(err, node.ErrDuplicatePath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.log.Error("failed to create node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}

	if err := conn.Reply(ctx, req.ID, n); err != nil {
		h.log.Error("failed to send node.create response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeUpdate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeUpdateParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	fields := node.UpdateFields{
		Path: params.Path,
		Name: params.Name,
	}

	n, err := h.nodeStore.Update(params.ID, fields)
	if err != nil {
		if errors.Is(err, node.ErrNodeNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
			return
		}
		if errors.Is(err, node.ErrInvalidNode) || errors.Is(err, node.ErrDuplicatePath) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.log.Error("failed to update node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}

	if err := conn.Reply(ctx, req.ID, n); err != nil {
		h.log.Error("failed to send node.update response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeDelete(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeDeleteParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	if err := h.nodeStore.Delete(params.ID); err != nil {
		if errors.Is(err, node.ErrNodeNotFound) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
			return
		}
		h.log.Error("failed to delete node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}

	if err := conn.Reply(ctx, req.ID, nil); err != nil {
		h.log.Error("failed to send node.delete response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeStatus(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeStatusParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	n, found, err := h.nodeStore.Get(params.ID)
	if err != nil {
		h.log.Error("failed to get node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
		return
	}

	status := h.processManager.GetNodeStatus(n)

	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send node.status response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeStart(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeStartParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	n, found, err := h.nodeStore.Get(params.ID)
	if err != nil {
		h.log.Error("failed to get node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
		return
	}

	if err := h.processManager.Start(n, params.Token); err != nil {
		if errors.Is(err, node.ErrNodeAlreadyRunning) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node already running")
			return
		}
		if errors.Is(err, node.ErrInvalidNode) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.log.Error("failed to start node", "error", err, "nodeId", n.ID)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.log.Info("node started", "nodeId", n.ID)

	status := h.processManager.GetNodeStatus(n)
	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send node.start response", "error", err)
	}
}

func (h *clusterRPCHandler) handleNodeStop(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeStopParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	if params.ID == "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "id is required")
		return
	}

	n, found, err := h.nodeStore.Get(params.ID)
	if err != nil {
		h.log.Error("failed to get node", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "internal error")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not found")
		return
	}

	if err := h.processManager.Stop(n); err != nil {
		if errors.Is(err, node.ErrNodeNotRunning) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node not running")
			return
		}
		h.log.Error("failed to stop node", "error", err, "nodeId", n.ID)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.log.Info("node stopped", "nodeId", n.ID)

	status := h.processManager.GetNodeStatus(n)
	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send node.stop response", "error", err)
	}
}
