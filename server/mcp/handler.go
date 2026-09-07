package mcp

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
)

// APIPath is the local HTTP endpoint the stdio proxy forwards tool calls to.
const APIPath = "/api/mcp/tools/call"

// maxRequestBody caps the tool-call request body. 1MB matches the stdio
// scanner buffer in server.go and is far above any real tool argument payload.
const maxRequestBody = 1 << 20

// toolCallRequest is the body sent by the proxy to the server.
type toolCallRequest struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments,omitempty"`
}

// toolCallResponse is the server's reply for a successfully dispatched tool.
// A tool whose handler returned an error is still HTTP 200 with IsError set,
// mirroring MCP semantics where tool errors are reported to the AI, not the
// transport.
type toolCallResponse struct {
	Text    string `json:"text"`
	IsError bool   `json:"is_error,omitempty"`
}

// APIHandler serves the local MCP API. It authenticates with a dedicated token
// (see serverinfo) and dispatches tool calls to the Executor.
type APIHandler struct {
	executor *Executor
	token    string
}

func NewAPIHandler(executor *Executor, token string) *APIHandler {
	return &APIHandler{executor: executor, token: token}
}

func (h *APIHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !h.authorized(r) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	// Bound the body: tool arguments are small, so cap to avoid unbounded memory
	// from a malformed or hostile request.
	var req toolCallRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxRequestBody)).Decode(&req); err != nil {
		writeJSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	text, err := h.executor.Execute(r.Context(), req.Name, req.Arguments)
	if err != nil {
		if errors.Is(err, ErrUnknownTool) {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		// A tool error reaches the AI as an is_error result either way. Only log
		// genuine server faults at Error level; caller mistakes (bad input,
		// not-found) are expected and would just be log noise.
		if !isUserError(err) {
			slog.Error("mcp tool call failed", "tool", req.Name, "error", err)
		}
		writeJSON(w, http.StatusOK, toolCallResponse{Text: "Error: " + err.Error(), IsError: true})
		return
	}

	writeJSON(w, http.StatusOK, toolCallResponse{Text: text})
}

func (h *APIHandler) authorized(r *http.Request) bool {
	// Fail closed on a misconfigured (empty) token: ConstantTimeCompare("","")
	// returns 1, which would otherwise authenticate an empty bearer.
	if h.token == "" {
		return false
	}
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || parts[0] != "Bearer" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(parts[1]), []byte(h.token)) == 1
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("failed to encode mcp api response", "error", err)
	}
}

func writeJSONError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
