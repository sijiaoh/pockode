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
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/ws"
	"github.com/sourcegraph/jsonrpc2"
)

// AuthParams mirrors rpc.AuthParams but without worktree (cluster mode doesn't
// use worktrees). See rpc.AuthParams for why the two credentials are exclusive
// and why Token is still accepted.
type AuthParams struct {
	Password     string `json:"password"`
	Token        string `json:"token"`
	SessionToken string `json:"session_token"`
}

// AuthResult mirrors rpc.AuthResult but with cluster-specific fields.
type AuthResult struct {
	Version      string `json:"version"`
	SessionToken string `json:"session_token"`
}

type wsHandler struct {
	password       string
	sessions       ws.SessionStore
	version        string
	devMode        bool
	nodeStore      node.Store
	processManager *node.ProcessManager
	log            *slog.Logger
}

func newWSHandler(password string, sessions ws.SessionStore, version string, devMode bool, nodeStore node.Store, processManager *node.ProcessManager, log *slog.Logger) *wsHandler {
	return &wsHandler{
		password:       password,
		sessions:       sessions,
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
		password:       h.password,
		sessions:       h.sessions,
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
	password       string
	sessions       ws.SessionStore
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
			h.replyAuthError(ctx, conn, req.ID, "first request must be auth", rpc.AuthReasonNotAuthenticated)
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
	case "node.cleanup":
		h.handleNodeCleanup(ctx, conn, req)
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

	sessionToken, ok := h.authenticate(ctx, conn, req, params)
	if !ok {
		return
	}

	h.mu.Lock()
	h.authenticated = true
	h.mu.Unlock()

	h.log.Info("authenticated")

	result := AuthResult{
		Version:      h.version,
		SessionToken: sessionToken,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		h.log.Error("failed to send auth response", "error", err)
	}
}

// authenticate is the cluster's copy of the server's credential check; see
// (*rpcMethodHandler).checkCredentials in package ws for the reasoning behind
// the exclusivity rule and the no-rotation policy. The two are separate because
// the two handlers share no connection state at all, not because they may
// diverge. This one issues the token itself, because unlike the server's there
// is no worktree still to bind that could fail after the check.
func (h *clusterRPCHandler) authenticate(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, params AuthParams) (string, bool) {
	password := rpc.OrLegacy(params.Password, params.Token)

	if password != "" && params.SessionToken != "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "password and session_token are mutually exclusive")
		conn.Close()
		return "", false
	}

	if params.SessionToken != "" {
		if !h.sessions.Validate(params.SessionToken) {
			h.log.Info("rejected an expired or unknown session token")
			h.replyAuthError(ctx, conn, req.ID, "session expired", rpc.AuthReasonSessionExpired)
			conn.Close()
			return "", false
		}
		return params.SessionToken, true
	}

	if subtle.ConstantTimeCompare([]byte(password), []byte(h.password)) != 1 {
		h.log.Warn("invalid password")
		h.replyAuthError(ctx, conn, req.ID, "invalid password", rpc.AuthReasonInvalidPassword)
		conn.Close()
		return "", false
	}

	sessionToken, err := h.sessions.Issue()
	if err != nil {
		h.log.Error("failed to issue session token", "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to issue session token")
		conn.Close()
		return "", false
	}
	return sessionToken, true
}

func (h *clusterRPCHandler) replyError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, code int64, message string) {
	h.replyErrorData(ctx, conn, id, code, message, nil)
}

// replyAuthError attaches the machine-readable reason clients branch on; see
// rpc.AuthErrorData.
func (h *clusterRPCHandler) replyAuthError(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, message, reason string) {
	h.replyErrorData(ctx, conn, id, jsonrpc2.CodeInvalidRequest, message, rpc.AuthErrorData{Reason: reason})
}

func (h *clusterRPCHandler) replyErrorData(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, code int64, message string, data any) {
	err := &jsonrpc2.Error{
		Code:    code,
		Message: message,
	}
	if data != nil {
		err.SetError(data)
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
	Path             string `json:"path"`
	Name             string `json:"name,omitempty"`
	CreateMissingDir bool   `json:"create_missing_dir,omitempty"`
}

type NodeUpdateParams struct {
	ID               string  `json:"id"`
	Path             *string `json:"path,omitempty"`
	Name             *string `json:"name,omitempty"`
	CreateMissingDir bool    `json:"create_missing_dir,omitempty"`
}

type NodeDeleteParams struct {
	ID string `json:"id"`
}

type NodeStatusParams struct {
	ID string `json:"id"`
}

type NodeStartParams struct {
	ID string `json:"id"`
	// Password is what the spawned node will require of its own clients. The
	// cluster frontend generates it per browser session and keeps it in memory
	// only, so a node's credential never reaches disk.
	Password string `json:"password"`
	// Token is the pre-rename name of Password, accepted for one deprecation
	// period.
	Token string `json:"token"`
}

type NodeStopParams struct {
	ID string `json:"id"`
}

type NodeCleanupParams struct {
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

	n, err := h.nodeStore.Create(params.Path, params.Name, params.CreateMissingDir)
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

	n, err := h.nodeStore.Update(params.ID, fields, params.CreateMissingDir)
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

	if err := h.processManager.Start(n, rpc.OrLegacy(params.Password, params.Token)); err != nil {
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

	// Starting is a use, and the list sorts on that. A failure here has not
	// stopped anything from running, so it is logged rather than turned into an
	// error for a start that succeeded.
	if err := h.nodeStore.MarkUsed(n.ID); err != nil {
		h.log.Error("failed to record node usage", "error", err, "nodeId", n.ID)
	}

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

func (h *clusterRPCHandler) handleNodeCleanup(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params NodeCleanupParams
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

	if err := h.processManager.Cleanup(n); err != nil {
		if errors.Is(err, node.ErrNodeStillRunning) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "node is still running")
			return
		}
		h.log.Error("failed to clean up node", "error", err, "nodeId", n.ID)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.log.Info("node cleaned up", "nodeId", n.ID)

	status := h.processManager.GetNodeStatus(n)
	if err := conn.Reply(ctx, req.ID, status); err != nil {
		h.log.Error("failed to send node.cleanup response", "error", err)
	}
}
