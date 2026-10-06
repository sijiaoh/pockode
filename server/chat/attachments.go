package chat

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
)

// ErrAttachmentNotFound is returned when a message names an attachment the
// session does not have — an id from another session, or one never uploaded.
var ErrAttachmentNotFound = errors.New("attachment not found")

// AttachmentRef is a file a client attached to a message: an id the upload
// endpoint handed out, and the name the user knows the file by. The name is the
// client's to give because the id is the content's hash and keeps none of it.
type AttachmentRef struct {
	ID   string
	Name string
}

// ResolveAttachments turns the files a message names into what the agent is
// handed and the record keeps, describing each from the stored bytes rather
// than from anything the client said about them.
//
// Every id is checked before any is used, so a message naming one bad id is
// refused whole instead of delivered with a file missing.
func ResolveAttachments(log *slog.Logger, dataDir, sessionID string, refs []AttachmentRef) ([]agent.Attachment, error) {
	out := make([]agent.Attachment, 0, len(refs))
	for _, ref := range refs {
		path, err := attachments.Resolve(dataDir, sessionID, ref.ID)
		if errors.Is(err, attachments.ErrNotFound) {
			return nil, fmt.Errorf("%w: %s", ErrAttachmentNotFound, ref.ID)
		}
		if err != nil {
			return nil, err
		}
		file, err := describeAttachment(log, path, ref)
		if err != nil {
			return nil, err
		}
		out = append(out, agent.Attachment{File: file, Path: path})
	}
	return out, nil
}

func describeAttachment(log *slog.Logger, path string, ref AttachmentRef) (agent.FileBlock, error) {
	f, err := os.Open(path)
	if err != nil {
		return agent.FileBlock{}, fmt.Errorf("open attachment %s: %w", ref.ID, err)
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return agent.FileBlock{}, fmt.Errorf("stat attachment %s: %w", ref.ID, err)
	}

	head := make([]byte, contents.SniffLen)
	n, err := io.ReadFull(f, head)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return agent.FileBlock{}, fmt.Errorf("read attachment %s: %w", ref.ID, err)
	}
	// By the id, not the user's name: the id keeps the extension the upload
	// arrived with (attachments.UploadExtension), and that is the half of
	// DetectMIME sniffing cannot do without.
	mime := contents.DetectMIME(ref.ID, head[:n])

	file := agent.FileBlock{
		Name:         ref.Name,
		MIME:         mime,
		Size:         info.Size(),
		AttachmentID: ref.ID,
	}
	if contents.IsImageMIME(mime) {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return agent.FileBlock{}, fmt.Errorf("read attachment %s: %w", ref.ID, err)
		}
		// The header is all DecodeConfig reads, so the file is not loaded whole;
		// a header past this bound costs the dimensions and nothing else.
		data, err := io.ReadAll(io.LimitReader(f, 1<<20))
		if err != nil {
			return agent.FileBlock{}, fmt.Errorf("read attachment %s: %w", ref.ID, err)
		}
		file.Width, file.Height = agent.ImageDimensions(log, data)
	}
	return file, nil
}
