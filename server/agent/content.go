package agent

import (
	"bytes"
	"encoding/binary"
	"image"
	"log/slog"

	// Registered for their DecodeConfig only, to read an image's dimensions from
	// its header. With webpDimensions these cover the image types the agents
	// take inline (see InlineImageMIMEs), and claude only inlines an image whose
	// dimensions are known — so a format missing here is one an upload can never
	// send as an image. BMP, TIFF and the rest are left out: nothing takes them
	// inline, and a format nothing here can read costs the dimensions and
	// nothing else — the UI then holds a fallback shape rather than the right one.
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
		if w, h, ok := webpDimensions(data); ok {
			return w, h
		}
		log.Debug("could not read image dimensions", "error", err, "format", format)
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

// webpDimensions reads a WebP's canvas size from the first chunk of its RIFF
// container, in each of the three layouts the format has: lossy (VP8), lossless
// (VP8L) and extended (VP8X). Hand-read rather than through a WebP decoder,
// because the size is all that is wanted and it sits at fixed offsets.
func webpDimensions(data []byte) (int, int, bool) {
	if len(data) < 20 || string(data[0:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return 0, 0, false
	}
	p := data[20:] // the first chunk's payload
	switch string(data[12:16]) {
	case "VP8 ":
		// A 3-byte frame tag, the start code, then 14-bit sizes.
		if len(p) < 10 || p[3] != 0x9d || p[4] != 0x01 || p[5] != 0x2a {
			return 0, 0, false
		}
		w := int(binary.LittleEndian.Uint16(p[6:8]) & 0x3fff)
		h := int(binary.LittleEndian.Uint16(p[8:10]) & 0x3fff)
		return w, h, w > 0 && h > 0
	case "VP8L":
		// A signature byte, then width-1 and height-1 as 14-bit fields.
		if len(p) < 5 || p[0] != 0x2f {
			return 0, 0, false
		}
		bits := binary.LittleEndian.Uint32(p[1:5])
		return int(bits&0x3fff) + 1, int(bits>>14&0x3fff) + 1, true
	case "VP8X":
		// Flags and reserved bytes, then width-1 and height-1 as 24-bit fields.
		if len(p) < 10 {
			return 0, 0, false
		}
		w := int(p[4]) | int(p[5])<<8 | int(p[6])<<16
		h := int(p[7]) | int(p[8])<<8 | int(p[9])<<16
		return w + 1, h + 1, true
	}
	return 0, 0, false
}
