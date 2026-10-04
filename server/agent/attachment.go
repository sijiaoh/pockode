package agent

import (
	"fmt"
	"strings"
)

// Attachment is one file the user sent with a message, on its way to the agent.
//
// The file has already been stored in the session's attachment store by the
// time a message names it (see package attachments), so what travels here is
// where it is rather than its bytes: each agent decides for itself whether to
// read the file and hand the content over, or to tell the model where it is.
type Attachment struct {
	// File is what the message record says about it — the same description a
	// file an agent delivered gets, so a client draws both with one code path.
	File FileBlock
	// Path is the stored file, absolute, on this machine. It is the agent's
	// alone: the record names the file by File.AttachmentID.
	Path string
}

// AttachmentReceiver is implemented by agent sessions that can deliver
// attachments with a prompt.
//
// It is the capability check the send path makes before anything is written:
// a message whose files an agent would silently drop is refused instead
// (chat.ErrAttachmentsUnsupported), so the user learns the agent never saw
// them rather than reading an answer given without them.
type AttachmentReceiver interface {
	ReceivesAttachments()
}

// InlineImageMIMEs are the image types both CLIs Pockode ships take as image
// input — the four the Anthropic API accepts, which codex's localImage reads as
// well. Anything else, an image in another format included, is delivered by
// path for the agent to open with its own tools.
var InlineImageMIMEs = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/gif":  true,
	"image/webp": true,
}

// SplitAttachments separates the attachments an agent hands over as content
// from those it can only point the model at.
func SplitAttachments(attachments []Attachment, inline func(Attachment) bool) (inlined, byPath []Attachment) {
	for _, a := range attachments {
		if inline(a) {
			inlined = append(inlined, a)
		} else {
			byPath = append(byPath, a)
		}
	}
	return inlined, byPath
}

// AttachedFilesNote is the text that tells the model about files it was not
// handed as content, so it can read them itself. Empty for none.
//
// Without it a file the agent cannot take inline — a PDF, a log, an image too
// large to send — would reach the model as nothing at all, and the user would
// get an answer that never looked at it.
func AttachedFilesNote(attachments []Attachment) string {
	if len(attachments) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("The user attached these files to this message. Read them from these paths:")
	for _, a := range attachments {
		name := a.File.Name
		if name == "" {
			name = "(unnamed)"
		}
		// Quoted, because the name is whatever the client sent: a newline in it
		// would otherwise end this line and let the rest read as instructions.
		fmt.Fprintf(&b, "\n- %q (%s, %d bytes): %s", name, a.File.MIME, a.File.Size, a.Path)
	}
	return b.String()
}

// AppendNote joins a note onto the prompt text, leaving either alone when the
// other is empty — a message can be nothing but its attachments.
func AppendNote(text, note string) string {
	switch {
	case note == "":
		return text
	case text == "":
		return note
	default:
		return text + "\n\n" + note
	}
}
