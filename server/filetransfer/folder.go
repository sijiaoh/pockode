package filetransfer

import (
	"errors"
	"io"
	"io/fs"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"

	"github.com/pockode/server/contents"
)

// folderDirField names the form field that declares a directory of the folder,
// so one with nothing in it — which no file part can describe — still arrives.
const folderDirField = "dir"

// maxEntryPathSize bounds the path of one entry inside the folder, and
// maxEntryNameSize one component of it — 255 bytes is the name limit of every
// file system the server runs on. They keep a path from costing more than its
// length: a part header may run to megabytes, and os.Root walks a path one
// component at a time, so no PATH_MAX would stop a path of a million "a/".
const (
	maxEntryPathSize = 4096
	maxEntryNameSize = 255
)

// MaxFolderEntries caps the files and directories one folder upload may
// create. MaxUploadSize does not bound them — an empty file or a directory
// costs no content — and each one costs memory for the request's own
// bookkeeping and the response. It sits far above what a person drops on
// purpose, as a backstop for a client's own, lower cap.
const MaxFolderEntries = 10_000

// CodeTooManyEntries refuses a folder upload over MaxFolderEntries. A code of
// its own because too_large's limit is in bytes.
const CodeTooManyEntries = "too_many_entries"

// UploadedFolder names the folder an upload wrote into.
type UploadedFolder struct {
	// Path is relative to the work directory, with forward slashes, as
	// UploadedFile.Path is.
	Path string `json:"path"`
	Name string `json:"name"`
}

type folderUploadResponse struct {
	Folder UploadedFolder `json:"folder"`
	Files  []UploadedFile `json:"files"`
}

// UploadFolder stores a multipart request's files beneath a folder of a
// directory of the work directory, each at the path its part names relative to
// that folder.
//
// By default the folder must be new, and the upload is all or nothing: the
// folder is the request's own until the last part is stored, and is removed
// whole if any part fails. With merge=true an existing folder is written into
// instead, replacing regular files at the same paths; that cannot be undone,
// so it is not a transaction, and a failure reports what was stored.
//
// POST /api/files/upload-folder?path=<relative dir>&name=<folder name>&merge=<bool>&worktree=<name>
func (h *Handler) UploadFolder(w http.ResponseWriter, r *http.Request) {
	workDir, resolveErr := h.workDir(r)
	if resolveErr != nil {
		h.writeError(w, resolveErr, nil)
		return
	}

	query := r.URL.Query()
	destRel := query.Get("path")
	name := query.Get("name")

	// Refused rather than ignored: replacing files is what merge does, and a
	// client that sent overwrite expected it of a request that, without merge,
	// would refuse the existing folder instead.
	if query.Has("overwrite") {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest,
			"a folder upload has no overwrite; use merge=true to write into an existing folder"), nil)
		return
	}
	merge := false
	if raw := query.Get("merge"); raw != "" {
		parsed, err := strconv.ParseBool(raw)
		if err != nil {
			h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "merge must be true or false, got %q", raw), nil)
			return
		}
		merge = parsed
	}
	if err := contents.ValidatePath(workDir, destRel); err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", destRel), nil)
		return
	}
	if validateEntryName(name) != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid folder name: %q", name), nil)
		return
	}

	reader, err := newMultipartBody(r)
	if err != nil {
		h.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "expected a multipart/form-data body: %v", err), nil)
		return
	}

	root, apiErr := h.openDir(workDir, destRel, "destination")
	if apiErr != nil {
		h.writeError(w, apiErr, nil)
		return
	}
	defer root.Close()

	folderRel := path.Join(filepath.ToSlash(destRel), name)
	folder, created, apiErr := h.claimFolder(root, name, folderRel, merge)
	if apiErr != nil {
		h.writeError(w, apiErr, nil)
		return
	}

	u := folderUpload{h: h, folder: folder, folderRel: folderRel, merge: merge, remaining: h.maxUpload}
	apiErr = u.receive(reader)
	folder.Close()
	if apiErr != nil {
		// What was stored is reported only if it is still there: an upload
		// that removed its folder left nothing for the client to account for.
		written := u.stored
		if created {
			apiErr = h.discardFolder(root, name, folderRel, apiErr)
			if !apiErr.folderLeft {
				written = nil
			}
		}
		h.writeError(w, apiErr, written)
		return
	}

	h.writeJSON(w, http.StatusOK, folderUploadResponse{
		Folder: UploadedFolder{Path: folderRel, Name: name},
		Files:  u.stored,
	})
}

// openDir opens the existing directory rel names — what names it in errors —
// with every link on the way followed, provided where it leads is still inside
// the work directory (contents.OpenDirWithin); from there everything goes
// through roots rather than joined paths.
func (h *Handler) openDir(workDir, rel, what string) (*os.Root, *apiError) {
	work, err := os.OpenRoot(workDir)
	if err != nil {
		return nil, h.internalFailure("open", "the work directory", err)
	}
	defer work.Close()

	dest, _, _, err := contents.OpenDirWithin(work, rel)
	switch {
	case err == nil:
		return dest, nil
	case errors.Is(err, contents.ErrNotFound):
		return nil, errf(http.StatusNotFound, CodeNotFound, "%s does not exist: %s", what, contents.DisplayDir(rel))
	case errors.Is(err, contents.ErrNotADirectory):
		return nil, errf(http.StatusBadRequest, CodeNotADirectory, "%s is a file, not a directory: %s", what, contents.DisplayDir(rel))
	case errors.Is(err, contents.ErrInvalidPath):
		// Logged rather than answered: the reason holds host paths. One answer
		// for all of them, since it does not matter which it was — a link out,
		// the directory swapped while it was opened, or a resolution that
		// failed — and none of them is a directory this request can use.
		h.log.Warn("directory for transfer does not resolve inside the work directory", "path", rel, "error", err)
		return nil, errf(http.StatusBadRequest, CodeInvalidPath,
			"%s is outside the work directory or could not be resolved within it: %s", what, contents.DisplayDir(rel))
	default:
		h.log.Error("failed to open directory for transfer", "path", rel, "error", err)
		return nil, errf(http.StatusInternalServerError, CodeInternal, "failed to open %s", contents.DisplayDir(rel))
	}
}

// claimFolder opens the folder an upload writes into, and reports whether this
// request created it — which is what makes it the request's own to remove.
//
// Mkdir is what claims the name, as O_EXCL does for a single file: a check
// before it could be overtaken by an agent creating the same folder. It also
// refuses a symlink on the name, dangling or not, rather than follow it. Having
// made the folder, everything beneath it is new by construction, which is why
// nothing inside can conflict with the user's files and why removing it whole
// on failure takes nothing of theirs.
func (h *Handler) claimFolder(root *os.Root, name, folderRel string, merge bool) (*os.Root, bool, *apiError) {
	created := true
	if err := root.Mkdir(name, 0755); err != nil {
		if isInvalidName(err) {
			return nil, false, errf(http.StatusBadRequest, CodeInvalidPath, "%s is not a name this file system accepts: %v", folderRel, errors.Unwrap(err))
		}
		if !errors.Is(err, fs.ErrExist) {
			h.log.Error("failed to create uploaded folder", "path", folderRel, "error", err)
			return nil, false, errf(http.StatusInternalServerError, CodeInternal, "failed to create %s: %v", folderRel, err)
		}
		if !merge {
			return nil, false, errf(http.StatusConflict, CodeConflict,
				"%s already exists; retry with merge=true to write into it, or upload it under another name", folderRel)
		}
		created = false
		// Lstat first, so a file or a link on the name is answered for what it
		// is rather than as the open failing on it — or, for a link that stays
		// in the project, succeeding through it.
		if info, err := root.Lstat(name); err == nil && !info.IsDir() {
			return nil, false, errf(http.StatusConflict, CodeConflict,
				"%s exists and is not a folder; a merge writes into folders only", folderRel)
		}
	}

	folder, err := root.OpenRoot(name)
	if err != nil {
		h.log.Error("failed to open uploaded folder", "path", folderRel, "error", err)
		apiErr := errf(http.StatusInternalServerError, CodeInternal, "failed to open %s: %v", folderRel, err)
		if created {
			apiErr = h.discardFolder(root, name, folderRel, apiErr)
		}
		return nil, false, apiErr
	}

	// OpenRoot follows a link on the name, so what it opened is checked against
	// the name itself once more: the name may have been swapped for a link
	// since the Mkdir or the Lstat, and a merge through a link would write
	// wherever it points — the single-file upload refuses to write through one
	// too. Nothing is removed then, not even a folder this request made: what
	// is on the name now is not that folder.
	onName, lstatErr := root.Lstat(name)
	openedInfo, statErr := folder.Stat(".")
	if lstatErr != nil || statErr != nil || !onName.IsDir() || !os.SameFile(onName, openedInfo) {
		folder.Close()
		return nil, false, errf(http.StatusConflict, CodeConflict, "%s changed while the upload was opening it", folderRel)
	}
	return folder, created, nil
}

// discardFolder removes a folder whose upload failed and returns the error to
// report. A folder that cannot be removed is said so, since the client would
// otherwise believe nothing was left behind.
//
// Whole, without looking inside: whatever is in the folder is the request's
// own, short of something else writing into a folder seconds old and unknown
// to it — which, failing, it would have had to redo regardless.
func (h *Handler) discardFolder(root *os.Root, name, folderRel string, cause *apiError) *apiError {
	err := root.RemoveAll(name)
	if err == nil {
		return cause
	}
	h.log.Warn("failed to remove partial folder upload", "path", folderRel, "error", err)
	cause.message += "; the partly uploaded folder " + folderRel + " could not be removed: " + err.Error()
	cause.folderLeft = true
	return cause
}

// entryNode is one name the request has declared inside the folder. A tree
// rather than a set of whole paths, so that what the request named costs
// memory in proportion to its length rather than to the square of its depth.
type entryNode struct {
	isDir bool
	// made marks a directory this request has already created, or found and
	// checked in a merge, so the files beneath it do not pay for that again —
	// each check walks the path from the folder, so repeating it per file
	// would cost a deep path the square of its depth.
	made     bool
	children map[string]*entryNode
	// folded groups children by lower case, for the case-insensitive file
	// systems on which two of them are one entry.
	folded map[string][]string
}

// folderUpload is the state of one folder upload while its parts arrive.
type folderUpload struct {
	h         *Handler
	folder    *os.Root
	folderRel string
	merge     bool
	// declared is every path the request has named so far, relative to the
	// folder. It is what tells a client's duplicate or file-versus-folder clash
	// from a fault of this side, the same way on every platform, before
	// anything is written.
	declared  entryNode
	entries   int
	remaining int64
	stored    []UploadedFile
}

func (u *folderUpload) receive(reader *multipartBody) *apiError {
	u.stored = make([]UploadedFile, 0, 1)
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return errf(http.StatusBadRequest, CodeInvalidRequest, "malformed multipart body: %v", err)
		}
		apiErr := u.receivePart(part)
		part.Close()
		if apiErr != nil {
			return apiErr
		}
	}
}

// receivePart stores one part. A part that is neither a file nor a directory
// declaration is refused rather than skipped: a file part whose header did not
// parse looks exactly like one, and skipping it would answer 200 for a folder
// missing that file.
func (u *folderUpload) receivePart(part *multipart.Part) *apiError {
	// Part.FileName drops everything up to the last separator (RFC 7578 §4.2),
	// which is the very path this endpoint is here to keep, so the name is read
	// from the header itself and every component of it validated instead.
	disposition, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	if err != nil || disposition != "form-data" {
		return errf(http.StatusBadRequest, CodeInvalidRequest, "malformed Content-Disposition on a part: %q", part.Header.Get("Content-Disposition"))
	}
	if fileName, ok := params["filename"]; ok {
		return u.storeFile(part, fileName)
	}
	if params["name"] != folderDirField {
		return errf(http.StatusBadRequest, CodeInvalidRequest,
			"unexpected part %q: a folder upload takes file parts and %q fields only", params["name"], folderDirField)
	}
	value, err := io.ReadAll(io.LimitReader(part, maxEntryPathSize+1))
	if err != nil {
		return errf(http.StatusBadRequest, CodeInvalidRequest, "malformed multipart body: %v", err)
	}
	return u.makeDir(string(value))
}

func (u *folderUpload) makeDir(rel string) *apiError {
	nodes, apiErr := u.declare(rel, true)
	if apiErr != nil {
		return apiErr
	}
	return u.mkdirAll(strings.Split(rel, "/"), nodes)
}

// mkdirAll creates the directory the slash-separated components name, and
// every one above it; nodes are their entries in declared.
func (u *folderUpload) mkdirAll(components []string, nodes []*entryNode) *apiError {
	from := 0
	for from < len(nodes) && nodes[from].made {
		from++
	}
	if from == len(nodes) {
		return nil
	}
	// Before, not after: in a folder of the user's, a link on the way is
	// followed by MkdirAll as long as it stays in the folder, and a file
	// would then land somewhere other than the path it is reported under.
	if u.merge {
		if apiErr := u.refuseNonDirectory(components, from); apiErr != nil {
			return apiErr
		}
	}
	rel := strings.Join(components, "/")
	if err := u.folder.MkdirAll(filepath.FromSlash(rel), 0755); err != nil {
		return u.writeFailure(rel, err)
	}
	for _, node := range nodes[from:] {
		node.made = true
	}
	return nil
}

// refuseNonDirectory refuses components if one of them, from the index from
// on, exists in the folder as something other than a directory: a file, which
// a merge never turns into a folder, or a symlink, which it never writes
// through. Those before from were checked for an earlier entry.
func (u *folderUpload) refuseNonDirectory(components []string, from int) *apiError {
	for i := from; i < len(components); i++ {
		prefix := filepath.Join(components[:i+1]...)
		info, err := u.folder.Lstat(prefix)
		if err != nil {
			return nil
		}
		if info.IsDir() {
			continue
		}
		return errf(http.StatusConflict, CodeConflict,
			"%s exists and is not a folder; a merge never turns a file into a folder or writes through a link",
			path.Join(u.folderRel, filepath.ToSlash(prefix)))
	}
	return nil
}

func (u *folderUpload) storeFile(part *multipart.Part, rel string) *apiError {
	nodes, apiErr := u.declare(rel, false)
	if apiErr != nil {
		return apiErr
	}
	name := filepath.FromSlash(rel)
	relPath := path.Join(u.folderRel, rel)
	components := strings.Split(rel, "/")
	if apiErr := u.mkdirAll(components[:len(components)-1], nodes[:len(nodes)-1]); apiErr != nil {
		return apiErr
	}

	flags := os.O_WRONLY | os.O_CREATE | os.O_EXCL
	existed := false
	if u.merge {
		// The same rule as Upload with overwrite: only a regular file is
		// replaced, decided by Lstat before the open, because for anything else
		// the open is the damage — through a link it writes elsewhere, on a
		// fifo it blocks for good.
		if info, err := u.folder.Lstat(name); err == nil {
			if apiErr := u.refuseReplacing(info, relPath); apiErr != nil {
				return apiErr
			}
			existed = true
			// Non-blocking as well, for a fifo swapped in after the Lstat: the
			// open then fails, or succeeds and is refused below, instead of
			// waiting for a reader that never comes.
			flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC | openNonBlock
		}
	}

	// A plain write, as Upload's is, not a temp file renamed into place: a
	// merge replaces the user's own files, whose inode, mode and hard links a
	// rename would not keep.
	f, err := u.folder.OpenFile(name, flags, 0644)
	if err != nil {
		if existed {
			if info, lstatErr := u.folder.Lstat(name); lstatErr == nil && !info.Mode().IsRegular() {
				return u.refuseReplacing(info, relPath)
			}
		}
		return u.writeFailure(rel, err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		u.h.log.Error("failed to stat uploaded file", "path", relPath, "error", err)
		return errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, err)
	}
	if !info.Mode().IsRegular() {
		f.Close()
		return u.refuseReplacing(info, relPath)
	}

	size, apiErr := u.h.copyPart(f, part, relPath, u.remaining)
	closeErr := f.Close()
	if apiErr == nil && closeErr != nil {
		u.h.log.Error("failed to close uploaded file", "path", relPath, "error", closeErr)
		apiErr = errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, closeErr)
	}
	if apiErr != nil {
		// A folder this request created goes whole; in a merge, a file it
		// created goes alone. One it replaced has already been truncated, and
		// removing it would turn a damaged file into a missing one.
		if u.merge && !existed {
			if err := u.folder.Remove(name); err != nil && !os.IsNotExist(err) {
				u.h.log.Warn("failed to remove partial upload", "path", relPath, "error", err)
			}
		}
		return apiErr
	}
	u.remaining -= size
	u.stored = append(u.stored, UploadedFile{Path: relPath, Name: path.Base(rel), Size: size})
	return nil
}

// refuseReplacing refuses to write over info, found at relPath during a merge,
// unless it is a regular file of the user's.
func (u *folderUpload) refuseReplacing(info os.FileInfo, relPath string) *apiError {
	switch {
	case info.IsDir():
		return errf(http.StatusConflict, CodeConflict, "%s is a directory", relPath)
	case !info.Mode().IsRegular():
		return errf(http.StatusConflict, CodeConflict,
			"%s exists and is not a regular file; refusing to write through it", relPath)
	}
	return nil
}

// declare records rel, a slash-separated path inside the folder, refusing any
// spelling that is not one plain name after another — so no "..", no ".", no
// empty component, no leading or trailing slash — and any clash with what the
// request has already named. It returns the entry of each component, in
// order.
func (u *folderUpload) declare(rel string, isDir bool) ([]*entryNode, *apiError) {
	if len(rel) > maxEntryPathSize {
		return nil, errf(http.StatusBadRequest, CodeInvalidPath, "path in folder longer than %d bytes", maxEntryPathSize)
	}
	components := strings.Split(rel, "/")
	for _, c := range components {
		if validateEntryName(c) != nil {
			return nil, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path in folder: %q", rel)
		}
	}

	node := &u.declared
	nodes := make([]*entryNode, 0, len(components))
	for i, c := range components {
		last := i == len(components)-1
		child, seen := node.children[c]
		if !seen {
			if u.entries >= MaxFolderEntries {
				tooMany := errf(http.StatusRequestEntityTooLarge, CodeTooManyEntries,
					"a folder upload may create at most %d files and folders", MaxFolderEntries)
				tooMany.limit = MaxFolderEntries
				return nil, tooMany
			}
			prefix := strings.Join(components[:i+1], "/")
			if apiErr := u.refuseFolded(node, prefix, c); apiErr != nil {
				return nil, apiErr
			}
			if node.children == nil {
				node.children = map[string]*entryNode{}
				node.folded = map[string][]string{}
			}
			child = &entryNode{isDir: !last || isDir}
			node.children[c] = child
			key := strings.ToLower(c)
			node.folded[key] = append(node.folded[key], c)
			u.entries++
			nodes = append(nodes, child)
			node = child
			continue
		}
		at := path.Join(u.folderRel, strings.Join(components[:i+1], "/"))
		// A directory named twice is the same directory; anything else named
		// twice would silently keep one of two contents, or one of two kinds.
		switch {
		case !last && !child.isDir, last && isDir != child.isDir:
			return nil, errf(http.StatusBadRequest, CodeInvalidPath, "%s is both a file and a folder in the upload", at)
		case last && !isDir:
			return nil, errf(http.StatusBadRequest, CodeInvalidPath, "%s appears more than once in the upload", at)
		}
		nodes = append(nodes, child)
		node = child
	}
	return nodes, nil
}

// validateEntryName is file.rename's rule for a name, plus what keeps a name
// meaning the same thing on every platform the server runs on. Windows drops a
// trailing dot or space from a name — os.Root passes every path through
// GetFullPathName — so "a." would be stored as "a" and "..." would name the
// folder itself; refusing them everywhere keeps a folder that uploads on one
// platform uploading on the others.
func validateEntryName(name string) error {
	if err := contents.ValidateName(name); err != nil {
		return err
	}
	if len(name) > maxEntryNameSize || strings.ContainsRune(name, 0) ||
		strings.HasSuffix(name, ".") || strings.HasSuffix(name, " ") {
		return contents.ErrInvalidPath
	}
	return nil
}

// refuseFolded refuses c, about to be declared under node at prefix, if the
// file system already holds it as an entry the request made under another
// spelling: README.md after readme.md, or Src/ after src/, where letter case
// is not part of a name (macOS and Windows as shipped). Left alone, a file
// would replace one of the request's own, or land under a directory spelled
// otherwise than the path it is reported under.
//
// Asked of the disk rather than decided by spelling, because only the file
// system knows whether it folds case, and how. In a folder the request made,
// nothing exists that it did not declare, so a new name found there at all is
// such a collision — whatever the folding, Unicode normalization included. In
// a merge the user's own entries are there too, so it is one only if it is
// the very entry a spelling the request already used names.
func (u *folderUpload) refuseFolded(node *entryNode, prefix, c string) *apiError {
	name := filepath.FromSlash(prefix)
	info, err := u.folder.Lstat(name)
	if err != nil {
		return nil
	}
	if !u.merge {
		return caseCollision(path.Join(u.folderRel, prefix))
	}
	parent := path.Dir(prefix)
	for _, other := range node.folded[strings.ToLower(c)] {
		otherInfo, err := u.folder.Lstat(filepath.FromSlash(path.Join(parent, other)))
		if err == nil && os.SameFile(info, otherInfo) {
			return caseCollision(path.Join(u.folderRel, prefix))
		}
	}
	return nil
}

func caseCollision(relPath string) *apiError {
	return errf(http.StatusBadRequest, CodeInvalidPath,
		"%s collides with another entry of the upload; names that differ only in letter case are one name on this file system", relPath)
}

// writeFailure phrases a failure to create rel inside the folder.
func (u *folderUpload) writeFailure(rel string, err error) *apiError {
	relPath := path.Join(u.folderRel, rel)
	if u.merge && errors.Is(err, fs.ErrExist) {
		// The Lstat before the open found nothing there: something else made
		// it since.
		return errf(http.StatusConflict, CodeConflict, "%s was created by something else during the upload", relPath)
	}
	// In a folder the request created, "exists" can only be the request
	// colliding with itself in a way declare could not see: two names this
	// file system holds to be one, as a case-insensitive one does with
	// README.md and readme.md. ENOTDIR is the same collision met on the way
	// down: a file where the request has a folder of a name that differs only
	// in case.
	if errors.Is(err, fs.ErrExist) || errors.Is(err, syscall.ENOTDIR) {
		return caseCollision(relPath)
	}
	if isInvalidName(err) {
		return errf(http.StatusBadRequest, CodeInvalidPath, "%s is not a name this file system accepts: %v", relPath, errors.Unwrap(err))
	}
	u.h.log.Error("failed to write uploaded folder entry", "path", relPath, "error", err)
	return errf(http.StatusInternalServerError, CodeInternal, "failed to write %s: %v", relPath, err)
}
