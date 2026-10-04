package filetransfer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/pockode/server/attachments"
)

var (
	errNoWorktree = errors.New("no such worktree")
	errNoSession  = errors.New("no such session")
	errDisk       = errors.New("index unreadable")
)

type sessionResolver struct {
	dataDir  string
	sessions map[string]bool
}

func (r sessionResolver) AttachmentDataDir(worktree, sessionID string) (string, error) {
	if worktree == "broken" {
		return "", errDisk
	}
	if worktree != "" {
		return "", fmt.Errorf("%w: %s", errNoWorktree, worktree)
	}
	if !r.sessions[sessionID] {
		return "", fmt.Errorf("%w: %s", errNoSession, sessionID)
	}
	return r.dataDir, nil
}

func newAttachmentHandler(t *testing.T) (*AttachmentHandler, string) {
	t.Helper()
	dataDir := t.TempDir()
	h := NewAttachmentHandler(sessionResolver{dataDir: dataDir, sessions: map[string]bool{"sess": true}},
		errNoWorktree, errNoSession, slog.New(slog.DiscardHandler))
	return h, dataDir
}

func uploadAttachments(t *testing.T, h *AttachmentHandler, query string, files ...uploadFile) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.Upload(rec, newUploadRequest(t, query, files...))
	return rec
}

func TestAttachmentUpload(t *testing.T) {
	t.Run("stores each file in the session's store and returns its id", func(t *testing.T) {
		h, dataDir := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "session_id=sess",
			uploadFile{"shot.png", []byte("one")}, uploadFile{"notes.txt", []byte("two")})
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
		}
		var body attachmentUploadResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if len(body.Files) != 2 {
			t.Fatalf("files = %+v", body.Files)
		}
		for i, want := range []struct{ name, content, ext string }{{"shot.png", "one", ".png"}, {"notes.txt", "two", ".txt"}} {
			got := body.Files[i]
			if got.Name != want.name || got.Size != int64(len(want.content)) {
				t.Errorf("file %d = %+v", i, got)
			}
			path, err := attachments.Resolve(dataDir, "sess", got.ID)
			if err != nil {
				t.Fatalf("id %q does not resolve: %v", got.ID, err)
			}
			if data, _ := os.ReadFile(path); string(data) != want.content {
				t.Errorf("stored %q, want %q", data, want.content)
			}
			// The agent's tools go by extension, so the id keeps it.
			if ext := got.ID[len(got.ID)-len(want.ext):]; ext != want.ext {
				t.Errorf("id %q lost the extension %q", got.ID, want.ext)
			}
		}
	})

	t.Run("refuses a session the worktree does not have", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "session_id=other", uploadFile{"a.png", []byte("x")})
		assertError(t, rec, http.StatusNotFound, CodeSessionUnknown)
	})

	t.Run("refuses a missing session id", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "", uploadFile{"a.png", []byte("x")})
		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	})

	t.Run("refuses an unknown worktree", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "session_id=sess&worktree=gone", uploadFile{"a.png", []byte("x")})
		assertError(t, rec, http.StatusNotFound, CodeWorktreeUnknown)
	})

	// A fault reading the session index is this side's, and must not reach the
	// client dressed as a name it got wrong.
	t.Run("reports a fault resolving the session as one", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "session_id=sess&worktree=broken", uploadFile{"a.png", []byte("x")})
		assertError(t, rec, http.StatusInternalServerError, CodeInternal)
	})

	t.Run("refuses a request over the ceiling and names it", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		h.base.maxUpload = 4
		rec := uploadAttachments(t, h, "session_id=sess", uploadFile{"a.png", []byte("12345")})
		body := assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if body.Limit != 4 {
			t.Errorf("limit = %d, want 4", body.Limit)
		}
	})

	// The ceiling counts file content, so a part with no filename would
	// otherwise be read for as long as the client keeps sending it.
	t.Run("refuses a body over its bound in parts that are not files", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		h.base.maxUpload = 4
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		if err := writer.WriteField("padding", strings.Repeat("x", attachmentBodyAllowance+5)); err != nil {
			t.Fatal(err)
		}
		part, err := writer.CreateFormFile("files", "a.png")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte("x")); err != nil {
			t.Fatal(err)
		}
		if err := writer.Close(); err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/chat/attachments?session_id=sess", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())

		rec := httptest.NewRecorder()
		h.Upload(rec, req)
		resp := assertError(t, rec, http.StatusRequestEntityTooLarge, CodeTooLarge)
		if resp.Limit != 4 {
			t.Errorf("limit = %d, want 4", resp.Limit)
		}
	})

	t.Run("refuses a request with no files", func(t *testing.T) {
		h, _ := newAttachmentHandler(t)
		rec := uploadAttachments(t, h, "session_id=sess")
		assertError(t, rec, http.StatusBadRequest, CodeInvalidRequest)
	})
}
