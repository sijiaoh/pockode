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
)

// handleViewImage reports the image Codex's view_image tool put in front of the
// model. Until this existed the event fell through to the default branch and
// the user saw nothing at all — the model would discuss a screenshot that never
// appeared in the transcript.
//
// One Codex event covers the whole call, but it is reported as the call and its
// result, the pair every other tool produces, so it lands in the same chat UI as
// claude reading an image rather than needing a branch of its own. The tool is
// named Read for the same reason: that is what the operation is, and the input
// summary already knows how to render a file_path.
func (s *mcpSession) handleViewImage(raw json.RawMessage) {
	var ev struct {
		CallID string `json:"call_id"`
		Path   string `json:"path"`
	}
	if err := json.Unmarshal(raw, &ev); err != nil {
		s.log.Warn("failed to parse view_image_tool_call", "error", err)
		return
	}

	// Reported even when the path is unusable, which is why localPath's failure
	// does not return: Codex looked at something, and a transcript that says so
	// and admits it could not fetch it is worth more than one that pretends the
	// turn never touched an image. The unusable path is still shown, since it is
	// the only description of the file there is.
	path := localPath(ev.Path)

	input, _ := json.Marshal(map[string]string{"file_path": firstNonEmpty(path, ev.Path)})
	s.emitEvent(agent.ToolCallEvent{
		ToolUseID: ev.CallID,
		ToolName:  "Read",
		ToolInput: input,
	})

	var file *agent.FileBlock
	if path == "" {
		s.log.Warn("view_image_tool_call named no file this machine can open", "path", ev.Path)
		file = &agent.FileBlock{Path: ev.Path, Omitted: contents.OmitUnavailable}
	} else {
		file = viewedImage(s.log, s.attachments, path)
	}

	s.emitEvent(agent.ToolResultEvent{
		ToolUseID: ev.CallID,
		Contents:  []agent.ContentBlock{{Type: agent.ContentBlockFile, File: file}},
	})
}

// viewedImage describes the file at path, taking a copy of it into the
// session's attachment store.
//
// Copying now is what keeps the path off the client's side of the wire. Codex
// hands over an absolute path that is regularly outside the work directory —
// /tmp is where it puts a screenshot it fetched — and both channels a client
// has for reading a file, file.get and the download endpoint, serve relative
// paths inside the work directory and nothing else. Widening either one to take
// an absolute path would turn a chat event into a way to ask the server for any
// file the process can read, which is a far larger thing than showing a
// screenshot. Reading it here instead adds no reach: the bytes are read under
// the agent's own authority, at the moment the agent says it read them itself,
// and what the client can then ask for is one content-addressed file in one
// session's directory.
//
// Only what sniffs as an image is kept. The event says it is one, but the path
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
		// Deleted between the tool call and this event, in a directory the
		// server cannot enter, or not a file to read at all. Said out loud
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

// localPath turns what Codex calls a path into one this process can open. It
// sends a file URI (file:///tmp/shot.png), which is percent-encoded and, on
// Windows, carries a leading slash before the drive letter. Anything that is
// not a file URI is taken to be a path already and passed through: the URI form
// is what was observed, not something Codex promises, and a plain path that
// opens is better than a path refused for the shape it arrived in.
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
