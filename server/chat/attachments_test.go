package chat

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"log/slog"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/session"
)

func pngBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, w, h))); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// webpBytes is a lossless WebP's header, which is all reading its dimensions
// needs. The standard library has no WebP encoder to build a whole one with.
func webpBytes(w, h int) []byte {
	// VP8L: signature byte, then width-1 and height-1 as 14-bit fields packed
	// little-endian, then the alpha hint and a 3-bit version, both zero.
	bits := uint32(w-1) | uint32(h-1)<<14
	vp8l := []byte{0x2f, byte(bits), byte(bits >> 8), byte(bits >> 16), byte(bits >> 24)}
	chunk := append([]byte("VP8L"), byte(len(vp8l)), 0, 0, 0)
	chunk = append(chunk, vp8l...)
	chunk = append(chunk, 0) // pad to an even length
	riff := append([]byte("WEBP"), chunk...)
	return append([]byte{'R', 'I', 'F', 'F', byte(len(riff)), 0, 0, 0}, riff...)
}

func TestResolveAttachments(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	dataDir := t.TempDir()
	store := attachments.NewStore(dataDir, "sess")
	imageID, err := store.Put(pngBytes(t, 3, 2), attachments.UploadExtension("shot.png"))
	if err != nil {
		t.Fatal(err)
	}
	// WebP has a case of its own because the standard library cannot read it:
	// without its own header reader it would arrive with no dimensions, and
	// claude would never take it inline.
	webpID, err := store.Put(webpBytes(5, 4), attachments.UploadExtension("photo.webp"))
	if err != nil {
		t.Fatal(err)
	}
	pdf := []byte("%PDF-1.4\n%fake")
	pdfID, err := store.Put(pdf, attachments.UploadExtension("report.pdf"))
	if err != nil {
		t.Fatal(err)
	}

	got, err := ResolveAttachments(log, dataDir, "sess", []AttachmentRef{
		{ID: imageID, Name: "shot.png"},
		{ID: pdfID, Name: "report.pdf"},
		{ID: webpID, Name: "photo.webp"},
	})
	if err != nil {
		t.Fatalf("ResolveAttachments: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d attachments, want 3", len(got))
	}

	img := got[0].File
	if img.MIME != "image/png" || img.Width != 3 || img.Height != 2 || img.Name != "shot.png" || img.AttachmentID != imageID {
		t.Errorf("image described as %+v", img)
	}
	doc := got[1].File
	if doc.MIME != "application/pdf" || doc.Size != int64(len(pdf)) || doc.Width != 0 {
		t.Errorf("pdf described as %+v", doc)
	}
	webp := got[2].File
	if webp.MIME != "image/webp" || webp.Width != 5 || webp.Height != 4 {
		t.Errorf("webp described as %+v", webp)
	}
	if want, _ := attachments.Resolve(dataDir, "sess", pdfID); got[1].Path != want {
		t.Errorf("path = %q, want the stored file %q", got[1].Path, want)
	}

	// One id the session does not have refuses the whole message.
	_, err = ResolveAttachments(log, dataDir, "sess", []AttachmentRef{{ID: imageID}, {ID: "nope"}})
	if !errors.Is(err, ErrAttachmentNotFound) {
		t.Errorf("unknown id error = %v, want ErrAttachmentNotFound", err)
	}
}

func TestClient_SendWithAttachments(t *testing.T) {
	file := agent.FileBlock{Name: "shot.png", MIME: "image/png", Size: 10, AttachmentID: "abc"}
	attached := []agent.Attachment{{File: file, Path: "/data/abc"}}

	setup := func(t *testing.T, receives bool) (*Client, session.Store, *mockAgent) {
		t.Helper()
		store, err := session.NewFileStore(t.TempDir())
		if err != nil {
			t.Fatal(err)
		}
		pm, ag := newTestManagerWithAgent(t, store)
		ag.receivesAttachments = receives
		t.Cleanup(pm.Shutdown)
		if _, err := store.Create(context.Background(), "sess", session.CreateSpec{AgentType: session.AgentTypeClaude, Mode: session.ModeDefault}); err != nil {
			t.Fatal(err)
		}
		return NewClient(store, pm), store, ag
	}

	t.Run("delivered to the agent and described in the record", func(t *testing.T) {
		client, store, ag := setup(t, true)
		if _, err := client.SendMessageExcluding(context.Background(), "sess", "", attached, nil); err != nil {
			t.Fatalf("send: %v", err)
		}
		sent := ag.session(t, 1).sent()
		if len(sent) != 1 || len(sent[0].Attachments) != 1 || sent[0].Attachments[0].Path != "/data/abc" {
			t.Errorf("agent was handed %+v", sent)
		}
		history, err := store.GetHistory(context.Background(), "sess")
		if err != nil || len(history) != 1 {
			t.Fatalf("history = %d records, err %v", len(history), err)
		}
		if !bytes.Contains(history[0], []byte(`"attachments":[{"name":"shot.png","mime":"image/png","size":10,"attachment_id":"abc"}]`)) {
			t.Errorf("record = %s, want the file described by id", history[0])
		}
		if bytes.Contains(history[0], []byte("/data/abc")) {
			t.Errorf("record = %s carries the path, which is the agent's alone", history[0])
		}
	})

	t.Run("refused whole when the agent cannot receive files", func(t *testing.T) {
		client, store, ag := setup(t, false)
		_, err := client.SendMessageExcluding(context.Background(), "sess", "look", attached, nil)
		if !errors.Is(err, ErrAttachmentsUnsupported) {
			t.Fatalf("send error = %v, want ErrAttachmentsUnsupported", err)
		}
		if sent := ag.session(t, 1).sent(); len(sent) != 0 {
			t.Errorf("agent was handed %+v, want nothing", sent)
		}
		if history, _ := store.GetHistory(context.Background(), "sess"); len(history) != 0 {
			t.Errorf("history = %d records, want a refused message to leave none", len(history))
		}
	})
}
