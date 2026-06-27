package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

type HTTPRequest struct {
	Method  string              `json:"method"`
	Path    string              `json:"path"`
	Headers map[string][]string `json:"headers"`
	Body    string              `json:"body,omitempty"` // base64 encoded
}

type HTTPResponse struct {
	Status  int                 `json:"status"`
	Headers map[string][]string `json:"headers"`
	Body    string              `json:"body"` // base64 encoded
}

type HTTPHandler struct {
	backendPort  int
	frontendPort int
	client       *http.Client
	log          *slog.Logger
}

func NewHTTPHandler(backendPort, frontendPort int, log *slog.Logger) *HTTPHandler {
	return &HTTPHandler{
		backendPort:  backendPort,
		frontendPort: frontendPort,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		log: log,
	}
}

func (h *HTTPHandler) Handle(ctx context.Context, req *HTTPRequest) *HTTPResponse {
	// The MCP local API is for the in-process subprocess only and must never be
	// reachable over the relay. Reject before any port selection, since in the
	// default single-port setup frontendPort == backendPort.
	if strings.HasPrefix(req.Path, "/api/mcp/") {
		return errorResponse(http.StatusNotFound, "not found")
	}

	port := h.frontendPort
	if h.isBackendPath(req.Path) {
		port = h.backendPort
	}
	targetURL := fmt.Sprintf("http://localhost:%d%s", port, req.Path)

	var bodyReader io.Reader
	if req.Body != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			h.log.Error("failed to decode request body", "error", err)
			return errorResponse(http.StatusBadGateway, "bad gateway")
		}
		bodyReader = bytes.NewReader(decoded)
	}

	httpReq, err := http.NewRequestWithContext(ctx, req.Method, targetURL, bodyReader)
	if err != nil {
		h.log.Error("failed to create request", "error", err)
		return errorResponse(http.StatusBadGateway, "bad gateway")
	}

	for key, values := range req.Headers {
		for _, value := range values {
			httpReq.Header.Add(key, value)
		}
	}

	resp, err := h.client.Do(httpReq)
	if err != nil {
		h.log.Error("failed to proxy request", "error", err, "path", req.Path)
		return errorResponse(http.StatusBadGateway, "bad gateway")
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		h.log.Error("failed to read response body", "error", err)
		return errorResponse(http.StatusBadGateway, "bad gateway")
	}

	headers := make(map[string][]string)
	for key, values := range resp.Header {
		if !isHopByHopHeader(key) {
			headers[key] = values
		}
	}

	return &HTTPResponse{
		Status:  resp.StatusCode,
		Headers: headers,
		Body:    base64.StdEncoding.EncodeToString(body),
	}
}

func (h *HTTPHandler) isBackendPath(path string) bool {
	return strings.HasPrefix(path, "/api") || path == "/ws" || path == "/health"
}

// isHopByHopHeader returns true if the header is a hop-by-hop header
// that should not be forwarded through the proxy.
func isHopByHopHeader(header string) bool {
	switch http.CanonicalHeaderKey(header) {
	case "Connection", "Keep-Alive", "Proxy-Authenticate", "Proxy-Authorization",
		"Te", "Trailer", "Transfer-Encoding", "Upgrade":
		return true
	}
	return false
}

func errorResponse(status int, message string) *HTTPResponse {
	return &HTTPResponse{
		Status:  status,
		Headers: map[string][]string{"Content-Type": {"text/plain"}},
		Body:    base64.StdEncoding.EncodeToString([]byte(message)),
	}
}
