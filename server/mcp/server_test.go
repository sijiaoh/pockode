package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

// callMethod sends a JSON-RPC request to the stdio proxy and returns the
// parsed response.
func callMethod(t *testing.T, s *Server, method string, params interface{}) jsonRPCResponse {
	t.Helper()
	var rawParams json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		rawParams = b
	}

	req := &jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  method,
		Params:  rawParams,
	}

	var buf bytes.Buffer
	s.handleRequest(context.Background(), &buf, req)

	var resp jsonRPCResponse
	if err := json.Unmarshal(buf.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, buf.String())
	}
	return resp
}

// --- Protocol tests (handled locally, no server round-trip) ---

func TestInitialize(t *testing.T) {
	resp := callMethod(t, NewServer(nil, "test"), "initialize", nil)
	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	b, _ := json.Marshal(resp.Result)
	var result initializeResult
	json.Unmarshal(b, &result)

	if result.ProtocolVersion != "2024-11-05" {
		t.Errorf("protocol = %q, want 2024-11-05", result.ProtocolVersion)
	}
	if result.ServerInfo.Name != "pockode" {
		t.Errorf("name = %q, want pockode", result.ServerInfo.Name)
	}
}

func TestToolsList(t *testing.T) {
	resp := callMethod(t, NewServer(nil, "test"), "tools/list", nil)

	b, _ := json.Marshal(resp.Result)
	var result toolsListResult
	json.Unmarshal(b, &result)

	names := make(map[string]bool)
	for _, td := range result.Tools {
		names[td.Name] = true
	}

	for _, want := range []string{"work_list", "work_create", "work_update", "work_get", "work_delete", "work_start", "work_needs_input", "step_done", "work_comment_add", "work_comment_list", "agent_role_list", "agent_role_get", "agent_role_reset_defaults"} {
		if !names[want] {
			t.Errorf("missing tool %q", want)
		}
	}
	if names["work_done"] {
		t.Error("work_done should not be exposed as an MCP tool")
	}
}

func TestUnknownMethod(t *testing.T) {
	resp := callMethod(t, NewServer(nil, "test"), "nonexistent", nil)
	if resp.Error == nil {
		t.Fatal("expected error for unknown method")
	}
	if resp.Error.Code != -32601 {
		t.Errorf("code = %d, want -32601", resp.Error.Code)
	}
}

// --- Proxy ↔ API integration ---

// newProxyToAPI wires a stdio proxy to an in-memory API backed by a live
// executor, using the given token for both ends.
func newProxyToAPI(t *testing.T, serverToken, clientToken string) (*Server, string) {
	t.Helper()
	ts := newTestExec(t)
	httpSrv := httptest.NewServer(NewAPIHandler(ts.exec, serverToken))
	t.Cleanup(httpSrv.Close)

	client := &Client{baseURL: httpSrv.URL, token: clientToken, http: httpSrv.Client()}
	return NewServer(client, "test"), ts.roleID
}

func callToolViaProxy(t *testing.T, s *Server, name string, args interface{}) jsonRPCResponse {
	t.Helper()
	raw, _ := json.Marshal(args)
	return callMethod(t, s, "tools/call", toolCallParams{Name: name, Arguments: raw})
}

func TestProxyToolCall_Success(t *testing.T) {
	s, roleID := newProxyToAPI(t, "secret", "secret")

	resp := callToolViaProxy(t, s, "work_create", map[string]string{
		"type": "story", "title": "Proxied Story", "agent_role_id": roleID,
	})
	if resp.Error != nil {
		t.Fatalf("unexpected RPC error: %+v", resp.Error)
	}

	b, _ := json.Marshal(resp.Result)
	var result toolCallResult
	json.Unmarshal(b, &result)

	if result.IsError {
		t.Fatalf("unexpected tool error: %s", result.Content[0].Text)
	}
	if !strings.Contains(result.Content[0].Text, "Proxied Story") {
		t.Errorf("result = %q, want to contain title", result.Content[0].Text)
	}
}

func TestProxyToolCall_ToolError(t *testing.T) {
	s, _ := newProxyToAPI(t, "secret", "secret")

	resp := callToolViaProxy(t, s, "work_get", map[string]string{"id": "nonexistent"})
	if resp.Error != nil {
		t.Fatalf("tool errors should be isError results, not RPC errors: %+v", resp.Error)
	}

	b, _ := json.Marshal(resp.Result)
	var result toolCallResult
	json.Unmarshal(b, &result)

	if !result.IsError {
		t.Error("expected isError result for missing work")
	}
}

func TestProxyToolCall_UnknownTool(t *testing.T) {
	s, _ := newProxyToAPI(t, "secret", "secret")

	resp := callToolViaProxy(t, s, "nonexistent_tool", map[string]string{})
	if resp.Error == nil {
		t.Fatal("expected RPC error for unknown tool")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("code = %d, want -32602", resp.Error.Code)
	}
}

func TestProxyToolCall_AuthFailure(t *testing.T) {
	s, roleID := newProxyToAPI(t, "secret", "wrong-token")

	resp := callToolViaProxy(t, s, "work_create", map[string]string{
		"type": "story", "title": "X", "agent_role_id": roleID,
	})
	// An auth failure is a transport problem; the proxy surfaces it as an
	// isError result so the AI is not left guessing.
	if resp.Error != nil {
		t.Fatalf("expected isError result, got RPC error: %+v", resp.Error)
	}

	b, _ := json.Marshal(resp.Result)
	var result toolCallResult
	json.Unmarshal(b, &result)
	if !result.IsError {
		t.Error("expected isError result for auth failure")
	}
}
