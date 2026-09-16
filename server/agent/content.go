package agent

import (
	"bytes"
	"image"
	"log/slog"

	// Registered for their DecodeConfig only, to read an image's dimensions from
	// its header. These three cover what reaches here: claude re-encodes
	// anything large as JPEG and passes small PNGs through, and the images
	// codex's view_image names on disk are overwhelmingly one of the three.
	// WebP, BMP and TIFF would each cost a dependency or a decoder of their own
	// for a format the tools rarely produce, and a format none of these can
	// decode costs the dimensions and nothing else — the UI then holds a
	// fallback shape rather than the right one.
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"

	"github.com/pockode/server/contents"
)

// ContentBlockType names the kinds of piece an agent's output can be cut into.
type ContentBlockType string

const (
	ContentBlockText ContentBlockType = "text"
	// ContentBlockFile is anything the UI shows as a file rather than as prose:
	// the image a tool returned, the PDF a read delivered.
	ContentBlockFile ContentBlockType = "file"
	// ContentBlockToolReference names a tool rather than carrying content —
	// what a tool search answers with. It stays a block of its own instead of
	// being flattened into a line of text so the UI can render the names as
	// what they are.
	ContentBlockToolReference ContentBlockType = "tool_reference"
)

// ContentBlock is one piece of a tool result, in the order the agent produced
// it. A result that is nothing but prose carries no blocks at all — see
// ToolResultEvent.Contents.
type ContentBlock struct {
	Type ContentBlockType `json:"type"`
	Text string           `json:"text,omitempty"`
	File *FileBlock       `json:"file,omitempty"`
	// ToolName is the tool a tool_reference block names.
	ToolName string `json:"tool_name,omitempty"`
}

// FileBlock describes one file-like piece of an agent's output.
//
// The agents differ on what they hand over — claude delivers the content
// itself, codex names a file on this machine — but that difference is settled
// before a block is built: codex's file is read and stored where claude's
// content is stored. So there is one way to the bytes, AttachmentID, and a
// client has one way to fetch them; Omitted says why a block has none.
//
// Path is then description, not a channel: it says which file was looked at,
// which is what the UI shows beside the image and what lets it offer to open
// the file when it is one of the work directory's. Nothing is fetched by it.
//
// It is deliberately not contents.FileContent: that type describes a file
// inside a work directory, addressed by a path a client can read, write and
// delete through the file namespace. These are neither — they are content that
// arrived in a conversation, and the only thing to do with them is look.
type FileBlock struct {
	// Name is for display. Empty when the agent named no file, which is the
	// usual case for an image a tool returned inline.
	Name string `json:"name,omitempty"`
	// MIME is what the agent called the content, which is also what it was
	// encoded as — these arrive already typed, so nothing is sniffed here.
	MIME string `json:"mime"`
	Size int64  `json:"size,omitempty"`
	// Width and Height describe the delivered bytes, not the original file:
	// claude re-encodes a large image down before handing it over. Zero when
	// they could not be read (a format Go cannot decode, a non-image). They are
	// here so the UI can hold the space before the content arrives.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
	// AttachmentID names the content in the session's attachment store.
	AttachmentID string `json:"attachment_id,omitempty"`
	// Path is the file this content came from, absolute and in the form the
	// machine the agent runs on uses. Set only when the agent named one, and it
	// may well be outside the work directory — codex's view_image reads from
	// /tmp as readily as from the project. Display only; see the type comment.
	Path string `json:"path,omitempty"`
	// Omitted explains a block with no content behind it, reusing the file
	// namespace's vocabulary so one client code path renders both.
	Omitted contents.OmitReason `json:"omitted,omitempty"`
	// Limit is the ceiling that kept the content out, sent only with
	// contents.OmitTooLarge.
	Limit int64 `json:"limit,omitempty"`
}

// ImageDimensions reads an image's width and height out of its header,
// returning zeroes for anything that does not decode — a format Go does not
// know, content that is not an image at all.
//
// They travel with the block so a client can hold the right amount of space
// before the content it will draw there has arrived. Without them a chat
// scrolled back through re-lays-out under the reader as each image loads.
func ImageDimensions(log *slog.Logger, data []byte) (int, int) {
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		log.Debug("could not read image dimensions", "error", err, "format", format)
		return 0, 0
	}
	return cfg.Width, cfg.Height
}
