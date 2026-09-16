package ws

import (
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/rpc"
)

// storeAttachment puts content in the session's attachment store the way the
// agent parser does, and returns the id it is read back by.
func storeAttachment(t *testing.T, env *testEnv, sessionID string, data []byte) string {
	t.Helper()
	id, err := attachments.NewStore(env.getMainWorktree().DataDir, sessionID).Put(data, "")
	if err != nil {
		t.Fatalf("store attachment: %v", err)
	}
	return id
}

// A one-pixel PNG, so the served content is typed from its own bytes.
var pngPixel = []byte{
	0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a,
	0, 0, 0, 0x0d, 'I', 'H', 'D', 'R',
	0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
	0, 0, 0, 0x0a, 'I', 'D', 'A', 'T', 0x78, 0x9c, 0x63, 0, 1, 0, 0, 5, 0, 1,
	0x0d, 0x0a, 0x2d, 0xb4,
	0, 0, 0, 0, 'I', 'E', 'N', 'D', 0xae, 0x42, 0x60, 0x82,
}

func TestHandler_AttachmentGet(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	_, created := env.createSession()
	id := storeAttachment(t, env, created.ID, pngPixel)

	resp := env.call("attachment.get", rpc.AttachmentGetParams{SessionID: created.ID, ID: id})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.AttachmentGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if result.File == nil {
		t.Fatal("expected a file in the result")
	}
	if result.File.MIME != "image/png" {
		t.Errorf("expected image/png, got %q", result.File.MIME)
	}
	if result.File.Encoding != contents.EncodingBase64 {
		t.Fatalf("expected base64, got %q (%q)", result.File.Encoding, result.File.Omitted)
	}
	decoded, err := base64.StdEncoding.DecodeString(result.File.Content)
	if err != nil {
		t.Fatalf("decode content: %v", err)
	}
	if string(decoded) != string(pngPixel) {
		t.Error("served content differs from what was stored")
	}
}

// SVG, AVIF, HEIC and TIFF cannot be named from their bytes, so an id that kept
// nothing of the original file name would come back as plain text or as an
// unnamed binary — an image stored perfectly well that the client could never
// draw.
func TestHandler_AttachmentGet_TypesByExtensionWhenBytesCannotSayIt(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	_, created := env.createSession()
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)
	id, err := attachments.NewStore(env.getMainWorktree().DataDir, created.ID).Put(svg, ".svg")
	if err != nil {
		t.Fatalf("store attachment: %v", err)
	}

	resp := env.call("attachment.get", rpc.AttachmentGetParams{SessionID: created.ID, ID: id})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	var result rpc.AttachmentGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if result.File == nil {
		t.Fatal("expected a file in the result")
	}
	if result.File.MIME != "image/svg+xml" {
		t.Errorf("expected image/svg+xml, got %q", result.File.MIME)
	}
	// SVG is source, so it travels as text and the client builds the data URL
	// from it — what matters is that it is not withheld as an unnamed binary.
	if result.File.Encoding != contents.EncodingText {
		t.Errorf("expected text, got %q (%q)", result.File.Encoding, result.File.Omitted)
	}
}

func TestHandler_AttachmentGet_Rejects(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	_, created := env.createSession()
	id := storeAttachment(t, env, created.ID, pngPixel)

	tests := []struct {
		name   string
		params rpc.AttachmentGetParams
	}{
		{"unknown id", rpc.AttachmentGetParams{SessionID: created.ID, ID: "nope"}},
		// The session id picks the directory, so it must not be usable to walk
		// out of one.
		{"traversing session id", rpc.AttachmentGetParams{SessionID: "../..", ID: id}},
		{"traversing attachment id", rpc.AttachmentGetParams{SessionID: created.ID, ID: "../../history.jsonl"}},
		{"missing id", rpc.AttachmentGetParams{SessionID: created.ID}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if resp := env.call("attachment.get", tt.params); resp.Error == nil {
				t.Errorf("expected an error, got %s", resp.Result)
			}
		})
	}
}
