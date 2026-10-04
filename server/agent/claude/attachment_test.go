package claude

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
)

func writeAttachment(t *testing.T, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func sentMessage(t *testing.T, prompt agent.Prompt) userMessage {
	t.Helper()
	var buf bytes.Buffer
	sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}}
	if err := sess.SendMessage(prompt); err != nil {
		t.Fatalf("SendMessage: %v", err)
	}
	var msg userMessage
	if err := json.Unmarshal(buf.Bytes(), &msg); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return msg
}

func TestSession_SendMessage_Attachments(t *testing.T) {
	imageData := []byte("png bytes")
	imagePath := writeAttachment(t, "a.png", imageData)
	pdfPath := writeAttachment(t, "b.pdf", []byte("%PDF"))

	t.Run("images inline, other files by path", func(t *testing.T) {
		msg := sentMessage(t, agent.Prompt{Text: "what is this?", Attachments: []agent.Attachment{
			{File: agent.FileBlock{Name: "shot.png", MIME: "image/png", Size: int64(len(imageData)), Width: 3, Height: 2}, Path: imagePath},
			{File: agent.FileBlock{Name: "report.pdf", MIME: "application/pdf", Size: 4}, Path: pdfPath},
		}})
		blocks := msg.Message.Content
		if len(blocks) != 2 {
			t.Fatalf("got %d blocks, want an image and a text", len(blocks))
		}
		img := blocks[0]
		if img.Type != "image" || img.Source == nil || img.Source.MediaType != "image/png" ||
			img.Source.Data != base64.StdEncoding.EncodeToString(imageData) {
			t.Errorf("image block = %+v", img)
		}
		text := blocks[1].Text
		if !strings.HasPrefix(text, "what is this?\n\n") || !strings.Contains(text, "report.pdf") || !strings.Contains(text, pdfPath) {
			t.Errorf("text = %q, want the message and then the PDF's path", text)
		}
		if strings.Contains(text, imagePath) {
			t.Errorf("text = %q names the image that was sent inline", text)
		}
	})

	t.Run("an image alone sends no empty text block", func(t *testing.T) {
		msg := sentMessage(t, agent.Prompt{Attachments: []agent.Attachment{
			{File: agent.FileBlock{MIME: "image/png", Size: int64(len(imageData)), Width: 3, Height: 2}, Path: imagePath},
		}})
		if len(msg.Message.Content) != 1 || msg.Message.Content[0].Type != "image" {
			t.Errorf("content = %+v, want the image alone", msg.Message.Content)
		}
	})

	t.Run("an image over the API's ceiling goes by path", func(t *testing.T) {
		msg := sentMessage(t, agent.Prompt{Attachments: []agent.Attachment{
			{File: agent.FileBlock{Name: "huge.png", MIME: "image/png", Size: maxInlineImage + 1, Width: 3, Height: 2}, Path: imagePath},
		}})
		if len(msg.Message.Content) != 1 || msg.Message.Content[0].Type != "text" ||
			!strings.Contains(msg.Message.Content[0].Text, imagePath) {
			t.Errorf("content = %+v, want the path in text", msg.Message.Content)
		}
	})

	t.Run("a file that cannot be read fails the send", func(t *testing.T) {
		var buf bytes.Buffer
		sess := &cliSession{log: testLogger(), stdin: nopWriteCloser{&buf}}
		err := sess.SendMessage(agent.Prompt{Text: "x", Attachments: []agent.Attachment{
			{File: agent.FileBlock{MIME: "image/png", Width: 1, Height: 1}, Path: filepath.Join(t.TempDir(), "gone.png")},
		}})
		if err == nil || buf.Len() != 0 {
			t.Errorf("err = %v, wrote %q; want an error and nothing sent", err, buf.String())
		}
	})
}

// Every image the API would refuse goes by path: a refused image block stays in
// claude's transcript and breaks every later turn.
func TestSplitInlineImages(t *testing.T) {
	img := func(size int64, w, h int) agent.Attachment {
		return agent.Attachment{File: agent.FileBlock{MIME: "image/png", Size: size, Width: w, Height: h}}
	}
	tests := []struct {
		name   string
		in     []agent.Attachment
		inline int
	}{
		{"an ordinary screenshot", []agent.Attachment{img(1000, 1170, 2532)}, 1},
		{"a header that could not be read", []agent.Attachment{img(1000, 0, 0)}, 0},
		{"a side over the API's ceiling", []agent.Attachment{img(1000, 1170, maxInlineSide+1)}, 0},
		{"a format the API does not take", []agent.Attachment{{File: agent.FileBlock{MIME: "image/heic", Size: 10, Width: 1, Height: 1}}}, 0},
		{"more than the message budget", []agent.Attachment{img(maxInlineImage, 10, 10), img(maxInlineImage, 10, 10), img(maxInlineImage, 10, 10), img(maxInlineImage, 10, 10), img(maxInlineImage, 10, 10)}, maxInlineTotal / maxInlineImage},
	}
	many := make([]agent.Attachment, maxInlineImages+3)
	for i := range many {
		many[i] = img(10, 10, 10)
	}
	tests = append(tests, struct {
		name   string
		in     []agent.Attachment
		inline int
	}{"more images than one request may carry", many, maxInlineImages})

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			inlined, byPath := splitInlineImages(tt.in)
			if len(inlined) != tt.inline || len(inlined)+len(byPath) != len(tt.in) {
				t.Errorf("inlined %d, by path %d; want %d inlined of %d", len(inlined), len(byPath), tt.inline, len(tt.in))
			}
		})
	}
}

// Files sent by path are outside the work directory, and claude asks before
// reading there; the attachment store is handed to it as a directory of its own.
func TestBuildArgs_AllowsTheAttachmentStore(t *testing.T) {
	args := buildArgs(agent.StartOptions{DataDir: "/data", SessionID: "sess"}, claudeLaunch{})
	if want := attachments.Dir("/data", "sess"); !hasFlagValue(args, "--add-dir", want) {
		t.Errorf("expected --add-dir %s in %v", want, args)
	}
	if args := buildArgs(agent.StartOptions{}, claudeLaunch{}); slices.Contains(args, "--add-dir") {
		t.Errorf("a session with no data directory has no store to allow, got %v", args)
	}
}
