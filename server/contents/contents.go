// Package contents provides file system browsing and reading.
package contents

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math/bits"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrInvalidPath = errors.New("invalid path")
	ErrTooLarge    = errors.New("content too large")
	ErrExists      = errors.New("already exists")
)

// ValidatePath checks if path is safe and within workDir.
// Returns ErrInvalidPath for path traversal attempts or absolute paths.
func ValidatePath(workDir, path string) error {
	if path == "" {
		return nil
	}

	// filepath.IsLocal accepts exactly those paths the OS resolves inside the
	// directory they are joined to: it rejects absolute and `..`-escaping paths
	// everywhere, and on Windows also the forms filepath.IsAbs calls relative
	// (`\etc` against the current drive, `C:etc` against that drive's working
	// directory) and the reserved device names (`NUL`, `COM1`), which name a
	// device rather than a file under workDir. Same gate as git.validatePath —
	// ws/rpc_git.go runs both over one path, so they must agree.
	if !filepath.IsLocal(path) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	// IsLocal accepts "."; the API spells the work directory itself as "".
	fullPath := filepath.Join(workDir, path)
	if !strings.HasPrefix(fullPath, workDir+string(filepath.Separator)) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, path)
	}

	return nil
}

type EntryType string

const (
	TypeFile EntryType = "file"
	TypeDir  EntryType = "dir"
)

const (
	// MaxFileSize is the ceiling on the content a single JSON-RPC message may
	// carry, in either direction: what file.get will read out, what each
	// version in a git diff may be, and what file.write will take in. One
	// number because it is one constraint — the whole content is held in
	// memory and travels as one WebSocket message, and a connection carries
	// one message at a time, so a few megabytes stall every request already in
	// flight on it. The ceiling is about that connection as much as about
	// memory.
	//
	// The blocking is this connection's own, not the relay's: over a tunnel
	// /ws gets a yamux stream to itself and yamux frames what it writes, so
	// other streams keep moving. Whole files go over HTTP; see docs/file.md.
	// So does media (EncodingHTTP), which is why this ceiling does not apply
	// to it; a raster image is held to MaxImageSize instead.
	MaxFileSize = 2 << 20 // 2 MiB

	// MaxImageSize is the ceiling on previewing a raster image, wherever it
	// came from: the workspace, a commit, an attachment, or the image an
	// agent's tool returned. The client holds an image whole in memory to
	// decode it, which a phone does not do for much more than this, so a
	// larger one is described as too large to show rather than handed to the
	// browser. It limits the preview only: the endpoints that download a file
	// serve it at any size.
	//
	// It is not the ceiling on what may be attached (attachments.MaxSize):
	// audio, video and documents are never decoded whole, and an attachment
	// over this one is stored and handed to the agent all the same.
	MaxImageSize = 20 << 20 // 20 MiB

	// SniffLen is the most http.DetectContentType inspects, and so the least a
	// caller has to hand NewFileContent for the MIME type to come out right.
	SniffLen = 512
)

type Encoding string

const (
	EncodingText Encoding = "text"
	// EncodingHTTP is media (IsMedia) — a raster image within
	// MaxImageSize, or audio or video of any size — sent without
	// content: the client fetches its bytes over HTTP from the endpoint that
	// serves whatever this describes — the download endpoint for a workspace
	// file, the attachment endpoint for an attachment, the commit file endpoint
	// for a version git.show.file read out of history — or streams them through
	// a raw capability. Media is the binary a client can render, and the one
	// most likely to be megabytes, so it stays off the JSON-RPC connection for
	// the reason MaxFileSize gives.
	EncodingHTTP Encoding = "http"
	// EncodingNone means no content was sent; Omitted says why.
	EncodingNone Encoding = "none"
)

// OmitReason explains an EncodingNone response, so the client can tell "too big
// to show" apart from "nothing to show".
type OmitReason string

const (
	OmitTooLarge OmitReason = "too_large"
	OmitBinary   OmitReason = "binary"
	// OmitUnavailable means the content existed but could not be kept or read
	// back — the attachment store failed to write it, or the session has no
	// directory to write it to. Distinct from the other two because nothing
	// about the content itself is wrong: a retry may well produce it.
	OmitUnavailable OmitReason = "unavailable"
	// OmitNotFetched means the content was never read: the agent named a file
	// and Pockode deliberately did not deliver it. A background task's log is
	// what this exists for — it can be arbitrarily large, and the user asked to
	// see the outcome, not to have the log pushed at them. Distinct from
	// OmitUnavailable, which is a failure; this is a choice, and the path beside
	// it is how the content can still be reached.
	OmitNotFetched OmitReason = "not_fetched"
)

type Entry struct {
	Name string    `json:"name"`
	Type EntryType `json:"type"`
	Path string    `json:"path"`
}

type FileContent struct {
	Name string    `json:"name"`
	Type EntryType `json:"type"`
	Path string    `json:"path"`
	Size int64     `json:"size"`
	// MIME is detected from the file's own bytes, not guessed from its
	// extension, and is always set — including when Content is omitted.
	MIME     string     `json:"mime"`
	Content  string     `json:"content"`
	Encoding Encoding   `json:"encoding"`
	Omitted  OmitReason `json:"omitted,omitempty"`
	// Limit is the size ceiling that kept Content out, sent only with
	// OmitTooLarge. It travels with the response so the UI can name the
	// threshold without keeping a second copy of the ceiling that applied.
	Limit int64 `json:"limit,omitempty"`
}

// ContentsResult holds the result of GetContents.
// Either Entries (for directories) or File (for files) is set, never both.
type ContentsResult struct {
	Entries []Entry      // Directory listing (nil if file)
	File    *FileContent // File content (nil if directory)
}

// IsDir returns true if the result is a directory listing.
func (r ContentsResult) IsDir() bool {
	return r.File == nil
}

// GetContents returns directory entries or file content.
// Returns ErrNotFound if path doesn't exist, ErrInvalidPath for path traversal
// attempts and for paths that are neither a directory nor a regular file.
func GetContents(workDir, path string) (ContentsResult, error) {
	if err := ValidatePath(workDir, path); err != nil {
		return ContentsResult{}, err
	}

	fullPath := filepath.Join(workDir, path)
	info, err := os.Stat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return ContentsResult{}, fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return ContentsResult{}, fmt.Errorf("failed to stat path: %w", err)
	}

	if info.IsDir() {
		entries, err := listDir(path, fullPath)
		if err != nil {
			return ContentsResult{}, err
		}
		return ContentsResult{Entries: entries}, nil
	}

	// Named pipes and device nodes are checked before opening, not after:
	// opening a fifo blocks until someone writes to it, which would hang the
	// request forever. Search refuses them for the same reason.
	if !info.Mode().IsRegular() {
		return ContentsResult{}, fmt.Errorf("%w: %s is not a regular file", ErrInvalidPath, path)
	}

	file, err := readFile(path, fullPath)
	if err != nil {
		return ContentsResult{}, err
	}
	return ContentsResult{File: file}, nil
}

func listDir(relPath, fullPath string) ([]Entry, error) {
	dirEntries, err := os.ReadDir(fullPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read directory: %w", err)
	}

	entries := make([]Entry, 0, len(dirEntries))
	for _, de := range dirEntries {
		entryPath := de.Name()
		if relPath != "" {
			entryPath = relPath + "/" + de.Name()
		}
		entry := Entry{
			Name: de.Name(),
			Path: entryPath,
		}

		if de.IsDir() {
			entry.Type = TypeDir
		} else {
			entry.Type = TypeFile
		}

		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Type != entries[j].Type {
			return entries[i].Type == TypeDir
		}
		return entries[i].Name < entries[j].Name
	})

	return entries, nil
}

// readFile describes a file, carrying its content only when it is text small
// enough to send. Anything else is described by metadata alone: media because
// its bytes are fetched over HTTP, any other binary because a client that
// cannot render it has no use for the megabytes it would cost to ship.
func readFile(relPath, fullPath string) (*FileContent, error) {
	// The head decides before the rest is read: media bytes are not going to
	// be sent, so reading up to MaxFileSize of them only to drop them would
	// make every picture's or recording's metadata cost the file.
	size, content, err := readBounded(fullPath, func(head []byte) bool {
		return IsMedia(relPath, head)
	})
	if err != nil {
		return nil, err
	}
	return NewFileContent(relPath, size, content), nil
}

// ReadBounded reads the file at fullPath whole when it is within MaxFileSize,
// and otherwise only its first SniffLen bytes — enough to name the MIME type
// of content that is not going to be sent. size is the file's full size, so
// size > MaxFileSize is how a caller tells the two apart.
func ReadBounded(fullPath string) (size int64, content []byte, err error) {
	return readBounded(fullPath, nil)
}

// readBounded is ReadBounded that also stops at the head when headOnly says
// the head is all the caller needs. headOnly may be nil.
func readBounded(fullPath string, headOnly func(head []byte) bool) (size int64, content []byte, err error) {
	f, err := os.Open(fullPath)
	if err != nil {
		return 0, nil, fmt.Errorf("failed to read file: %w", err)
	}
	defer f.Close()

	// Stat the descriptor, not the path: an agent rewriting the file between
	// the caller's stat and this read would otherwise have the reported size
	// describe a different file than the content beside it.
	info, err := f.Stat()
	if err != nil {
		return 0, nil, fmt.Errorf("failed to stat file: %w", err)
	}

	head := make([]byte, SniffLen)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return 0, nil, fmt.Errorf("failed to read file: %w", err)
	}
	head = head[:n]
	if info.Size() > MaxFileSize || (headOnly != nil && headOnly(head)) {
		return info.Size(), head, nil
	}

	// Bounded rather than sized from info: the file may have grown since the
	// stat, and memory use must not depend on that race.
	rest, err := io.ReadAll(io.LimitReader(f, MaxFileSize+1-int64(len(head))))
	if err != nil {
		return 0, nil, fmt.Errorf("failed to read file: %w", err)
	}
	content = append(head, rest...)

	size = info.Size()
	if int64(len(content)) > MaxFileSize {
		// The file outgrew the limit while it was being read, so the size taken
		// before the read would contradict the verdict sitting next to it.
		size = int64(len(content))
		if grown, err := f.Stat(); err == nil && grown.Size() > size {
			size = grown.Size()
		}
		content = content[:SniffLen]
	}

	return size, content, nil
}

// NewFileContent describes content already held in memory — a git blob, say —
// the way readFile describes a file on disk, so that whatever produced it, a
// client renders it with one code path.
//
// size is the content's full size, which may exceed len(content): a caller that
// already knows the content is too large to send need only pass its first
// SniffLen bytes, enough to name the MIME type.
func NewFileContent(relPath string, size int64, content []byte) *FileContent {
	file := &FileContent{
		Name: path.Base(relPath),
		Type: TypeFile,
		Path: relPath,
		Size: size,
		MIME: DetectMIME(relPath, content),
	}

	switch {
	// Ahead of the size check: the ceiling is the JSON-RPC message's, and
	// media bytes never travel in one. The MIME needs only the head, so media
	// of any size is named from what a too-large read leaves.
	//
	// An image still has a ceiling, because the client holds the whole of it
	// in memory to decode it: MaxImageSize. Audio and video have none: a
	// player streams them with Range requests and never holds the whole file.
	case IsMedia(relPath, content):
		if IsRasterImageMIME(file.MIME) && size > MaxImageSize {
			file.Encoding = EncodingNone
			file.Omitted = OmitTooLarge
			file.Limit = MaxImageSize
		} else {
			file.Encoding = EncodingHTTP
		}
	case size > MaxFileSize || int64(len(content)) > MaxFileSize:
		file.Encoding = EncodingNone
		file.Omitted = OmitTooLarge
		file.Limit = MaxFileSize
	case !IsBinary(content):
		file.Encoding = EncodingText
		file.Content = string(content)
	default:
		file.Encoding = EncodingNone
		file.Omitted = OmitBinary
	}

	return file
}

// Image formats http.DetectContentType cannot name: SVG is plain text, and
// AVIF/HEIC/TIFF are missing from Go's signature table. Their extension is the
// only clue, and the UI needs the real type to render them.
var imageExtMIMEs = map[string]string{
	".svg":  "image/svg+xml",
	".avif": "image/avif",
	".heic": "image/heic",
	".heif": "image/heif",
	".tif":  "image/tiff",
	".tiff": "image/tiff",
}

// ImageExtension returns name's extension when it is one this package needs in
// order to name the content, and "" otherwise.
//
// For a caller that stores content under a name of its own making — the
// attachment store, whose names are hashes — this is which part of the original
// name is worth carrying over. Answering from the image table DetectMIME
// consults is the point: an extension kept for any other reason would be a
// guess, and one that is not on the table buys nothing, since sniffing already
// names those formats.
func ImageExtension(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if _, ok := imageExtMIMEs[ext]; ok {
		return ext
	}
	return ""
}

// Audio and video formats http.DetectContentType cannot name: a phone records
// video as .mov, which the sniffer's table lacks, and it does not recognise an
// MP3 without an ID3 tag or an MP4 whose brand it does not know. Here rather
// than among the served types because whether a file is media decides how it
// is described (IsMedia), not only how it is served.
var playableExtMIMEs = map[string]string{
	".mp4":  "video/mp4",
	".m4v":  "video/mp4",
	".mov":  "video/quicktime",
	".webm": "video/webm",
	".mp3":  "audio/mpeg",
	".m4a":  "audio/mp4",
	".aac":  "audio/aac",
	".wav":  "audio/wav",
	".flac": "audio/flac",
}

// Containers that hold audio as readily as video, which the sniffer names as
// video (or, for Ogg, as nothing playable) whatever they hold: an iPhone voice
// memo is an MP4 and an Opus voice note an Ogg. Inside the container the
// extension says which one it is. Keyed by container so that an extension only
// picks among what the content already is — a .m4a holding a WebM stays WebM.
var containerExtMIMEs = map[string]map[string]string{
	"video/mp4": {
		".m4a": "audio/mp4",
		".m4b": "audio/mp4",
	},
	"video/webm": {
		".weba": "audio/webm",
	},
	"application/ogg": {
		".ogg":  "audio/ogg",
		".oga":  "audio/ogg",
		".opus": "audio/ogg",
		".spx":  "audio/ogg",
		".ogv":  "video/ogg",
	},
}

// DetectMIME reports the media type of a file whose leading bytes are head.
// Content wins over extension — a file is what it contains, so a .svg holding
// a PNG is still reported as a PNG. The extension is consulted only where
// sniffing gave up, or where it named a container that could be audio or video
// (containerExtMIMEs).
//
// HTML is the exception both ways, because text/html is what makes a client
// render a file as a page (docs/file.md, "HTML pages"), and sniffing alone
// answers it wrongly in both directions: a page that opens with text rather
// than a tag sniffs as plain text, and a .svelte or .vue component that opens
// with <script> sniffs as HTML. So text is HTML exactly when it is named .html
// or .htm.
//
// head need be no longer than SniffLen. Exported for the callers that describe
// content this package never reads off disk — the image an agent says it
// looked at — so that one answer is given about what a file is.
func DetectMIME(name string, head []byte) string {
	ext := strings.ToLower(filepath.Ext(name))
	sniffed := htmlByName(ext, http.DetectContentType(head))
	if inContainer, ok := containerExtMIMEs[sniffed]; ok {
		if mime, ok := inContainer[ext]; ok {
			return mime
		}
		// A recording made in a browser is named .webm whether it holds
		// video or not, so there the content has to say. Only the first
		// SniffLen bytes, whatever the caller holds: a file shown in full
		// (a small git blob) must get the answer its head-only read gets.
		if sniffed == "video/webm" && isAudioOnlyWebM(head[:min(len(head), SniffLen)]) {
			return "audio/webm"
		}
		return sniffed
	}
	if !isGenericType(sniffed) {
		return sniffed
	}
	if mime, ok := imageExtMIMEs[ext]; ok {
		return mime
	}
	if mime, ok := playableExtMIMEs[ext]; ok {
		return mime
	}
	return sniffed
}

// htmlByName settles whether text sniffed as sniffed is HTML, from its
// extension (see DetectMIME), keeping the charset sniffing found. Anything
// that is not text is left alone: a binary named .html is still binary. Text
// that is not HTML comes back as plain text, which DetectMIME's extension
// tables may still name — an .svg opening with a comment sniffs as HTML.
func htmlByName(ext, sniffed string) string {
	isHTMLName := ext == ".html" || ext == ".htm"
	isHTML := strings.HasPrefix(sniffed, "text/html")
	isText := isHTML || strings.HasPrefix(sniffed, "text/plain") || strings.HasPrefix(sniffed, "text/xml")
	if !isText || isHTMLName == isHTML {
		return sniffed
	}
	mime := "text/plain"
	if isHTMLName {
		mime = "text/html"
	}
	if _, params, found := strings.Cut(sniffed, ";"); found {
		mime += ";" + params
	}
	return mime
}

// EBML element IDs (Matroska specification) that isAudioOnlyWebM walks.
const (
	ebmlSegment    = 0x18538067
	ebmlTracks     = 0x1654AE6B
	ebmlCluster    = 0x1F43B675
	ebmlTrackEntry = 0xAE
	ebmlTrackType  = 0x83

	trackTypeVideo = 1
	trackTypeAudio = 2
)

// isAudioOnlyWebM reports whether the WebM file opening with head declares an
// audio track and no video track.
//
// A MediaRecorder writes its track list within the first couple of hundred
// bytes, so it is in head. A file whose track list is not — a muxer that
// reserves space for a seek index first — is left as video: false here only
// means "not shown to be audio".
func isAudioOnlyWebM(head []byte) bool {
	// The EBML header comes first; the Segment holding everything else
	// follows it, its size usually unknown while recording.
	_, _, rest, ok := ebmlElement(head)
	if !ok {
		return false
	}
	id, segment, _, ok := ebmlElement(rest)
	if !ok || id != ebmlSegment {
		return false
	}
	for len(segment) > 0 {
		id, body, next, ok := ebmlElement(segment)
		// Tracks precede the first Cluster, so meeting one first means
		// there is no track list to read.
		if !ok || id == ebmlCluster {
			return false
		}
		if id == ebmlTracks {
			return next != nil && tracksAreAudioOnly(body)
		}
		if next == nil {
			return false
		}
		segment = next
	}
	return false
}

func tracksAreAudioOnly(tracks []byte) bool {
	sawAudio := false
	for len(tracks) > 0 {
		id, entry, next, ok := ebmlElement(tracks)
		if !ok || next == nil {
			return false
		}
		if id == ebmlTrackEntry {
			switch trackType(entry) {
			case trackTypeVideo:
				return false
			case trackTypeAudio:
				sawAudio = true
			}
		}
		tracks = next
	}
	return sawAudio
}

func trackType(entry []byte) uint64 {
	for len(entry) > 0 {
		id, body, next, ok := ebmlElement(entry)
		if !ok || next == nil {
			return 0
		}
		if id == ebmlTrackType {
			var v uint64
			for _, c := range body {
				v = v<<8 | uint64(c)
			}
			return v
		}
		entry = next
	}
	return 0
}

// ebmlElement splits the EBML element at the start of b into its ID and body
// and returns what follows it. An element whose size is unknown or runs past
// b gets the rest of b as its body and a nil rest, which callers read as "not
// wholly here".
func ebmlElement(b []byte) (id uint64, body, rest []byte, ok bool) {
	id, n, ok := ebmlVint(b, true)
	if !ok || n > 4 {
		return 0, nil, nil, false
	}
	b = b[n:]
	size, n, ok := ebmlVint(b, false)
	if !ok {
		return 0, nil, nil, false
	}
	b = b[n:]
	unknown := size == 1<<(7*n)-1
	if unknown || size > uint64(len(b)) {
		return id, b, nil, true
	}
	return id, b[:size], b[size:], true
}

// ebmlVint reads a variable-length integer: the count of leading zero bits in
// the first byte says how many bytes follow. IDs keep that length marker as
// part of their value; sizes do not.
func ebmlVint(b []byte, keepMarker bool) (v uint64, n int, ok bool) {
	if len(b) == 0 || b[0] == 0 {
		return 0, 0, false
	}
	n = bits.LeadingZeros8(b[0]) + 1
	if n > len(b) {
		return 0, 0, false
	}
	v = uint64(b[0])
	if !keepMarker {
		v &= 0xFF >> n
	}
	for _, c := range b[1:n] {
		v = v<<8 | uint64(c)
	}
	return v, n, true
}

// Formats a page loads that http.DetectContentType cannot name. Stylesheets
// and scripts are plain text to a sniffer, and a browser refuses either one
// served as text/plain under nosniff — a previewed page would load without
// them. Media a page or a media element loads is already named by DetectMIME.
//
// Spelled out here rather than taken from mime.TypeByExtension, which reads the
// machine's own registry: on Windows that commonly maps .js to text/plain.
var servedExtMIMEs = map[string]string{
	".html": "text/html; charset=utf-8",
	".htm":  "text/html; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".mjs":  "text/javascript; charset=utf-8",
	".json": "application/json",
}

// DetectServedMIME is DetectMIME for content a browser loads directly rather
// than through the app: a page, its stylesheets and scripts, a video or audio
// file. It adds the types those need and sniffing cannot name, under the same
// rule — the extension is consulted only where sniffing gave up.
//
// HTML no name accounts for is served as sniffed: DetectMIME's rule is about
// which files the app offers as pages, and a page navigating to a document of
// its own with no .html extension still needs it served as one.
func DetectServedMIME(name string, head []byte) string {
	detected := DetectMIME(name, head)
	if !isGenericType(detected) {
		return detected
	}
	if mime, ok := servedExtMIMEs[strings.ToLower(filepath.Ext(name))]; ok {
		return mime
	}
	if sniffed := http.DetectContentType(head); strings.HasPrefix(sniffed, "text/html") {
		return sniffed
	}
	return detected
}

// IsImageMIME reports whether content of this type is something to render as a
// picture, which is what decides whether it is worth sending at all.
//
// One test rather than one per call site: this package and the agent parsers
// that keep an agent's images have to agree on what counts, or a format one
// side stores is a format the other refuses to send back.
func IsImageMIME(mime string) bool {
	return strings.HasPrefix(mime, "image/")
}

// IsRasterImageMIME reports whether content of this type is an image delivered
// as bytes over HTTP (EncodingHTTP) rather than as text.
//
// SVG is the exception, and a security boundary rather than a preference: it
// is source the user can edit, so it is sent as text, and a client rendering
// it never needs its bytes as a same-origin blob — which is the one form in
// which "open image in new tab" would run the SVG's scripts in the app's
// origin, where they can read the login token.
func IsRasterImageMIME(mime string) bool {
	return IsImageMIME(mime) && !strings.HasPrefix(mime, "image/svg+xml")
}

// IsPlayableMIME reports whether content of this type is audio or video —
// something a client plays rather than draws or reads.
func IsPlayableMIME(mime string) bool {
	return strings.HasPrefix(mime, "audio/") || strings.HasPrefix(mime, "video/")
}

// isMediaMIME reports whether content of this type is previewable media: a
// raster image or something playable, the types NewFileContent describes as
// EncodingHTTP.
func isMediaMIME(mime string) bool {
	return IsRasterImageMIME(mime) || IsPlayableMIME(mime)
}

// IsMedia reports whether the file name, whose leading bytes are head, is
// previewable media — the content NewFileContent describes as EncodingHTTP (a
// raster image only up to MaxImageSize). head need be no longer than
// SniffLen.
//
// The type alone is not enough, because for the formats sniffing cannot name
// (AVIF, HEIC, TIFF, a .mov) it comes from the extension: a text file that
// only carries one — a git-LFS pointer committed as photo.avif or clip.mov —
// would otherwise be handed to the client as media it cannot render, instead
// of as the text it is. Every real image, audio and video format opens with
// binary bytes, so requiring them costs nothing media could need.
func IsMedia(name string, head []byte) bool {
	return isMediaOf(name, head, isMediaMIME)
}

// IsRasterImage is IsMedia narrowed to raster images.
func IsRasterImage(name string, head []byte) bool {
	return isMediaOf(name, head, IsRasterImageMIME)
}

func isMediaOf(name string, head []byte, isType func(mime string) bool) bool {
	if len(head) > SniffLen {
		head = head[:SniffLen]
	}
	return isType(DetectMIME(name, head)) && IsBinaryProbe(head)
}

// isGenericType reports whether http.DetectContentType matched no signature and
// fell back to classifying the bytes as merely textual or merely binary.
func isGenericType(mime string) bool {
	return mime == "application/octet-stream" ||
		strings.HasPrefix(mime, "text/plain") ||
		strings.HasPrefix(mime, "text/xml")
}

// IsBinary reports whether the whole content of a file can be delivered as
// text. Content sniffing rejects the formats it knows and any byte soup that
// could not be text; UTF-8 validation then rejects what sniffing let through,
// since JSON encoding substitutes U+FFFD for every invalid byte — which both
// corrupts the content and inflates it threefold.
//
// Text in a legacy encoding (GBK, Shift-JIS, Latin-1) is therefore reported as
// binary. Delivering it would mean handing the client mojibake it has no way to
// recognise as such; refusing it at least says so.
func IsBinary(data []byte) bool {
	return isBinary(data, false)
}

// IsBinaryProbe answers the same question from the head of a file instead of
// all of it, for callers that would rather not read the whole thing to ask.
//
// A multi-byte character cut off by the end of the window is not held against
// the file — otherwise every file whose head happened to end mid-character
// would be called binary. The cost of that leniency is that invalid bytes past
// the window go unnoticed, which is why it is not what IsBinary does.
func IsBinaryProbe(head []byte) bool {
	return isBinary(head, true)
}

func isBinary(data []byte, truncated bool) bool {
	if !strings.HasPrefix(http.DetectContentType(data), "text/") {
		return true
	}
	// NUL is valid UTF-8 and never appears in text, and sniffing only saw the
	// first SniffLen bytes.
	if bytes.IndexByte(data, 0) >= 0 {
		return true
	}
	if truncated {
		data = trimIncompleteRune(data)
	}
	return !utf8.Valid(data)
}

// trimIncompleteRune drops a trailing UTF-8 sequence that has no room left to
// finish, so a valid file whose multi-byte character straddles the end of a
// probe window is not mistaken for binary. Only IsBinaryProbe wants this: given
// a whole file there is no window to straddle, and a trailing invalid byte is
// simply invalid.
func trimIncompleteRune(data []byte) []byte {
	if r, size := utf8.DecodeLastRune(data); r != utf8.RuneError || size > 1 {
		return data
	}
	for i := len(data) - 1; i >= 0 && len(data)-i <= utf8.UTFMax; i-- {
		if utf8.RuneStart(data[i]) {
			return data[:i]
		}
	}
	return data
}

// WriteFile writes content to a file within workDir.
// Creates the file and parent directories if they don't exist.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
// Returns ErrTooLarge for content over MaxFileSize.
func WriteFile(workDir, path, content string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	// Enforced here rather than in the RPC handler so that both directions
	// check the same constant at the same layer and cannot drift apart.
	if len(content) > MaxFileSize {
		return fmt.Errorf("%w: %d bytes, limit %d", ErrTooLarge, len(content), MaxFileSize)
	}

	fullPath := filepath.Join(workDir, path)

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create parent directories: %w", err)
	}

	// Deliberately a plain write, not filestore.WriteFileAtomic: these are files
	// in the user's own project. Replacing one by rename would break hard links,
	// reset an executable script back to 0644, swap the inode out from under
	// anything watching it, and litter the working tree with .tmp/.lock files
	// that show up in git status. In-place writing keeps the file the user's.
	return os.WriteFile(fullPath, []byte(content), 0644)
}

// Create makes an empty file or an empty directory at path within workDir.
// Missing parent directories are created, as WriteFile does, so a client can
// pass "docs/api/index.md" without creating each level first.
//
// Unlike WriteFile it refuses an existing path with ErrExists: this backs the
// UI's "new file" / "new folder" actions, where quietly reusing whatever
// already sits at that name is indistinguishable from having created it.
func Create(workDir, path string, isDir bool) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	if err := os.MkdirAll(filepath.Dir(fullPath), 0755); err != nil {
		return fmt.Errorf("failed to create parent directories: %w", err)
	}

	// Refusing a taken name is left to the creating syscall rather than a stat
	// before it: a check-then-create can be overtaken by an agent writing the
	// same path, and both O_EXCL and Mkdir already refuse a symlink sitting on
	// the name instead of creating through it to wherever it points.
	var err error
	if isDir {
		err = os.Mkdir(fullPath, 0755)
	} else {
		err = createEmptyFile(fullPath)
	}
	if err != nil {
		if errors.Is(err, os.ErrExist) || taken(fullPath) {
			return existsError(path)
		}
		return fmt.Errorf("failed to create %s: %w", path, err)
	}

	return nil
}

// taken reports whether something already sits at fullPath. Lstat, so a symlink
// holds the name whether or not it points anywhere.
//
// Create asks after the fact, to classify a creation the OS already refused:
// the error for "a name is taken by the other kind of entry" is not ErrExist
// everywhere — opening a directory as a file comes back as EISDIR on Windows,
// where unix reports EEXIST for the same O_EXCL call. Leaving that unclassified
// would hand the UI's "new file" action a raw syscall error where every other
// taken name gets ErrExists. The creating syscall still owns the race — this
// only reads the state it just refused.
//
// Rename has to ask *before* instead, because rename(2) refuses nothing, and it
// also has to allow for a name that only *looks* taken; see blocks.
func taken(fullPath string) bool {
	_, err := os.Lstat(fullPath)
	return err == nil
}

// blocks reports whether the entry Lstat found on a rename's destination is a
// real obstacle, given the source it would replace and the directory both sit
// in.
//
// It usually is, and then this is simply "the name is taken". The exception is
// the whole reason this is not a bare existence check: on a case-insensitive
// filesystem — APFS and NTFS, so macOS and Windows by default — looking up
// `readme.md` finds `README.md`, and refusing on that would make changing a
// name's capitalisation impossible anywhere but Linux. That is not a nicety.
// `os.Rename` performs exactly that rename correctly on both; it is only the
// guard in front of it that has to stop mistaking the entry for its own
// obstacle.
//
// os.SameFile is most of the answer but not all of it, because two directory
// entries can name one inode without any case folding: `a.txt` and `A.txt` as
// hard links on a case-sensitive filesystem. Those are two real names, and
// taking one of them is refused. What separates the cases is the directory
// listing — case folding means the new name is not literally in it, while a
// hard link sibling is — so that is the question asked, and only in the narrow
// case where it decides anything.
func blocks(srcInfo, dstInfo os.FileInfo, dir, newName string) bool {
	if !os.SameFile(srcInfo, dstInfo) {
		return true
	}
	return nameInDir(dir, newName)
}

// nameInDir reports whether dir holds an entry spelled exactly name.
//
// A read error answers "yes", which is the safe way to be wrong here: the only
// caller is deciding whether to let os.Rename onto that name, and os.Rename
// replaces whatever it finds there.
func nameInDir(dir, name string) bool {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return true
	}
	for _, entry := range entries {
		if entry.Name() == name {
			return true
		}
	}
	return false
}

// existsError reports a name that is already taken, in the one sentence the web
// UI matches on to keep its naming sheet open. Create and Rename must not
// phrase it differently — the client cannot tell which one it called from the
// message alone, and should not have to.
func existsError(relPath string) error {
	return fmt.Errorf("%s %w", relPath, ErrExists)
}

func createEmptyFile(fullPath string) error {
	f, err := os.OpenFile(fullPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	return f.Close()
}

// Delete removes a file or directory within workDir.
// For directories, it recursively removes all contents.
// Returns ErrInvalidPath for path traversal attempts, absolute paths, or empty paths.
// Returns ErrNotFound if the path doesn't exist.
func Delete(workDir, path string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	if _, err := os.Stat(fullPath); err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return fmt.Errorf("failed to stat path: %w", err)
	}

	return os.RemoveAll(fullPath)
}

// DeleteFile deletes a file within workDir.
// Deprecated: Use Delete instead, which handles both files and directories.
func DeleteFile(workDir, path string) error {
	return Delete(workDir, path)
}

// Rename changes the name of the entry at path, leaving it in the directory it
// is already in. newName is a name, not a path: it may not contain a separator,
// so this cannot move an entry, only rename it in place.
//
// Moving is deliberately out of scope rather than an omission. Accepting a
// separator here would fold "move" and "create the parents along the way" into
// the same text field the UI uses for naming, with a failure surface — target
// directory missing, target is a file, a directory moved into its own subtree,
// a cross-directory overwrite — that the user cannot see coming while typing a
// name. The rule matches file.create's: see docs/file.md.
//
// Changing only the capitalisation of a name works, including on the
// case-insensitive filesystems where looking the new name up finds the entry
// itself; see blocks for how that is told apart from a name genuinely taken.
//
// Returns ErrNotFound if path doesn't exist, ErrExists if newName is already
// taken in that directory, and ErrInvalidPath for a path that escapes workDir
// or for a name that is empty, reserved, or contains a separator.
func Rename(workDir, path, newName string) error {
	if path == "" {
		return fmt.Errorf("%w: empty path", ErrInvalidPath)
	}

	if err := ValidatePath(workDir, path); err != nil {
		return err
	}

	if err := validateName(newName); err != nil {
		return err
	}

	fullPath := filepath.Join(workDir, path)

	// The destination comes from the source's own parent directory, not from
	// rebuilding the relative path: "the same directory" then holds however the
	// client spelled the path — a Windows separator, a trailing slash, a "."
	// segment — where reconstruction would silently relocate the entry.
	// newName has no separator and is neither "." nor "..", so this stays one
	// component below a directory already known to be inside workDir.
	newFullPath := filepath.Join(filepath.Dir(fullPath), newName)

	// Only ever reported, never used to reach the file: it is the relative path
	// the client speaks, so the client can match the name it asked about.
	newPath := siblingPath(path, newName)

	// Lstat, not Stat: a symlink is an entry with a name like any other, and
	// os.Rename renames the link rather than what it points at. Stat would call
	// a dangling link missing and refuse to rename something that is plainly
	// there in the listing.
	srcInfo, err := os.Lstat(fullPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%w: %s", ErrNotFound, path)
		}
		return fmt.Errorf("failed to stat path: %w", err)
	}

	// Renaming an entry onto its own name is the state the caller asked for, so
	// it is not an error — and it must be answered before the check below,
	// which would otherwise report the entry as blocking itself.
	if newFullPath == fullPath {
		return nil
	}

	// Unlike Create, this cannot leave "already exists" to the syscall: POSIX
	// rename(2) silently replaces an existing destination, so without this the
	// method would delete a file the user never named. There is no portable
	// atomic alternative (RENAME_NOREPLACE is Linux-only), so a check with a
	// race is the honest trade — losing the race means overwriting, which is
	// bad, but the window is between two adjacent syscalls and the alternative
	// is overwriting every time. Lstat for the same reason as above: a symlink
	// takes the name whether or not it points anywhere.
	dstInfo, err := os.Lstat(newFullPath)
	if err == nil && blocks(srcInfo, dstInfo, filepath.Dir(fullPath), newName) {
		return existsError(newPath)
	}

	// No retry loop here, unlike filestore's atomic writes: those retry because
	// Windows fails a rename that *replaces* a destination someone else has
	// open, and that case is refused above. What is left — a source held open
	// elsewhere — is a real failure to report, not a transient one to wait out.
	if err := os.Rename(fullPath, newFullPath); err != nil {
		if errors.Is(err, os.ErrExist) {
			return existsError(newPath)
		}
		return fmt.Errorf("failed to rename %s: %w", path, err)
	}

	return nil
}

// validateName checks that name can stand as a single entry in a directory.
//
// The separator test is what keeps Rename from moving anything; IsLocal is the
// same gate ValidatePath applies to whole paths, so a name this accepts is a
// path component ValidatePath would accept too — one rule about what a name may
// be, not two that can drift apart.
func validateName(name string) error {
	if name == "" {
		return fmt.Errorf("%w: empty name", ErrInvalidPath)
	}
	if strings.ContainsRune(name, '/') || strings.ContainsRune(name, filepath.Separator) {
		return fmt.Errorf("%w: name must not contain a separator: %s", ErrInvalidPath, name)
	}
	// IsLocal rejects ".." and the Windows device names but accepts ".", which
	// names the directory the entry is in rather than an entry in it.
	if name == "." || !filepath.IsLocal(name) {
		return fmt.Errorf("%w: %s", ErrInvalidPath, name)
	}
	return nil
}

// siblingPath rebuilds relPath with its last component replaced by name.
//
// Uses path, not filepath: these are the slash-separated relative paths the RPC
// layer speaks and listings hand out, and they stay that way on every platform.
// Cleaning first is what makes "docs/" and "docs/." name the same parent that
// filepath.Dir gives the destination, so the path in an error message is the
// one the operation would have used.
func siblingPath(relPath, name string) string {
	dir := path.Dir(path.Clean(filepath.ToSlash(relPath)))
	if dir == "." {
		return name
	}
	return dir + "/" + name
}
