// Package filetransfer serves whole-file upload and download over HTTP.
//
// These files are too big for the WebSocket RPC path: file.get/file.write carry
// the whole content inside one JSON-RPC message (2 MiB ceiling, see
// docs/file.md), and that connection carries one message at a time, so a large
// one stalls every request the app has in flight on it. HTTP keeps the transfer
// off that connection entirely,
// streams both directions instead of buffering, and gives the browser what it
// already knows how to do with a file: Content-Disposition for a download,
// multipart/form-data for an upload, Range for resuming or chunking a large
// read.
package filetransfer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"syscall"

	"github.com/pockode/server/contents"
)

// MaxUploadSize caps one upload request, counting the content of every file in
// it. Uploads land on the caller's disk and are read into no buffer larger than
// a copy window, so the ceiling is about bounding what a single request can
// cost — disk, and the time the connection is held — not about memory.
//
// It holds for a client on the relay as much as for one on this machine: the
// tunnel carries a request as a stream and imposes no size of its own.
const MaxUploadSize = 32 << 20 // 32 MiB

// Error codes returned in the JSON error body, so a client can react to the
// cause without parsing the message.
const (
	CodeInvalidPath     = "invalid_path"
	CodeInvalidRequest  = "invalid_request"
	CodeNotFound        = "not_found"
	CodeNotAFile        = "not_a_file"
	CodeNotADirectory   = "not_a_directory"
	CodeWorktreeUnknown = "worktree_not_found"
	CodeConflict        = "conflict"
	CodeTooLarge        = "too_large"
	CodeInternal        = "internal"
)

// WorkDirResolver maps a worktree name ("" for the main one) to its directory.
// worktree.Registry implements it.
type WorkDirResolver interface {
	Resolve(name string) (string, error)
}

type Handler struct {
	resolver WorkDirResolver
	log      *slog.Logger
	// maxUpload is MaxUploadSize outside tests, which lower it rather than
	// pushing 32 MiB through a request to see the limit refuse it.
	maxUpload int64
}

func NewHandler(resolver WorkDirResolver, log *slog.Logger) *Handler {
	return &Handler{resolver: resolver, log: log, maxUpload: MaxUploadSize}
}

// UploadedFile describes one stored file in an upload response.
type UploadedFile struct {
	// Path is relative to the work directory, with forward slashes, so it can
	// be handed straight back to file.get.
	Path string `json:"path"`
	Name string `json:"name"`
	Size int64  `json:"size"`
}

type uploadResponse struct {
	Files []UploadedFile `json:"files"`
}

type errorResponse struct {
	Error string `json:"error"`
	Code  string `json:"code"`
	// Limit is the byte ceiling that refused the request, sent only with
	// too_large. It travels with the response so the UI can name the threshold
	// without keeping a second copy of MaxUploadSize — the same reason
	// contents.FileContent carries one.
	Limit int64 `json:"limit,omitempty"`
	// Written lists the files an upload had already stored when it failed. An
	// upload is not a transaction: reporting what survived is the only way the
	// client can tell a total failure from a partial one.
	Written []UploadedFile `json:"written,omitempty"`
}

// apiError is a failure already phrased for the client.
type apiError struct {
	status  int
	code    string
	message string
	limit   int64
}

func (e *apiError) Error() string { return e.message }

func errf(status int, code, format string, args ...any) *apiError {
	return &apiError{status: status, code: code, message: fmt.Sprintf(format, args...)}
}

// Download streams one file from the work directory as an attachment.
//
// GET /api/files/download?path=<relative path>&worktree=<name>
func (h *Handler) Download(w http.ResponseWriter, r *http.Request) {
	workDir, resolveErr := h.workDir(r)
	if resolveErr != nil {
		h.writeError(w, resolveErr, nil)
		return
	}

	relPath := r.URL.Query().Get("path")
	if relPath == "" {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "path is required"), nil)
		return
	}
	if err := contents.ValidatePath(workDir, relPath); err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", relPath), nil)
		return
	}

	fullPath := filepath.Join(workDir, relPath)

	// Stat before opening, like contents.GetContents: opening a fifo blocks
	// until someone writes to it, which would hang the request for good.
	info, statErr := os.Stat(fullPath)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			h.writeError(w, errf(http.StatusNotFound, CodeNotFound, "not found: %s", relPath), nil)
			return
		}
		h.log.Error("failed to stat download target", "path", relPath, "error", statErr)
		h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to stat %s: %v", relPath, statErr), nil)
		return
	}
	if info.IsDir() {
		h.writeError(w, errf(http.StatusBadRequest, CodeNotAFile, "%s is a directory, not a file", relPath), nil)
		return
	}
	if !info.Mode().IsRegular() {
		h.writeError(w, errf(http.StatusBadRequest, CodeNotAFile, "%s is not a regular file", relPath), nil)
		return
	}

	f, err := os.Open(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			h.writeError(w, errf(http.StatusNotFound, CodeNotFound, "not found: %s", relPath), nil)
			return
		}
		h.log.Error("failed to open download target", "path", relPath, "error", err)
		h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to open %s: %v", relPath, err), nil)
		return
	}
	defer f.Close()

	// Re-check on the descriptor: the path could have been swapped for a fifo
	// between the stat and the open, and ServeContent would then block on it.
	fi, err := f.Stat()
	if err != nil {
		h.log.Error("failed to stat download descriptor", "path", relPath, "error", err)
		h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to stat %s: %v", relPath, err), nil)
		return
	}
	if !fi.Mode().IsRegular() {
		h.writeError(w, errf(http.StatusBadRequest, CodeNotAFile, "%s is not a regular file", relPath), nil)
		return
	}

	// Always octet-stream: the response exists to be saved, and naming a real
	// type would invite a browser to render a file from the workspace in the
	// app's own origin. nosniff keeps it from guessing one back.
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Disposition", contentDisposition(fi.Name()))
	// A response with no freshness of its own lets a browser invent one from
	// Last-Modified — around a tenth of the file's age, so hours for a file
	// edited yesterday — and answer the next download from its own cache with
	// the content from before the last edit, silently and without asking here.
	// Refusing storage also keeps the workspace out of the disk cache, which
	// outlives the token that was allowed to read it.
	w.Header().Set("Cache-Control", "no-store")

	// Empty name so ServeContent keeps the Content-Type set above; it still
	// serves Range requests, which is how a client on a relay tunnel keeps each
	// response small enough not to monopolise the shared connection.
	http.ServeContent(w, r, "", fi.ModTime(), f)
}

// Upload stores the files of a multipart request into a directory of the work
// directory.
//
// POST /api/files/upload?path=<relative dir>&worktree=<name>&overwrite=<bool>
func (h *Handler) Upload(w http.ResponseWriter, r *http.Request) {
	workDir, resolveErr := h.workDir(r)
	if resolveErr != nil {
		h.writeError(w, resolveErr, nil)
		return
	}

	query := r.URL.Query()
	destRel := query.Get("path")

	// Refused rather than read as false: a client that meant to replace a file
	// and mistyped the flag would otherwise be told the file already exists,
	// which is true and useless.
	overwrite := false
	if raw := query.Get("overwrite"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "overwrite must be true or false, got %q", raw), nil)
			return
		}
		overwrite = parsed
	}

	if err := contents.ValidatePath(workDir, destRel); err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", destRel), nil)
		return
	}

	destDir := filepath.Join(workDir, destRel)
	info, statErr := os.Stat(destDir)
	if statErr != nil {
		if os.IsNotExist(statErr) {
			h.writeError(w, errf(http.StatusNotFound, CodeNotFound, "destination directory does not exist: %s", displayDir(destRel)), nil)
			return
		}
		h.log.Error("failed to stat upload destination", "path", destRel, "error", statErr)
		h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to stat %s: %v", displayDir(destRel), statErr), nil)
		return
	}
	if !info.IsDir() {
		h.writeError(w, errf(http.StatusBadRequest, CodeNotADirectory, "destination is a file, not a directory: %s", displayDir(destRel)), nil)
		return
	}

	reader, err := r.MultipartReader()
	if err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "expected a multipart/form-data body: %v", err), nil)
		return
	}

	// Streamed part by part rather than through ParseMultipartForm, which would
	// spool the whole request to a temp file first.
	written := make([]UploadedFile, 0, 1)
	remaining := h.maxUpload
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "malformed multipart body: %v", err), written)
			return
		}

		// Non-file fields carry no filename; the destination and the overwrite
		// policy are query parameters, so nothing else is expected here.
		if part.FileName() == "" {
			part.Close()
			continue
		}

		stored, size, apiErr := h.storePart(part, destDir, destRel, overwrite, remaining)
		part.Close()
		if apiErr != nil {
			h.writeError(w, apiErr, written)
			return
		}
		remaining -= size
		written = append(written, stored)
	}

	if len(written) == 0 {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "no files in request"), nil)
		return
	}

	h.writeJSON(w, http.StatusOK, uploadResponse{Files: written})
}

// storePart writes one uploaded file and reports how many content bytes it
// consumed of the request's remaining budget.
func (h *Handler) storePart(part *multipart.Part, destDir, destRel string, overwrite bool, remaining int64) (UploadedFile, int64, *apiError) {
	fileName := part.FileName()

	// Part.FileName has already dropped any directory part of the name (RFC
	// 7578 §4.2), so an upload always lands directly in the destination — a
	// client uploading a folder sends one request per directory. Validated
	// anyway, since what is left can still be "..".
	if err := contents.ValidatePath(destDir, fileName); err != nil {
		return UploadedFile{}, 0, errf(http.StatusBadRequest, CodeInvalidPath, "invalid file name: %s", fileName)
	}

	fullPath := filepath.Join(destDir, fileName)
	relPath := path.Join(filepath.ToSlash(destRel), fileName)

	existing, statErr := os.Lstat(fullPath)
	existed := statErr == nil
	// Only a regular file may be replaced, and this is checked with Lstat, so a
	// symlink is the link itself and not what it points at. An overwrite that
	// followed one would write outside the workspace; an O_WRONLY open of a fifo
	// would block until someone read from it, hanging the request for good.
	if existed {
		switch {
		case existing.IsDir():
			return UploadedFile{}, 0, errf(http.StatusConflict, CodeConflict, "%s is a directory", relPath)
		case !existing.Mode().IsRegular():
			return UploadedFile{}, 0, errf(http.StatusConflict, CodeConflict,
				"%s exists and is not a regular file; refusing to write through it", relPath)
		}
	}

	// O_EXCL is what actually decides a conflict: the check above could be
	// overtaken by an agent creating the file in between.
	//
	// Deliberately a plain write, not a temp file renamed into place, for the
	// same reason contents.WriteFile is: these end up as files in the user's
	// own project, and replacing one by rename breaks hard links, resets the
	// mode, swaps the inode under anything watching it and litters the working
	// tree with .tmp files.
	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	if overwrite {
		flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
	}
	f, err := os.OpenFile(fullPath, flags, 0644)
	if err != nil {
		switch {
		case errors.Is(err, os.ErrExist):
			return UploadedFile{}, 0, errf(http.StatusConflict, CodeConflict,
				"%s already exists; retry with overwrite=true to replace it", relPath)
		case errors.Is(err, syscall.EISDIR):
			return UploadedFile{}, 0, errf(http.StatusConflict, CodeConflict, "%s is a directory", relPath)
		}
		h.log.Error("failed to create uploaded file", "path", relPath, "error", err)
		return UploadedFile{}, 0, errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, err)
	}

	// One byte past the budget is enough to tell "exactly at the limit" from
	// "over it" without reading the rest of what the client is still sending.
	size, copyErr := io.Copy(f, io.LimitReader(part, remaining+1))
	closeErr := f.Close()

	discard := func() {
		if existed {
			// An overwrite has already truncated the user's file; removing it
			// would turn a damaged file into a missing one.
			return
		}
		if err := os.Remove(fullPath); err != nil && !os.IsNotExist(err) {
			h.log.Warn("failed to remove partial upload", "path", relPath, "error", err)
		}
	}

	if size > remaining {
		discard()
		tooLarge := errf(http.StatusRequestEntityTooLarge, CodeTooLarge,
			"upload exceeds the %s limit for a single request", formatSize(h.maxUpload))
		tooLarge.limit = h.maxUpload
		return UploadedFile{}, 0, tooLarge
	}
	if copyErr != nil {
		discard()
		// A body that stops mid-part is the connection's doing, not the disk's:
		// reporting it as a server fault would send the client looking for a
		// problem on this side, and log an error nobody can act on.
		if errors.Is(copyErr, io.ErrUnexpectedEOF) || errors.Is(copyErr, io.EOF) {
			return UploadedFile{}, 0, errf(http.StatusBadRequest, CodeInvalidRequest,
				"upload of %s was cut short before the file ended", relPath)
		}
		h.log.Error("failed to write uploaded file", "path", relPath, "error", copyErr)
		return UploadedFile{}, 0, errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, copyErr)
	}
	if closeErr != nil {
		discard()
		h.log.Error("failed to close uploaded file", "path", relPath, "error", closeErr)
		return UploadedFile{}, 0, errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, closeErr)
	}

	return UploadedFile{Path: relPath, Name: filepath.Base(fullPath), Size: size}, size, nil
}

func (h *Handler) workDir(r *http.Request) (string, *apiError) {
	name := r.URL.Query().Get("worktree")
	workDir, err := h.resolver.Resolve(name)
	if err != nil {
		return "", errf(http.StatusNotFound, CodeWorktreeUnknown, "worktree %q: %v", name, err)
	}
	return workDir, nil
}

func (h *Handler) writeError(w http.ResponseWriter, err *apiError, written []UploadedFile) {
	h.writeJSON(w, err.status, errorResponse{Error: err.message, Code: err.code, Limit: err.limit, Written: written})
}

// formatSize names a byte count the way the limit is written down, so a message
// about it reads like the documentation. Whole MiB only: a limit lowered below
// one (as tests do) would otherwise be reported as "0 MiB".
func formatSize(bytes int64) string {
	const mib = 1 << 20
	if bytes >= mib && bytes%mib == 0 {
		return fmt.Sprintf("%d MiB", bytes/mib)
	}
	return fmt.Sprintf("%d bytes", bytes)
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		h.log.Error("failed to encode file transfer response", "error", err)
	}
}

// contentDisposition names the download without letting the file name break out
// of the header: FormatMediaType quotes and, for a non-ASCII name, RFC 2231
// encodes it. A name it cannot represent leaves the browser to fall back on the
// URL, which is better than emitting a malformed header.
func contentDisposition(name string) string {
	if formatted := mime.FormatMediaType("attachment", map[string]string{"filename": name}); formatted != "" {
		return formatted
	}
	return "attachment"
}

// displayDir names the work directory itself in an error message, since the
// empty path that means it would otherwise read as a missing value.
func displayDir(relPath string) string {
	if relPath == "" {
		return "the work directory"
	}
	return relPath
}
