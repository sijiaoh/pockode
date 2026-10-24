package filetransfer

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
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

// RawDownloadParam, present in a raw URL's query, serves the content as an
// attachment, for a link that saves it instead of an element that plays it.
const RawDownloadParam = "download"

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
	// RawScopeRoot reaches the whole work directory or commit, Path empty,
	// except what holds secrets. It is for a page, which is opened at its own
	// path beneath the root so that its relative URLs — `../` and script-built
	// ones included — load whatever project file they name.
	//
	// What it withholds is a short list, not every dot path: a page's scripts
	// read without asking anyone, and the page may be a third party's (a
	// cloned repository, node_modules, an upload), so the list is what costs
	// most once it leaks and that no ordinary page needs — .git (the
	// repository token with --git), .env, .envrc and their .* variants
	// (sensitiveName), Pockode's data directory, whose tokens take over the
	// server, and every other worktree. Everything else is a file like any
	// other, the build output in docs/.vitepress/dist or .output/public
	// included, which would otherwise load nothing of its own. A withheld file
	// the user means to see takes a file scope of its own.
	//
	// For a work-directory file the checks are on the name asked for and on
	// the name the file system resolves it to (contents.ResolvedName), so
	// that neither a link nor, on Windows, a short name such as ENV~1 is
	// another way to .env. The data directory and the other worktrees are
	// matched on the resolved name only, by identity rather than by name,
	// wherever settings put them: a worktree's capability reads its own files
	// only (inWithheldDir).
	RawScopeRoot RawScope = "root"
	// RawScopeFolder reaches the folder Path names in a work directory — the
	// work directory itself for an empty Path — as one zip archive, served as
	// an attachment at the capability's own path (DownloadFolder). It is how
	// the app saves a folder: a link carries no Authorization header, and the
	// archive can be more than a phone's tab survives holding. Unlike a root
	// scope, it withholds nothing: the archive holds what Files shows.
	RawScopeFolder RawScope = "folder"
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
	// path in the commit, or the attachment id; empty for a root scope.
	Path string
	// Hosts are the hosts beyond this server that a page served under the
	// capability may reach (docs/page-external-hosts-ui.md), each as URL.host
	// gives it. Only the reader allows them, through the app, so they are bound
	// here and never said by the URL: the page can navigate itself to any URL
	// it likes, and whatever a URL could say, it could say too.
	Hosts []string
	// BaseURL is what the app puts the capability's path under to load it —
	// the scheme, host and any path the browser sees, which a proxy in between
	// may not pass on — and so where the page's own requests go. Empty: the
	// request's own Host, over either scheme. One a policy cannot name (an
	// IPv6 literal) names nothing, and the page then has none of its files.
	BaseURL string
}

// MaxRawGrantHosts is as many hosts as the app ever lists for a page to
// allow.
const MaxRawGrantHosts = 50

// grantHost is every host a CSP host-source names as written: no IPv6
// literal, no "_", no wildcard. Nothing in it can end a source or a directive.
var grantHost = regexp.MustCompile(`^[a-z0-9.-]+(:[0-9]{1,5})?$`)

// lowerOrigin is base with its scheme and host in lower case, as a policy
// source has to name them to match what the browser asks for; its path is
// kept as it is.
func lowerOrigin(base string) string {
	scheme, rest, ok := strings.Cut(base, "://")
	if !ok {
		return base
	}
	host, path, hasPath := strings.Cut(rest, "/")
	lowered := strings.ToLower(scheme) + "://" + strings.ToLower(host)
	if hasPath {
		lowered += "/" + path
	}
	return lowered
}

// maxGrantHostLen is the longest name DNS allows, and a port.
const maxGrantHostLen = 253 + len(":65535")

// sameHostname is whether host, with or without a port, names hostname: a
// trailing dot is the same name to DNS, and so another spelling of it.
func sameHostname(host, hostname string) bool {
	name, _, _ := strings.Cut(host, ":")
	return strings.TrimSuffix(name, ".") == strings.TrimSuffix(hostname, ".")
}

// grantBaseURL is a base a CSP source can name, path included, with nothing in
// it that could end the source or the directive.
var grantBaseURL = regexp.MustCompile(`^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%!$&'()*+=:@/-]*)?$`)

// ErrInvalidGrant refuses to issue a capability for a grant that names nothing
// a request could reach.
var ErrInvalidGrant = errors.New("invalid raw grant")

func (g RawGrant) validate() error {
	switch g.Scope {
	case RawScopeFile:
		// IsLocal refuses "" and a way out; the root, which is no file, is what
		// the path cleans to in every other spelling.
		if !filepath.IsLocal(filepath.FromSlash(g.Path)) || cleanGrantPath(g.Path) == "." {
			return fmt.Errorf("%w: path %q must name a file beneath the root of its origin", ErrInvalidGrant, g.Path)
		}
	case RawScopeRoot:
		if g.Path != "" {
			return fmt.Errorf("%w: a root scope takes no path, got %q", ErrInvalidGrant, g.Path)
		}
	case RawScopeFolder:
		if g.Path != "" && !filepath.IsLocal(filepath.FromSlash(g.Path)) {
			return fmt.Errorf("%w: path %q must name a folder beneath the root of its origin", ErrInvalidGrant, g.Path)
		}
		// A commit's tree is not walked from disk; an attachment store is
		// flat.
		if g.Origin != RawOriginFile {
			return fmt.Errorf("%w: a folder scope reaches a work directory only", ErrInvalidGrant)
		}
	default:
		return fmt.Errorf("%w: unknown scope %q", ErrInvalidGrant, g.Scope)
	}

	if len(g.Hosts) > MaxRawGrantHosts {
		return fmt.Errorf("%w: %d hosts, at most %d", ErrInvalidGrant, len(g.Hosts), MaxRawGrantHosts)
	}
	own := ""
	if g.BaseURL != "" {
		base, err := url.Parse(g.BaseURL)
		if err != nil || base.Scheme != "http" && base.Scheme != "https" || base.Host == "" {
			return fmt.Errorf("%w: base URL %q is not an http(s) URL", ErrInvalidGrant, g.BaseURL)
		}
		own = strings.ToLower(base.Hostname())
	}
	for _, host := range g.Hosts {
		if len(host) > maxGrantHostLen || !grantHost.MatchString(host) {
			return fmt.Errorf("%w: host %q is not one a policy can name", ErrInvalidGrant, host)
		}
		// A request to this server's own host, on any port, could carry its
		// cookies; the app never offers one. Checked again against the Host
		// each request comes in on (pagePolicy), which is all there is to go
		// by without a base URL.
		if own != "" && sameHostname(host, own) {
			return fmt.Errorf("%w: host %q is this server's own", ErrInvalidGrant, host)
		}
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

// hasSensitiveComponent reports whether any component of p, a slash path, is
// a sensitiveName. Split on the native separator as well: on Windows
// "site\.env" is "site/.env".
func hasSensitiveComponent(p string) bool {
	for _, name := range strings.Split(filepath.FromSlash(p), string(filepath.Separator)) {
		if sensitiveName(name) {
			return true
		}
	}
	return false
}

// sensitiveName reports whether name, one path component, is withheld from a
// root scope wherever it appears. At any depth, not only at the root: a
// nested repository or a submodule has a .git of its own, and an app in a
// subdirectory its own .env. Without regard to case on every platform: the
// resolved name keeps the spelling it was asked by on a case-insensitive file
// system (macOS by default), so .GIT/config is .git/config there.
//
// .envrc is direnv's, a shell script that exports secrets as often as .env
// holds them. Its variants go with it as .env's do: .envrc.local is the usual
// name for the personal half it sources, and an .example is withheld along
// with the rest rather than told apart by a list of harmless suffixes.
func sensitiveName(name string) bool {
	name = strings.ToLower(name)
	if name == ".git" {
		return true
	}
	for _, env := range []string{".env", ".envrc"} {
		if name == env || strings.HasPrefix(name, env+".") {
			return true
		}
	}
	return false
}

// RawEntryPath is the URL path a grant issued as capability is opened at: the
// file itself for a file scope, the root with a trailing slash for a root
// scope, against which a path beneath it resolves as a relative URL, and the
// capability with a trailing slash for a folder scope, whose archive is named
// by its Content-Disposition — only the server knows a work directory's name.
func RawEntryPath(capability string, grant RawGrant) string {
	if grant.Scope == RawScopeRoot || grant.Scope == RawScopeFolder {
		return RawPath(capability, "")
	}
	return RawPath(capability, path.Base(cleanGrantPath(grant.Path)))
}

// RawPath is the URL path that reads rel within a capability: the file's own
// name for a file scope, a path beneath the root for a root scope.
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
// own scripts read what the scope reaches and — to a host the reader has
// allowed for the page (pagePolicy) — send the bytes out, where without it
// they could send only the URL, useless to whoever cannot reach this server,
// as on a server kept to its LAN. That is why a root scope withholds what
// holds secrets (RawScopeRoot).
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
	switch grant.Scope {
	case RawScopeFile:
		grant.Path = cleanGrantPath(grant.Path)
	case RawScopeFolder:
		// The work directory has one spelling, the empty one.
		if grant.Path = cleanGrantPath(grant.Path); grant.Path == "." {
			grant.Path = ""
		}
	}
	grant.BaseURL = lowerOrigin(grant.BaseURL)
	return h.capabilities.Issue(sessionToken, grant)
}

func (h *RawHandler) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	w := &rawResponseWriter{ResponseWriter: rw, policy: "default-src 'none'"}

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
	w.policy = pagePolicy(grant, capability, r.Host)
	if wantsReporter(r) {
		w.reporter = pageReporter(capability)
	}

	if grant.Scope == RawScopeFolder {
		if rel != "" {
			h.files.writeError(w, errf(http.StatusForbidden, CodeOutsideScope, "%s is outside this capability", rel), nil)
			return
		}
		h.serveFolder(w, r, grant)
		return
	}

	// The lexical check comes first for every origin, so `..` is refused the
	// same way whichever one would have been asked to resolve it.
	if rel == "" || !filepath.IsLocal(filepath.FromSlash(rel)) {
		h.files.writeError(w, errf(http.StatusBadRequest, CodeInvalidPath, "invalid path: %s", rel), nil)
		return
	}
	if grant.Scope == RawScopeFile && rel != path.Base(grant.Path) ||
		grant.Scope == RawScopeRoot && hasSensitiveComponent(rel) {
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

// rawSandbox gives a document served here an opaque origin of its own, where
// the login token is out of reach. A popup escapes the sandbox, so a link the
// page opens in a new tab is a normal page there, as from an agent's page in
// chat (HtmlFrame). One that opens /api/raw again is sandboxed by that
// response's own header.
const rawSandbox = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox"

// rawResponseWriter puts the raw endpoint's headers on whatever response goes
// out, errors included: a response without the sandbox is one a page could be
// loaded from in the app's origin, and an error without CORS is one a page's
// fetch() sees only as a network failure. They are applied as the status is
// written rather than once up front, because ServeContent clears Cache-Control
// before answering a Range it cannot satisfy.
type rawResponseWriter struct {
	http.ResponseWriter
	wroteHeader bool
	// policy is what a document served here may reach, beside the sandbox.
	policy string
	// reporter, when not empty, goes into an HTML page served to a frame
	// (injectReporter).
	reporter string
}

func (w *rawResponseWriter) WriteHeader(status int) {
	if !w.wroteHeader {
		w.wroteHeader = true
		header := w.Header()
		header.Set("Content-Security-Policy", rawSandbox+"; "+w.policy)
		header.Set("X-DNS-Prefetch-Control", "off")
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

// FlushError puts the headers on before a flush sends them, which reaching the
// writer beneath through Unwrap would do without them.
func (w *rawResponseWriter) FlushError() error {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK)
	}
	return http.NewResponseController(w.ResponseWriter).Flush()
}

// Unwrap lets http.ResponseController reach the connection beneath.
func (w *rawResponseWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// pagePolicy is what a document served under capability may reach
// (docs/page-external-hosts-ui.md): the capability's own path, which its
// relative URLs resolve beneath, and the hosts the reader has allowed for the
// page — nothing else of this server's, nor any other host. Everything else a
// page does stays possible: inline scripts and styles and eval, which pages
// and chart libraries need, and data: and blob:, which are no request.
//
// The page's own path is named in full, scheme and host included, because in
// the opaque origin the sandbox gives the document 'self' names nothing it can
// be held to. Without a base URL it is the Host the request came in on, over
// either scheme.
//
// The hosts are allowed for what the page fetches, never for the documents it
// embeds, and never as the Host the request came in on, on another port or
// with a trailing dot. Where the page's own frame goes is not this policy's to
// govern: the app frames it in a document whose frame-src holds it to this
// capability.
func pagePolicy(grant RawGrant, capability, requestHost string) string {
	var own []string
	switch {
	case grant.BaseURL != "":
		if grantBaseURL.MatchString(grant.BaseURL) {
			own = []string{strings.TrimSuffix(grant.BaseURL, "/") + RawPathPrefix + capability + "/"}
		}
	case grantHost.MatchString(requestHost):
		own = []string{"http://" + requestHost + RawPathPrefix + capability + "/", "https://" + requestHost + RawPathPrefix + capability + "/"}
	}
	local := strings.Join(append(append([]string{}, own...), "data:", "blob:"), " ")
	reach := []string{local}
	requestName, _, _ := strings.Cut(requestHost, ":")
	for _, host := range grant.Hosts {
		if sameHostname(host, requestName) {
			continue
		}
		// Every scheme, each named: a source with one does not reach ws: from
		// https: in every engine.
		reach = append(reach, "http://"+host, "https://"+host, "ws://"+host, "wss://"+host)
	}
	sources := strings.Join(reach, " ")
	formAction := "'none'"
	if len(own) > 0 {
		formAction = strings.Join(own, " ")
	}
	return strings.Join([]string{
		"default-src " + sources,
		"script-src 'unsafe-inline' 'unsafe-eval' " + sources,
		"style-src 'unsafe-inline' " + sources,
		// Never an allowed host's documents: what one serves runs under no
		// policy of ours and can reach anywhere, and a CDN serves HTML anyone
		// can publish. WebKit loads an <object> as such a document.
		"frame-src " + local,
		"object-src 'none'",
		"form-action " + formAction,
	}, "; ")
}

// wantsReporter is whether r loads a document into a frame — the app's, or one
// a page makes — rather than reading its bytes: fetch() and Save get the file
// as it is. The fetch metadata says so; a browser that sends none gets no
// reporter, and its page no strip.
func wantsReporter(r *http.Request) bool {
	dest := r.Header.Get("Sec-Fetch-Dest")
	return r.Method == http.MethodGet && (dest == "iframe" || dest == "frame") &&
		r.Header.Get("Range") == "" && !r.URL.Query().Has(RawDownloadParam)
}

// pageReporter is the script that tells the app what the page under
// capability was refused, which only the page's own document hears
// (securitypolicyviolation fires where the request was made). It also takes a
// plain click on a link out of the capability, which the frame's embedder
// would only refuse, and hands it to the app to open. A link within the
// capability is left to navigate the frame.
//
// Its messages are those of the reporter the app writes into an agent's page
// (pageReporterScript in web/src/lib/pageHosts.ts), which reads them; they are
// posted to the app's window, two frames up past the app's wrapper. Only in
// the frame the wrapper holds, which it names pageFrameName: in a frame the
// page makes, two up is the wrapper, which hears nothing, so a link taken
// there would go nowhere — where left alone, the page's own policy refuses it
// and the page's reporter says so. The page shares this document and can post
// the same, so they are only ever reports.
func pageReporter(capability string) string {
	return `<script>(function(){if(window.name!=="` + pageFrameName + `")return;var app=parent.parent;var c="/` + capability + `/";var p=location.pathname;var own=location.host+p.slice(0,p.indexOf(c)+c.length);document.addEventListener("securitypolicyviolation",function(e){app.postMessage({type:"pockode:page-refused",url:String(e.blockedURI),directive:String(e.effectiveDirective)},"*");});addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;var t=e.target;var a=t&&t.closest?t.closest("a[href],area[href]"):null;if(!a)return;var w=(a.getAttribute("target")||"").toLowerCase();if(w&&w!=="_self"&&w!=="_parent"&&w!=="_top")return;var u;try{u=new URL(a.href);}catch(x){return;}if(u.protocol!=="http:"&&u.protocol!=="https:")return;if((u.host+u.pathname).indexOf(own)===0)return;e.preventDefault();app.postMessage({type:"pockode:page-link",href:u.href},"*");});})();</script>`
}

// pageFrameName is the name the app's wrapper gives the frame it holds a page
// in (rawPageWrapper in web/src/lib/pageHosts.ts), which a frame keeps through
// every page it goes to.
const pageFrameName = "pockode-page"

// reporterOffset is where in a page beginning with head the reporter goes:
// after a doctype, past any comments and XML prolog ahead of it, since
// anything else ahead of one puts the page in quirks mode. Without a doctype
// within head, at the start, after a byte order mark, which only counts there.
// Before anything else of the page's, so it hears what the page's head is
// refused.
func reporterOffset(head []byte) int {
	i := 0
	if bytes.HasPrefix(head, []byte("\xEF\xBB\xBF")) {
		i = 3
	}
	start := i
	for i < len(head) {
		switch {
		case strings.ContainsRune(" \t\n\f\r", rune(head[i])):
			i++
		// "<!-->" and "<!--->" are whole comments to an HTML parser.
		case bytes.HasPrefix(head[i:], []byte("<!-->")):
			i += len("<!-->")
		case bytes.HasPrefix(head[i:], []byte("<!--->")):
			i += len("<!--->")
		case bytes.HasPrefix(head[i:], []byte("<!--")):
			end := bytes.Index(head[i+4:], []byte("-->"))
			if end < 0 {
				return start
			}
			i += 4 + end + 3
		// An XML prolog, which an HTML parser reads as a comment: XHTML
		// generators put one before the doctype.
		case bytes.HasPrefix(head[i:], []byte("<?")):
			end := bytes.IndexByte(head[i:], '>')
			if end < 0 {
				return start
			}
			i += end + 1
		case len(head)-i >= 9 && bytes.EqualFold(head[i:i+9], []byte("<!doctype")):
			end := bytes.IndexByte(head[i:], '>')
			if end < 0 {
				return start
			}
			return i + end + 1
		default:
			return start
		}
	}
	return start
}

// serveFolder serves a folder scope's archive. Any Range is ignored, as an
// archive made while it streams has no byte offsets to resume from; HEAD is
// how a client checks it before handing the link to the browser.
func (h *RawHandler) serveFolder(w *rawResponseWriter, r *http.Request, grant RawGrant) {
	workDir, apiErr := h.files.resolveWorkDir(grant.Worktree)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}
	h.files.serveFolderArchive(w, r, workDir, grant.Path)
}

// serveWorkDirFile reads through an os.Root rather than checking a path and
// then opening it, so that a symlink — or a directory swapped for one after a
// check — cannot lead out of the work directory: the root refuses to follow it
// there.
func (h *RawHandler) serveWorkDirFile(w *rawResponseWriter, r *http.Request, grant RawGrant, rel string) {
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

	// A file scope is held to the work directory alone: the file is what the
	// user opened, and if it is a link to elsewhere in the project, that is
	// the file they asked for.
	name := filepath.FromSlash(grant.Path)
	if grant.Scope == RawScopeRoot {
		name = filepath.FromSlash(rel)
	}

	f, fi, apiErr := h.files.openRegular(root, name, rel, outsideScope)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}
	defer f.Close()

	if grant.Scope == RawScopeRoot {
		if apiErr := h.withinRootScope(root, workDir, grant.Worktree, name, rel, f); apiErr != nil {
			h.files.writeError(w, apiErr, nil)
			return
		}
	}
	h.serveContent(w, r, rel, fi.ModTime(), "", f)
}

// withinRootScope refuses f, opened in root (workDir) as name, if what the file
// system resolved it to has a sensitive name or lies inside a withheld
// directory.
func (h *RawHandler) withinRootScope(root *os.Root, workDir, worktree, name, rel string, f *os.File) *apiError {
	resolved, err := contents.ResolvedName(root, name, f)
	if err != nil {
		// Logged rather than answered: the error holds host paths, and the
		// answer is readable by the page.
		h.files.log.Warn("cannot resolve raw file name", "worktree", worktree, "path", rel, "error", err)
		return errf(http.StatusForbidden, CodeOutsideScope, "cannot resolve %s within this capability", rel)
	}
	if hasSensitiveComponent(filepath.ToSlash(resolved)) {
		return errf(http.StatusForbidden, CodeOutsideScope, "%s is outside this capability", rel)
	}
	withheld, err := h.inWithheldDir(workDir, resolved)
	if err != nil {
		h.files.log.Warn("cannot check raw file against withheld directories", "worktree", worktree, "path", rel, "error", err)
		return errf(http.StatusForbidden, CodeOutsideScope, "cannot resolve %s within this capability", rel)
	}
	if withheld {
		return errf(http.StatusForbidden, CodeOutsideScope, "%s is outside this capability", rel)
	}
	return nil
}

// inWithheldDir reports whether resolved, a resolved path beneath workDir,
// lies inside one of withheldDirs. Only the directories strictly beneath
// workDir are compared.
func (h *RawHandler) inWithheldDir(workDir, resolved string) (bool, error) {
	dirs := h.files.withheldDirs()
	for dir := filepath.Dir(resolved); dir != "."; dir = filepath.Dir(dir) {
		info, err := os.Stat(filepath.Join(workDir, dir))
		if err != nil {
			return false, err
		}
		if dirs.has(info) {
			return true, nil
		}
	}
	return false, nil
}

// outsideScope answers a name the os.Root would not open. The root reports a
// link out of it as an unexported error, so it cannot be told apart from the
// rarer failures — a permission, a link loop — and all of them are answered
// as this capability not reaching the file, with the reason in the message.
func outsideScope(op, display string, err error) *apiError {
	return errf(http.StatusForbidden, CodeOutsideScope, "cannot %s %s within this capability: %v", op, display, err)
}

func (h *RawHandler) serveAttachment(w *rawResponseWriter, r *http.Request, grant RawGrant) {
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

func (h *RawHandler) serveCommitFile(w *rawResponseWriter, r *http.Request, grant RawGrant, rel string) {
	workDir, apiErr := h.files.resolveWorkDir(grant.Worktree)
	if apiErr != nil {
		h.files.writeError(w, apiErr, nil)
		return
	}

	// git looks a path up in the commit's tree without following symlinks — a
	// link is a blob holding its target's name — so the lexical checks are
	// all a root scope needs.
	repoPath := grant.Path
	if grant.Scope == RawScopeRoot {
		repoPath = rel
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
func (h *RawHandler) serveContent(w *rawResponseWriter, r *http.Request, name string, modTime time.Time, etag string, content io.ReadSeeker) {
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
	mime := contents.DetectServedMIME(name, head[:n])
	w.Header().Set("Content-Type", mime)
	if strings.HasPrefix(mime, "text/html") {
		// Framed, a page carries the reporter; read, it does not. Only into
		// UTF-8, which the reporter's bytes are: a UTF-16 page would read them
		// as text, and lose its byte order mark behind them.
		w.Header().Add("Vary", "Sec-Fetch-Dest")
		if w.reporter != "" && mime == "text/html; charset=utf-8" {
			h.injectReporter(w, name, content)
			return
		}
	}
	// A download link asks for the content to be saved rather than shown:
	// a browser that ignores the link's `download` attribute — a cross-origin
	// one, or a type it insists on previewing — still writes it to disk. No
	// filename: an attachment's URL names it by its id, and a filename here
	// would outrank the one the link gives.
	if r.URL.Query().Has(RawDownloadParam) {
		w.Header().Set("Content-Disposition", "attachment")
	}
	if etag != "" {
		w.Header().Set("ETag", etag)
	}
	http.ServeContent(w, r, "", modTime, content)
}

// reporterScanLen is how far into a page its doctype is looked for: past a
// licence or build banner in a comment ahead of it, which the sniffed head is
// too short for.
const reporterScanLen = 64 << 10

// injectReporter serves a page with its reporter in, content being read from
// its start. Whole and unconditional: a frame asks for no range, and
// validators would be the file's, not these bytes'.
func (h *RawHandler) injectReporter(w *rawResponseWriter, name string, content io.Reader) {
	head := make([]byte, reporterScanLen)
	n, err := io.ReadFull(content, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		h.files.writeError(w, h.files.internalFailure("read", name, err), nil)
		return
	}
	head = head[:n]
	offset := reporterOffset(head)
	w.WriteHeader(http.StatusOK)
	for _, part := range [][]byte{head[:offset], []byte(w.reporter), head[offset:]} {
		if _, err := w.Write(part); err != nil {
			return
		}
	}
	if _, err := io.Copy(w, content); err != nil {
		h.files.log.Warn("raw page write failed", "path", name, "error", err)
	}
}

// commitReader is a file in a commit as an io.ReadSeeker, which is what lets
// ServeContent answer a Range request for it — a video player will not play
// without one. git streams a blob from its start only, so reading past where
// the stream is discards up to the offset, and reading behind it runs git
// again. That is the cost GitFile declines; a player asks for a handful of
// ranges, a download for its first byte and then the whole, and the head
// sniffed for the type is kept so that reading from the start again costs
// nothing.
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
