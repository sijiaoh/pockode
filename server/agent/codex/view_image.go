package codex

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/internal/pathutil"
)

// handleImageViewCompleted reports the image Codex's view_image tool put in
// front of the model, taking a copy of it into the session's attachment store.
//
// An `imageView` item arrives as an ordinary thread item: item/started and
// item/completed, both carrying {type, id, path} and nothing else (measured end
// to end on codex-cli 0.153.0). Without a case for it the item falls through
// both type switches and the user sees nothing at all — the model discusses a
// screenshot that never appeared in the transcript. The pair is rendered as the
// call and its result, which is what the lifecycle already offers and what every
// other tool here produces, so it lands in the same chat UI as claude reading an
// image rather than needing a branch of its own; the tool is named Read for the
// same reason, since that is what the operation is and the input summary already
// knows how to render a file_path.
//
// The image is reported even when the path is unusable, which is why
// imageViewLocalPath's failure does not return: Codex looked at something, and a
// transcript that says so and admits it could not fetch it is worth more than one
// that pretends the turn never touched an image. The unusable path is still
// shown, since it is the only description of the file there is.
func (s *appSession) handleImageViewCompleted(item threadItem) {
	raw, ok := imageViewPath(item)
	if !ok {
		s.log.Warn("failed to parse imageView item")
		return
	}

	var file *agent.FileBlock
	if path := s.imageViewLocalPath(raw); path == "" {
		s.log.Warn("imageView named no file this machine can open", "path", raw)
		file = &agent.FileBlock{Path: raw, Omitted: contents.OmitUnavailable}
	} else {
		file = viewedImage(s.log, s.attachments, path)
	}

	s.emitEvent(agent.ToolResultEvent{
		ToolUseID:         item.ID,
		Contents:          []agent.ContentBlock{{Type: agent.ContentBlockFile, File: file}},
		ProviderMessageID: item.TurnID,
	})
}

// imageViewPath reads the path an imageView item names, still in whatever form
// Codex sent it.
//
// Shared by the call and the result so the two cannot disagree about whether the
// item is renderable: an item whose path does not decode produces neither,
// rather than a result with no call above it.
func imageViewPath(item threadItem) (string, bool) {
	var ev struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(item.Raw, &ev); err != nil {
		return "", false
	}
	return ev.Path, true
}

// imageViewLocalPath turns the path an imageView item names into one this
// process can open, or "" when this machine has no such file.
//
// The relative case is not hypothetical bookkeeping: the schema types this field
// as a bare string and pointedly does *not* mark it absolute, though Codex has
// an AbsolutePathBuf type and uses it for imageGeneration's savedPath in the
// very same union. So a relative path is a shape the protocol allows, even
// though codex-cli 0.153.0 was only observed sending absolute ones. It is
// resolved against the thread's cwd because that is what a path the agent wrote
// means; left alone it would resolve against the *server* process's working
// directory, which has nothing to do with this session and would quietly show
// the user some other file as the one the agent looked at.
//
// pathutil.IsAnchored rather than filepath.IsAbs, because the question here is
// exactly the one it answers: joining is only right for a path the OS has not
// already anchored elsewhere. On Windows `\shot.png` and `C:shot.png` are both
// anchored and both reported relative by filepath.IsAbs, so joining on that test
// would build nonsense like <workdir>\C:shot.png. Not filepath.IsLocal either:
// an absolute path outside the work directory is the normal case here — a
// screenshot in /tmp — so confinement is not what is being asked.
func (s *appSession) imageViewLocalPath(raw string) string {
	path := localPath(raw)
	if path == "" || pathutil.IsAnchored(path) {
		return path
	}
	return filepath.Join(s.opts.WorkDir, path)
}

// viewedImage describes the file at path, taking a copy of it into the
// session's attachment store.
//
// Copying now is what keeps the path off the client's side of the wire. The
// path reaching here is an absolute one regularly outside the work directory —
// /tmp is where Codex puts a screenshot it fetched — and both channels a client
// has for reading a file, file.get and the download endpoint, serve relative
// paths inside the work directory and nothing else. Widening either one to take
// an absolute path would turn a chat event into a way to ask the server for any
// file the process can read, which is a far larger thing than showing a
// screenshot. Reading it here instead adds no reach: the bytes are read under
// the agent's own authority, at the moment the agent says it read them itself,
// and what the client can then ask for is one content-addressed file in one
// session's directory.
//
// Only what sniffs as an image is kept. The item says it is one, but the path
// is the agent's and the file is whatever is at it by the time this runs, so
// the assertion is not a licence to copy any file the process can read into the
// session's directory. Content that turns out not to be an image is described
// and left where it is, the same way the file namespace omits a non-image
// binary — there is nothing the UI would draw with it either way.
func viewedImage(log *slog.Logger, store attachments.Store, path string) *agent.FileBlock {
	file := &agent.FileBlock{Name: filepath.Base(path), Path: path}

	// Checked before opening, not after: opening a named pipe blocks until
	// something writes to it, and this runs on the goroutine reading Codex's
	// output — so a blocked open does not fail one image, it stops the session
	// from reporting anything ever again. Same guard, and the same reason for
	// its placement, as contents.GetContents. It covers a directory too.
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		// Deleted between the tool call and this notification, in a directory
		// the server cannot enter, or not a file to read at all. Said out loud
		// rather than dropped: a missing image the user can see is missing is
		// the difference between a bug report and a mystery.
		log.Warn("cannot read the image codex viewed", "error", err, "path", path)
		file.Omitted = contents.OmitUnavailable
		return file
	}

	f, err := os.Open(path)
	if err != nil {
		log.Warn("failed to open the image codex viewed", "error", err, "path", path)
		file.Omitted = contents.OmitUnavailable
		return file
	}
	defer f.Close()

	// One byte past the ceiling is enough to know the file is over it, and
	// bounding the read keeps memory off the size of whatever was named.
	data, err := io.ReadAll(io.LimitReader(f, contents.MaxFileSize+1))
	if err != nil {
		log.Warn("failed to read the image codex viewed", "error", err, "path", path)
		file.Omitted = contents.OmitUnavailable
		return file
	}
	file.MIME = contents.DetectMIME(path, data)

	if !contents.IsImageMIME(file.MIME) {
		log.Warn("the file codex viewed is not an image", "path", path, "mime", file.MIME)
		file.Size = info.Size()
		file.Omitted = contents.OmitBinary
		return file
	}
	file.Width, file.Height = agent.ImageDimensions(log, data)

	if int64(len(data)) > contents.MaxFileSize {
		// Storing it would only move the refusal to the fetch, which answers
		// through one JSON-RPC message and would refuse it there. The size is
		// the whole file's, taken from the stat: what was read is the limit, and
		// reporting that would make the refusal look like it disagreed with its
		// own reason.
		file.Size = info.Size()
		file.Omitted = contents.OmitTooLarge
		file.Limit = contents.MaxFileSize
		return file
	}
	// Describes the bytes that were stored, which is what a client will fetch —
	// not the stat, which a tool writing to the file beside us has already
	// outdated.
	file.Size = int64(len(data))

	// The path's extension goes with it where it is one that names the content:
	// an AVIF or an SVG stored under a bare hash comes back unrecognisable and
	// could never be shown, however well it was stored.
	id, err := store.Put(data, contents.ImageExtension(path))
	if err != nil {
		log.Warn("failed to store the image codex viewed", "error", err, "path", path)
		file.Omitted = contents.OmitUnavailable
		return file
	}
	file.AttachmentID = id
	return file
}

// localPath turns what Codex calls a path into one this process can open. The
// item's `path` is typed as a bare string, and it has been seen in two forms:
// a plain absolute path (/tmp/shot.png, what app-server sends on codex-cli
// 0.153.0) and a file URI (file:///tmp/shot.png, what the MCP channel sent),
// which is percent-encoded and, on Windows, carries a leading slash before the
// drive letter. Anything that is not a file URI is taken to be a path already
// and passed through: neither form is promised by the schema, and a plain path
// that opens is better than a path refused for the shape it arrived in.
//
// A URI naming another host is not a path here, and comes back empty.
func localPath(raw string) string {
	if !strings.HasPrefix(raw, "file:") {
		return raw
	}

	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if u.Host != "" && u.Host != "localhost" {
		return ""
	}

	return uriPathToNative(u.Path)
}
