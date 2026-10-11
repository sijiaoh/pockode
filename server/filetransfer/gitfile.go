package filetransfer

import (
	"errors"
	"io"
	"net/http"
	"path"
	"strconv"

	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
)

// GitFile streams one file as it stood in a commit — the bytes git.show.file
// describes but does not carry for a raster image (contents.EncodingHTTP),
// since that version is not in the work directory for Download to reach.
//
// GET /api/git/show/file?hash=<commit>&path=<repository path>&worktree=<name>
//
// Same headers as Download. No Range: the content comes off a git pipe, not a
// seekable file, and what reads this is an image fetched whole.
func (h *Handler) GitFile(w http.ResponseWriter, r *http.Request) {
	workDir, resolveErr := h.workDir(r)
	if resolveErr != nil {
		h.writeError(w, resolveErr, nil)
		return
	}

	query := r.URL.Query()
	hash := query.Get("hash")
	relPath := query.Get("path")
	if hash == "" || relPath == "" {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "hash and path are required"), nil)
		return
	}

	blob, err := git.OpenFile(r.Context(), workDir, hash, relPath)
	if err != nil {
		switch {
		case errors.Is(err, git.ErrInvalidArgument):
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "%v", err), nil)
		case errors.Is(err, contents.ErrNotFound):
			h.writeError(w, errf(http.StatusNotFound, CodeNotFound, "%s not found in commit %s", relPath, hash), nil)
		case errors.Is(err, contents.ErrInvalidPath):
			h.writeError(w, errf(http.StatusBadRequest, CodeNotAFile, "%s is not a file in commit %s", relPath, hash), nil)
		default:
			h.log.Error("failed to open file in commit", "hash", hash, "path", relPath, "error", err)
			h.writeError(w, errf(http.StatusInternalServerError, CodeInternal, "failed to read %s in commit %s: %v", relPath, hash, err), nil)
		}
		return
	}

	setContentHeaders(w, path.Base(relPath))
	w.Header().Set("Content-Length", strconv.FormatInt(blob.Size, 10))
	_, copyErr := io.Copy(w, blob)
	// The status line is already sent, so a failure from here on can only be
	// logged; the short body is what tells the client.
	if closeErr := blob.Close(); closeErr != nil {
		h.log.Error("git failed while streaming file in commit", "hash", hash, "path", relPath, "error", closeErr)
	} else if copyErr != nil {
		h.log.Debug("stopped streaming file in commit", "hash", hash, "path", relPath, "error", copyErr)
	}
}
