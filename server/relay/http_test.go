package relay

import (
	"context"
	"log/slog"
	"net/http"
	"testing"
)

// The local MCP API must never be forwarded over the relay. The handler rejects
// it before any port selection, so this holds even though frontendPort and
// backendPort are unreachable here.
func TestHandle_RejectsMCPAPI(t *testing.T) {
	h := NewHTTPHandler(1, 2, slog.Default())

	for _, path := range []string{"/api/mcp/tools/call", "/api/mcp/anything"} {
		resp := h.Handle(context.Background(), &HTTPRequest{Method: http.MethodPost, Path: path})
		if resp.Status != http.StatusNotFound {
			t.Errorf("path %q: status = %d, want %d", path, resp.Status, http.StatusNotFound)
		}
	}
}
