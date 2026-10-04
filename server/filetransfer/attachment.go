package filetransfer

import (
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/pockode/server/attachments"
)

// MaxAttachmentSize caps one chat attachment upload request, counting every
// file in it. Unlike a workspace upload these are read whole — the store names
// a file by the hash of its content — so the ceiling bounds memory as well as
// disk. It is sized for what a phone sends: a photo or a screen recording's
// still is a few megabytes, a PDF rarely more.
const MaxAttachmentSize = 20 << 20 // 20 MiB

// attachmentBodyAllowance is how far past MaxAttachmentSize a request body may
// run. The size ceiling counts file content only, so the body as a whole needs
// a bound of its own — without one a part with no filename is read and thrown
// away for as long as the client cares to send it. A mebibyte is far more than
// boundaries, part headers and the odd form field a browser adds come to.
const attachmentBodyAllowance = 1 << 20 // 1 MiB

// CodeSessionUnknown answers an attachment upload naming a session the
// worktree does not have.
const CodeSessionUnknown = "session_not_found"

// SessionResolver vouches for a worktree and one of its sessions, and says
// where that worktree keeps its session data. worktree.Manager implements it,
// wrapping its ErrWorktreeNotFound and ErrSessionNotFound for the two names it
// does not know; anything else is a fault on this side.
type SessionResolver interface {
	AttachmentDataDir(worktree, sessionID string) (string, error)
}

// AttachmentHandler receives the files a chat message is about to carry.
//
// They go to the session's attachment store rather than into the work
// directory: they are part of the conversation, not of the project, and are
// removed with the session. The message then names them by the ids this
// returns (chat.message's `attachments`), which keeps the bytes off the
// WebSocket connection for the same reason Upload does.
type AttachmentHandler struct {
	base     *Handler
	sessions SessionResolver
	// The resolver's sentinels, passed in so this package does not import the
	// one that owns them.
	worktreeNotFound error
	sessionNotFound  error
}

func NewAttachmentHandler(sessions SessionResolver, worktreeNotFound, sessionNotFound error, log *slog.Logger) *AttachmentHandler {
	return &AttachmentHandler{
		base:             &Handler{log: log, maxUpload: MaxAttachmentSize},
		sessions:         sessions,
		worktreeNotFound: worktreeNotFound,
		sessionNotFound:  sessionNotFound,
	}
}

// UploadedAttachment describes one stored attachment in an upload response.
type UploadedAttachment struct {
	// ID is what chat.message names the file by.
	ID   string `json:"id"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type attachmentUploadResponse struct {
	Files []UploadedAttachment `json:"files"`
}

// Upload stores the files of a multipart request in a session's attachment
// store.
//
// POST /api/chat/attachments?session_id=<id>&worktree=<name>
//
// Uploading the same content twice yields the same id and one file, so a
// client retrying a request that failed partway has nothing to clean up. A file
// uploaded and never sent stays until its session is deleted.
func (a *AttachmentHandler) Upload(w http.ResponseWriter, r *http.Request) {
	h := a.base
	query := r.URL.Query()
	worktreeName := query.Get("worktree")
	sessionID := query.Get("session_id")
	if sessionID == "" {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "session_id is required"), nil)
		return
	}

	dataDir, err := a.sessions.AttachmentDataDir(worktreeName, sessionID)
	if err != nil {
		switch {
		case errors.Is(err, a.sessionNotFound):
			h.writeError(w, errf(http.StatusNotFound, CodeSessionUnknown, "session %q not found", sessionID), nil)
		case errors.Is(err, a.worktreeNotFound):
			h.writeError(w, errf(http.StatusNotFound, CodeWorktreeUnknown, "worktree %q: %v", worktreeName, err), nil)
		default:
			h.log.Error("failed to resolve the session for an attachment upload", "sessionId", sessionID, "worktree", worktreeName, "error", err)
			h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to read session %q: %v", sessionID, err), nil)
		}
		return
	}
	store := attachments.NewStore(dataDir, sessionID)

	tooLarge := errf(http.StatusRequestEntityTooLarge, CodeTooLarge,
		"attachments exceed the %s limit for a single request", formatSize(h.maxUpload))
	tooLarge.limit = h.maxUpload
	// A body over its bound is reported as the same refusal as content over the
	// ceiling: to the client both are one request that was too big, and the
	// ceiling is the only figure it can act on.
	r.Body = http.MaxBytesReader(w, r.Body, h.maxUpload+attachmentBodyAllowance)
	var overBody *http.MaxBytesError

	reader, err := r.MultipartReader()
	if err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "expected a multipart/form-data body: %v", err), nil)
		return
	}

	// A failure reports nothing of what was stored before it, unlike Upload's:
	// the client retries the whole request, which stores nothing twice.
	var stored []UploadedAttachment
	remaining := h.maxUpload
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if errors.As(err, &overBody) {
			h.writeError(w, tooLarge, nil)
			return
		}
		if err != nil {
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "malformed multipart body: %v", err), nil)
			return
		}
		name := part.FileName()
		if name == "" {
			part.Close()
			continue
		}

		// One byte past the budget tells "at the limit" from "over it".
		data, err := io.ReadAll(io.LimitReader(part, remaining+1))
		part.Close()
		if int64(len(data)) > remaining || errors.As(err, &overBody) {
			h.writeError(w, tooLarge, nil)
			return
		}
		if err != nil {
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest,
				"upload of %s was cut short before the file ended: %v", name, err), nil)
			return
		}

		id, err := store.Put(data, attachments.UploadExtension(name))
		if err != nil {
			h.log.Error("failed to store chat attachment", "sessionId", sessionID, "error", err)
			h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to store %s: %v", name, err), nil)
			return
		}
		remaining -= int64(len(data))
		stored = append(stored, UploadedAttachment{ID: id, Name: name, Size: int64(len(data))})
	}

	if len(stored) == 0 {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "no files in request"), nil)
		return
	}
	h.writeJSON(w, http.StatusOK, attachmentUploadResponse{Files: stored})
}
