package filetransfer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pockode/server/apiroute"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/authsession"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
)

// RawPathPrefix is where the raw endpoint answers. A request is
// RawPathPrefix + <capability> + "/" + <path within the grant>.
const RawPathPrefix = apiroute.RawPrefix

const (
	// CodeCapabilityUnknown answers a capability that was never issued, has
	// expired, or outlived its session. The client's remedy is to issue another.
	CodeCapabilityUnknown = "capability_not_found"
	// CodeOutsideScope answers a path the capability does not reach.
	CodeOutsideScope = "outside_scope"
)

// RawOrigin is where the content a capability grants lives — the same three
// places a client already reads a file from.
type RawOrigin string

const (
	// RawOriginFile is the work directory of Worktree.
	RawOriginFile RawOrigin = "file"
	// RawOriginCommit is commit Hash of Worktree's repository.
	RawOriginCommit RawOrigin = "commit"
	// RawOriginAttachment is the attachment store of session SessionID in
	// Worktree, which may be a worktree that no longer exists, as for
	// AttachmentHandler.Download.
	RawOriginAttachment RawOrigin = "attachment"
)

// RawScope is how much of the origin a capability reaches.
type RawScope string

const (
	// RawScopeFile reaches the one file Path names.
	RawScopeFile RawScope = "file"
	// RawScopeDirectory reaches directory Path and everything beneath it
	// except dotfiles. It is for a page whose relative URLs load its
	// stylesheets, scripts and images; the page's own directory, never more,
	// so that the page's scripts cannot read anything else in the project.
	//
	// Nothing whose path has a dot-prefixed component, beneath the scope or
	// above it: a page sits beside the .env of its app, and a page inside
	// .git or .pockode would hand its scripts the repository or Pockode's own
	// data. A dotfile the user means to see takes a file scope of its own. The
	// price is that a build inside a dot directory (docs/.vitepress/dist,
	// .output/public) gets only a file scope, as a page at the root does.
	//
	// The check is on the name asked for and, for a work-directory file, on
	// the name the file system resolves it to (resolvedName): on Windows a
	// short name such as ENV~1 is another spelling of .env. A link beneath
	// the scope that leads to a dotfile also beneath it is served on unix, as
	// anything a link inside the scope leads to is.
	//
	// Never the root of the origin, even for a page that sits there. The
	// capability is in the page's own URL, where its scripts can read it and
	// send it anywhere; at the root it would reach the project's secrets, its
	// .git and — by default — Pockode's own data directory, sessions included.
	RawScopeDirectory RawScope = "directory"
)

// RawGrant is what one capability lets its bearer read.
type RawGrant struct {
	Origin   RawOrigin
	Scope    RawScope
	Worktree string
	// Hash is the commit, for RawOriginCommit.
	Hash string
	// SessionID is the session whose attachment store holds the content, for
	// RawOriginAttachment.
	SessionID string
	// Path is, with forward slashes, the work-directory path, the repository
	// path in the commit, or the attachment id.
	Path string
}

// ErrInvalidGrant refuses to issue a capability for a grant that names nothing
// a request could reach.
var ErrInvalidGrant = errors.New("invalid raw grant")

func (g RawGrant) validate() error {
	if g.Scope != RawScopeFile && g.Scope != RawScopeDirectory {
		return fmt.Errorf("%w: unknown scope %q", ErrInvalidGrant, g.Scope)
	}
	// IsLocal refuses "" and a way out; the root itself, which a directory
	// scope must never be, is what the path cleans to in every spelling.
	if !filepath.IsLocal(filepath.FromSlash(g.Path)) || cleanGrantPath(g.Path) == "." {
		return fmt.Errorf("%w: path %q must name something beneath the root of its origin", ErrInvalidGrant, g.Path)
	}
	if g.Scope == RawScopeDirectory && hasDotComponent(cleanGrantPath(g.Path)) {
		return fmt.Errorf("%w: directory %q is or lies within a dot directory", ErrInvalidGrant, g.Path)
	}

	switch g.Origin {
	case RawOriginFile:
	case RawOriginCommit:
		if g.Hash == "" {
			return fmt.Errorf("%w: a commit grant needs a hash", ErrInvalidGrant)
		}
	case RawOriginAttachment:
		// An attachment store is flat and holds one conversation's content, not
		// a tree whose files refer to each other.
		if g.Scope != RawScopeFile {
			return fmt.Errorf("%w: an attachment grant reaches one file", ErrInvalidGrant)
		}
		if g.SessionID == "" {
			return fmt.Errorf("%w: an attachment grant needs a session", ErrInvalidGrant)
		}
	default:
		return fmt.Errorf("%w: unknown origin %q", ErrInvalidGrant, g.Origin)
	}
	return nil
}

// cleanGrantPath is a grant's path in the one form it is checked and stored in.
// Cleaned natively rather than with path.Clean: on Windows a "\" separates too,
// and "a\.." left uncleaned would pass for something beneath the root while
// opening as the root itself.
func cleanGrantPath(p string) string {
	return filepath.ToSlash(filepath.Clean(filepath.FromSlash(p)))
}

// hasDotComponent reports whether any component of p, a slash path, starts
// with a dot. Split on the native separator as well, as openScope does: on
// Windows "site\.env" is "site/.env".
func hasDotComponent(p string) bool {
	for _, name := range strings.Split(filepath.FromSlash(p), string(filepath.Separator)) {
		if strings.HasPrefix(name, ".") {
			return true
		}
	}
	return false
}

// RawEntryPath is the URL path a grant issued as capability is opened at: the
// file itself for a file scope, the directory with a trailing slash for a
// directory scope, against which a path beneath it resolves as a relative URL.
func RawEntryPath(capability string, grant RawGrant) string {
	if grant.Scope == RawScopeDirectory {
		return RawPath(capability, "")
	}
	return RawPath(capability, path.Base(cleanGrantPath(grant.Path)))
}

// RawPath is the URL path that reads rel within a capability: the file's own
// name for a file scope, a path beneath the directory for a directory scope.
func RawPath(capability, rel string) string {
	segments := strings.Split(rel, "/")
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	return RawPathPrefix + capability + "/" + strings.Join(segments, "/")
}

// RawHandler serves workspace content to a browser element that loads it by
// itself — a <video>, an <audio>, an <iframe> — and so cannot send an
// Authorization header. The credential is a capability in the URL's path,
// where a page's relative URLs inherit it.
//
// GET /api/raw/<capability>/<path>
//
// Unlike Download, the content is served as what it is: the element has to
// play or render it. What keeps that out of the app's origin is the
// Content-Security-Policy sandbox on every response, which gives a document
// opened from here — top-level or framed — an opaque origin of its own, where
// the login token is out of reach.
//
// That opaque origin is also why every response allows any origin: a module
// script, a font or a fetch() is loaded in CORS mode, and from an opaque
// origin it is cross-origin even to here. Credentials are never allowed; the
// capability that authorizes the read is in the URL. It does let the page's
// own scripts read what the scope reaches and send the bytes out, where
// without it they could send only the URL — useless to whoever cannot reach
// this server, as on a server kept to its LAN. That is why a scope reaches as
// little as it does, dotfiles included.
type RawHandler struct {
	files        *Handler
	attachments  *AttachmentHandler
	capabilities *authsession.Capabilities[RawGrant]
}

func NewRawHandler(sessions *authsession.Store, files *Handler, attachments *AttachmentHandler) *RawHandler {
	return &RawHandler{
		files:        files,
		attachments:  attachments,
		capabilities: authsession.NewCapabilities[RawGrant](sessions),
	}
}

// Issue returns a capability for grant, bound to the session sessionToken,
// and when it expires. It checks only that the grant is well-formed: whether
// its content exists is a question for each request, since content comes and
// goes while a capability lives. The error is ErrInvalidGrant or
// authsession.ErrSessionNotLive for the caller's mistakes, anything else a
// fault here.
func (h *RawHandler) Issue(sessionToken string, grant RawGrant) (string, time.Time, error) {
	if err := grant.validate(); err != nil {
		return "", time.Time{}, err
	}
	// Kept clean, so that a file is matched by the base name RawEntryPath
	// gives it: "dir/a.mp4/." is "a.mp4", not ".".
	grant.Path = cleanGrantPath(grant.Path)
	return h.capabilities.Issue(sessionToken, grant)
}

func (h *RawHandler) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w := &rawResponseWriter{ResponseWriter: rw}

	if r.Method == http.MethodOptions {
		// A preflight carries no capability to check — the browser sends it
		// before the request it asks about — and it reads nothing. Whatever
		// headers it asks for are allowed: without credentials and with only
		// reads served, a header can change nothing but what a page's library
		// gets back, such as a multi-range Range, which is not safelisted.
		header := w.Header()
		header.Set("Allow", rawMethods)
		header.Set("Access-Control-Allow-Methods", rawMethods)
		if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
			header.Set("Access-Control-Allow-Headers", requested)
		}
		header.Add("Vary", "Access-Control-Request-Headers")
		header.Set("Access-Control-Max-Age", "86400")
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", rawMethods)
		h.files.writeError(w, errf(http.StatusMethodNotAllowed, CodeInvalidRequest, "method %s is not allowed", r.Method), nil)
		return
	}

	capability, rel, _ := strings.Cut(strings.TrimPrefix(r.URL.Path, RawPathPrefix), "/")
	grant, ok := h.capabilities.Resolve(capability)
	if !ok {
		h.files.writeError(w, errf(http.StatusNotFound, CodeCapabilityUnknown, "capability is unknown, expired, or its session has ended"), nil)
		return
	}

	// The lexical check comes first for every origin, so `..` is refused the
	// same way whichever one would have been asked to resolve it.
	if rel == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
		h.files.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", rel), nil)
		return
	}
	if grant.Scope == RawScopeFile && rel != path.Base(grant.Path) ||
		grant.Scope == RawScopeDirectory && hasDotComponent(rel) {
		h.files.writeError(w, errf(http.StatusForbidden, CodeOutsideScope, "%s is outside this capability", rel), nil)
		return
	}

	switch grant.Origin {
	case RawOriginFile:
		h.serveWorkDirFile(w, r, grant, rel)
	case RawOriginCommit:
		h.serveCommitFile(w, r, grant, rel)
	case RawOriginAttachment:
		h.serveAttachment(w, r, grant)
	}
}

const rawMethods = "GET, HEAD, OPTIONS"

// rawResponseWriter puts the raw endpoint's headers on whatever response goes
// out, errors included: a response without the sandbox is one a page could be
// loaded from in the app's origin, and an error without CORS is one a page's
// fetch() sees only as a network failure. They are applied as the status is
// written rather than once up front, because ServeContent clears Cache-Control
// before answering a Range it cannot satisfy.
type rawResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *rawResponseWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		header := w.Header()
		// A popup escapes the sandbox, so a link the page opens in a new tab is
		// a normal page there, as from an agent's page in chat (HtmlFrame). One
		// that opens /api/raw again is sandboxed by that response's own header.
		header.Set("Content-Security-Policy", "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox")
		header.Set("X-Content-Type-Options", "nosniff")
		header.Set("Referrer-Policy", "no-referrer")
		header.Set("Access-Control-Allow-Origin", "*")
		// What a page's ranged reader (pdf.js, a video or wasm loader) needs to
		// learn a size and revalidate, beyond the safelisted headers.
		header.Set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, ETag")
		// Private: the content is the user's. no-cache rather than a
		// lifetime: a work-directory file changes under the same URL whenever
		// the agent edits it, and revalidation is what tells.
		header.Set("Cache-Control", "private, no-cache")
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *rawResponseWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}

// ReadFrom keeps the server's own ReadFrom reachable, which ServeContent's copy
// uses to hand a work-directory file to sendfile rather than through user
// space — what a video of hundreds of megabytes is served with.
func (w *rawResponseWriter) ReadFrom(r io.Reader) (int64, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return io.Copy(w.ResponseWriter, r)
}

// Unwrap lets http.ResponseController reach the connection beneath.
func (w *rawResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// serveWorkDirFile reads through an os.Root rather than checking a path and
// then opening it, so that a symlink — or a directory swapped for one after a
// check — cannot lead out of the scope: the root refuses to follow it there.
func (h *RawHandler) serveWorkDirFile(w http.ResponseWriter, r *http.Request, grant RawGrant, rel string) {
	workDir, apiErr := h.files.resolveWorkDir(grant.Worktree)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}

	root, err := os.OpenRoot(workDir)
	if err != nil {
		h.files.writeError(w, h.files.internalFailure("open", "the work directory", err), nil)
		return
	}
	defer root.Close()

	// A file scope is held to the work directory, not to the file's own
	// directory: the file is what the user opened, and if it is a link to
	// elsewhere in the project, that is the file they asked for.
	name := filepath.FromSlash(grant.Path)
	workRoot := root
	if grant.Scope == RawScopeDirectory {
		scope, err := openScope(root, grant.Path)
		if err != nil {
			if os.IsNotExist(err) {
				h.files.writeError(w, errf(http.StatusNotFound, CodeNotFound, "not found: %s", grant.Path), nil)
				return
			}
			h.files.writeError(w, outsideScope("open", grant.Path, err), nil)
			return
		}
		defer scope.Close()
		root = scope
		name = filepath.FromSlash(rel)
	}

	f, fi, apiErr := h.files.openRegular(root, name, rel, outsideScope)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}
	defer f.Close()

	// Asked of the whole path from the work directory, since the scope's own
	// name is a spelling too.
	if grant.Scope == RawScopeDirectory {
		resolved, err := resolvedName(workRoot, filepath.Join(filepath.FromSlash(grant.Path), name), f)
		if err != nil {
			// Logged rather than answered: the error holds host paths, and the
			// answer is readable by the page.
			h.files.log.Warn("cannot resolve raw file name", "worktree", grant.Worktree, "path", rel, "error", err)
			h.files.writeError(w, errf(http.StatusForbidden, CodeOutsideScope, "cannot resolve %s within this capability", rel), nil)
			return
		}
		if hasDotComponent(filepath.ToSlash(resolved)) {
			h.files.writeError(w, errf(http.StatusForbidden, CodeOutsideScope, "%s is outside this capability", rel), nil)
			return
		}
	}
	h.serveContent(w, r, rel, fi.ModTime(), "", f)
}

// openScope opens dir, a clean slash path beneath root, as a root of its own,
// refusing it if anything on the way is not a plain directory. os.Root follows
// a link that stays within it, so "site -> ." would otherwise scope a
// capability to the whole work directory — the root a directory scope must
// never be — and "site -> .pockode" to Pockode's own data. A repository can
// ship such a link.
//
// A link swapped in between the Lstat and the open is not caught; doing that
// takes writing to the work directory, which is already more than a
// capability grants.
func openScope(root *os.Root, dir string) (*os.Root, error) {
	// Split on the native separator: on Windows a "\" in a grant's path is
	// one too, and a component hidden inside another would go unchecked.
	native := filepath.FromSlash(dir)
	walked := ""
	for _, name := range strings.Split(native, string(filepath.Separator)) {
		walked = filepath.Join(walked, name)
		info, err := root.Lstat(walked)
		if err != nil {
			return nil, err
		}
		// Anything but a plain directory, not only a symlink: Lstat reports a
		// Windows junction as irregular, and os.Root may follow it all the same.
		if info.Mode().Type() != fs.ModeDir {
			return nil, fmt.Errorf("%s is not a plain directory (%s)", filepath.ToSlash(walked), info.Mode().Type())
		}
	}
	return root.OpenRoot(native)
}

// outsideScope answers a name the os.Root would not open. The root reports a
// link out of it as an unexported error, so it cannot be told apart from the
// rarer failures — a permission, a link loop — and all of them are answered
// as this capability not reaching the file, with the reason in the message.
func outsideScope(op, display string, err error) *apiError {
	return errf(http.StatusForbidden, CodeOutsideScope, "cannot %s %s within this capability: %v", op, display, err)
}

func (h *RawHandler) serveAttachment(w http.ResponseWriter, r *http.Request, grant RawGrant) {
	dataDir, ok := h.attachments.dataDir(w, h.attachments.sessions.StoredAttachmentDataDir, grant.Worktree, grant.SessionID)
	if !ok {
		return
	}
	fullPath, err := attachments.Resolve(dataDir, grant.SessionID, grant.Path)
	if errors.Is(err, attachments.ErrNotFound) {
		h.files.writeError(w, errf(http.StatusNotFound, CodeNotFound, "attachment %q not found", grant.Path), nil)
		return
	}
	if err != nil {
		h.files.writeError(w, h.files.internalFailure("resolve", grant.Path, err), nil)
		return
	}

	f, fi, apiErr := h.files.openRegular(osFS{}, fullPath, grant.Path, h.files.internalFailure)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}
	defer f.Close()
	h.serveContent(w, r, grant.Path, fi.ModTime(), "", f)
}

func (h *RawHandler) serveCommitFile(w http.ResponseWriter, r *http.Request, grant RawGrant, rel string) {
	workDir, apiErr := h.files.resolveWorkDir(grant.Worktree)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}

	// git looks a path up in the commit's tree without following symlinks — a
	// link is a blob holding its target's name — so joining is all a directory
	// scope needs: what is beneath it in the tree is beneath it.
	repoPath := grant.Path
	if grant.Scope == RawScopeDirectory {
		repoPath = path.Join(grant.Path, rel)
	}

	open := func() (*git.Blob, error) { return git.OpenFile(r.Context(), workDir, grant.Hash, repoPath) }
	blob, err := open()
	if err != nil {
		switch {
		case errors.Is(err, git.ErrInvalidArgument):
			h.files.writeError(w, errf(http.StatusBadRequest, CodeInvalidRequest, "%v", err), nil)
		case errors.Is(err, contents.ErrNotFound):
			h.files.writeError(w, errf(http.StatusNotFound, CodeNotFound, "%s not found in commit %s", repoPath, grant.Hash), nil)
		case errors.Is(err, contents.ErrInvalidPath):
			h.files.writeError(w, errf(http.StatusBadRequest, CodeNotAFile, "%s is not a file in commit %s", repoPath, grant.Hash), nil)
		default:
			h.files.writeError(w, h.files.internalFailure("read", repoPath+" in commit "+grant.Hash, err), nil)
		}
		return
	}

	content := &commitReader{open: open, size: blob.Size, blob: blob}
	defer func() {
		if err := content.Close(); err != nil {
			h.files.log.Error("git failed while streaming file in commit", "hash", grant.Hash, "path", repoPath, "error", err)
		}
	}()

	// What a commit holds at a path never changes, so the pair is a validator:
	// a revalidation is answered 304 without the body crossing the network.
	sum := sha256.Sum256([]byte(grant.Hash + ":" + repoPath))
	h.serveContent(w, r, repoPath, time.Time{}, `"`+hex.EncodeToString(sum[:16])+`"`, content)
}

// serveContent answers with content typed by its own bytes, Range included.
// An etag, if any, is set only once the content has proved readable, so that
// an error is never sent out under the validator of the content it failed on.
func (h *RawHandler) serveContent(w http.ResponseWriter, r *http.Request, name string, modTime time.Time, etag string, content io.ReadSeeker) {
	head := make([]byte, contents.SniffLen)
	n, err := io.ReadFull(content, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		h.files.writeError(w, h.files.internalFailure("read", name, err), nil)
		return
	}
	if _, err := content.Seek(0, io.SeekStart); err != nil {
		h.files.writeError(w, h.files.internalFailure("seek", name, err), nil)
		return
	}
	w.Header().Set("Content-Type", contents.DetectServedMIME(name, head[:n]))
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	http.ServeContent(w, r, "", modTime, content)
}

// commitReader is a file in a commit as an io.ReadSeeker, which is what lets
// ServeContent answer a Range request for it — a video player will not play
// without one. git streams a blob from its start only, so reading past where
// the stream is discards up to the offset, and reading behind it runs git
// again. That is the cost GitFile declines for a download read in chunks; a
// player asks for a handful of ranges, and the head sniffed for the type is
// kept so that reading from the start again costs nothing.
//
// A multi-range answer is copied out by a goroutine of ServeContent's own,
// which may still be reading when the handler returns and closes this — so
// both take a lock, and once closed it never starts git again.
type commitReader struct {
	open func() (*git.Blob, error)
	size int64

	readMu sync.Mutex
	closed bool

	offset int64 // where the next Read starts
	head   []byte
	blob   *git.Blob
	pos    int64 // how far blob has been read
}

func (c *commitReader) Seek(offset int64, whence int) (int64, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		offset += c.offset
	case io.SeekEnd:
		offset += c.size
	default:
		return 0, fmt.Errorf("invalid whence %d", whence)
	}
	if offset < 0 {
		return 0, errors.New("negative position")
	}
	c.offset = offset
	return offset, nil
}

func (c *commitReader) Read(p []byte) (int, error) {
	c.readMu.Lock()
	defer c.readMu.Unlock()

	if c.closed {
		return 0, os.ErrClosed
	}
	if c.offset >= c.size {
		return 0, io.EOF
	}
	if c.offset < int64(len(c.head)) {
		n := copy(p, c.head[c.offset:])
		c.offset += int64(n)
		return n, nil
	}

	if c.blob != nil && c.pos > c.offset {
		if err := c.closeBlobLocked(); err != nil {
			return 0, err
		}
	}
	if c.blob == nil {
		blob, err := c.open()
		if err != nil {
			return 0, err
		}
		c.blob, c.pos = blob, 0
	}
	if c.pos < c.offset {
		skipped, err := io.CopyN(io.Discard, c.blob, c.offset-c.pos)
		c.pos += skipped
		if err != nil {
			return 0, err
		}
	}

	n, err := c.blob.Read(p)
	// Keep the head as the first stream reads it: serveContent sniffs it and
	// then seeks back to serve the whole, which must not cost a second git.
	if c.pos == int64(len(c.head)) && c.pos < contents.SniffLen {
		c.head = append(c.head, p[:n]...)
	}
	c.pos += int64(n)
	c.offset += int64(n)
	return n, err
}

// Close stops the git process the current stream holds, if any, and any read
// after it fails.
func (c *commitReader) Close() error {
	c.readMu.Lock()
	defer c.readMu.Unlock()
	c.closed = true
	return c.closeBlobLocked()
}

func (c *commitReader) closeBlobLocked() error {
	if c.blob == nil {
		return nil
	}
	err := c.blob.Close()
	c.blob = nil
	return err
}
