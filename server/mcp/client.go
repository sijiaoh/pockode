package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/pockode/server/serverinfo"
)

// Client forwards MCP tool calls from the stdio proxy to the running server's
// local API. The base URL and token are discovered from server.json.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

// APIError is returned for non-2xx responses from the local MCP API. The status
// code lets the proxy distinguish a client error (bad/unknown tool) from a
// transport/server failure.
type APIError struct {
	StatusCode int
	Message    string
}

func (e *APIError) Error() string { return e.Message }

// NewClientFromServerInfo reads server.json from dataDir and builds a client
// pointed at the running server's local API. The MCP subprocess is always
// spawned by a running server, so a missing server.json is an error.
func NewClientFromServerInfo(dataDir string) (*Client, error) {
	info, err := serverinfo.Read(dataDir)
	if err != nil {
		return nil, fmt.Errorf("read server.json: %w", err)
	}
	if info == nil {
		return nil, fmt.Errorf("server.json not found in %s: is the pockode server running?", dataDir)
	}
	if info.Token == "" {
		return nil, fmt.Errorf("server.json in %s has no token", dataDir)
	}

	baseURL := info.LocalURL
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://localhost:%d", info.Port)
	}

	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   info.Token,
		// Bounded so a wedged server can't hang the tool call (and the AI) forever.
		// Generous because work_start spawns an agent process server-side; normal
		// calls finish in well under a second.
		http: &http.Client{Timeout: 60 * time.Second},
	}, nil
}

// CallTool invokes a tool on the server and returns its result. A non-2xx
// response is reported as *APIError; a tool whose handler failed comes back as
// a normal response with IsError set.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (toolCallResponse, error) {
	body, err := json.Marshal(toolCallRequest{Name: name, Arguments: args})
	if err != nil {
		return toolCallResponse{}, fmt.Errorf("marshal tool call: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+APIPath, bytes.NewReader(body))
	if err != nil {
		return toolCallResponse{}, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return toolCallResponse{}, fmt.Errorf("call mcp api: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&e)
		msg := e.Error
		if msg == "" {
			msg = resp.Status
		}
		return toolCallResponse{}, &APIError{StatusCode: resp.StatusCode, Message: msg}
	}

	var out toolCallResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return toolCallResponse{}, fmt.Errorf("decode mcp api response: %w", err)
	}
	return out, nil
}
