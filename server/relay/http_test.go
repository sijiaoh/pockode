package relay

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
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

// MaxTunneledRequestBody is arithmetic done once and relied on everywhere a
// size is quoted to a remote client, and getting it wrong is not a rejected
// request but a dropped tunnel. So encode the request the way Handle's caller
// receives it and check that a body of exactly that size still fits, headers
// and JSON framing included.
func TestMaxTunneledRequestBody_FitsInAnEnvelope(t *testing.T) {
	req := &HTTPRequest{
		Method: http.MethodPost,
		Path:   "/api/files/upload?path=assets&overwrite=false",
		Headers: map[string][]string{
			"Authorization": {"Bearer " + strings.Repeat("a", 64)},
			"Content-Type":  {"multipart/form-data; boundary=" + strings.Repeat("-", 70)},
			"User-Agent":    {strings.Repeat("u", 256)},
			"Cookie":        {strings.Repeat("c", 4096)},
		},
		Body: base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0xff}, MaxTunneledRequestBody)),
	}

	envelope, err := json.Marshal(Envelope{
		ConnectionID: "00000000-0000-0000-0000-000000000000",
		Type:         EnvelopeTypeHTTPRequest,
		HTTPRequest:  req,
	})
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}

	if int64(len(envelope)) > MaxEnvelopeSize {
		t.Fatalf("a %d-byte body makes a %d-byte envelope, over the %d read limit: the tunnel would die on it",
			MaxTunneledRequestBody, len(envelope), MaxEnvelopeSize)
	}
}
