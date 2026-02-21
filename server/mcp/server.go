// Package mcp implements a stdio MCP server for AI agent integration.
// It provides work management tools accessible to Claude via --mcp-config.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

type Server struct {
	store          work.Store
	agentRoleStore agentrole.Store
}

func NewServer(store work.Store, agentRoleStore agentrole.Store) *Server {
	return &Server{store: store, agentRoleStore: agentRoleStore}
}

// Run starts the stdio JSON-RPC 2.0 loop.
func (s *Server) Run(ctx context.Context) error {
	scanner := bufio.NewScanner(os.Stdin)
	// 1MB buffer: the default 64KB is sufficient for current payloads, but MCP
	// doesn't define a max message size. 1MB gives headroom (e.g. large tool
	// results) with negligible cost since there's one scanner per process.
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req jsonRPCRequest
		if err := json.Unmarshal(line, &req); err != nil {
			writeJSONRPCError(os.Stdout, nil, -32700, "Parse error")
			continue
		}

		// Notifications (no id) don't need a response per JSON-RPC 2.0 spec
		if req.ID == nil {
			slog.Debug("received MCP notification", "method", req.Method)
			continue
		}

		s.handleRequest(ctx, os.Stdout, &req)
	}

	return scanner.Err()
}

func (s *Server) handleRequest(ctx context.Context, w io.Writer, req *jsonRPCRequest) {
	switch req.Method {
	case "initialize":
		writeJSONRPCResult(w, req.ID, initializeResult{
			ProtocolVersion: "2024-11-05",
			Capabilities: capabilities{
				Tools: &toolsCap{},
			},
			ServerInfo: serverInfo{
				Name:    "pockode",
				Version: "1.0.0",
			},
		})
	case "tools/list":
		writeJSONRPCResult(w, req.ID, toolsListResult{Tools: toolDefinitions})
	case "tools/call":
		s.handleToolCall(ctx, w, req)
	default:
		writeJSONRPCError(w, req.ID, -32601, fmt.Sprintf("Method not found: %s", req.Method))
	}
}

func (s *Server) handleToolCall(ctx context.Context, w io.Writer, req *jsonRPCRequest) {
	var params toolCallParams
	if err := json.Unmarshal(req.Params, &params); err != nil {
		writeJSONRPCError(w, req.ID, -32602, "Invalid params")
		return
	}

	handler, ok := s.getToolHandler(params.Name)
	if !ok {
		writeJSONRPCError(w, req.ID, -32602, fmt.Sprintf("Unknown tool: %s", params.Name))
		return
	}

	result, err := handler(ctx, params.Arguments)
	if err != nil {
		slog.Error("tool call failed", "tool", params.Name, "error", err)
		writeJSONRPCResult(w, req.ID, toolCallResult{
			Content: []contentBlock{{Type: "text", Text: fmt.Sprintf("Error: %s", err)}},
			IsError: true,
		})
		return
	}

	writeJSONRPCResult(w, req.ID, toolCallResult{
		Content: []contentBlock{{Type: "text", Text: result}},
	})
}

// --- JSON-RPC 2.0 types ---

type jsonRPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func writeJSONRPCResult(w io.Writer, id json.RawMessage, result interface{}) {
	resp := jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	}
	data, err := json.Marshal(resp)
	if err != nil {
		slog.Error("failed to marshal JSON-RPC result", "error", err)
		writeJSONRPCError(w, id, -32603, "Internal error: failed to marshal result")
		return
	}
	fmt.Fprintf(w, "%s\n", data)
}

func writeJSONRPCError(w io.Writer, id json.RawMessage, code int, message string) {
	resp := jsonRPCResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error:   &rpcError{Code: code, Message: message},
	}
	data, err := json.Marshal(resp)
	if err != nil {
		// Last resort: log and write a hardcoded error response
		slog.Error("failed to marshal JSON-RPC error", "error", err)
		fmt.Fprintf(w, `{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"Internal error"}}`+"\n")
		return
	}
	fmt.Fprintf(w, "%s\n", data)
}

// --- MCP protocol types ---

type initializeResult struct {
	ProtocolVersion string       `json:"protocolVersion"`
	Capabilities    capabilities `json:"capabilities"`
	ServerInfo      serverInfo   `json:"serverInfo"`
}

type capabilities struct {
	Tools *toolsCap `json:"tools,omitempty"`
}

type toolsCap struct{}

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type toolsListResult struct {
	Tools []toolDefinition `json:"tools"`
}

type toolCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

type toolCallResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}
