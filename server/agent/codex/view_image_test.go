package codex

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/internal/fifotest"
)

// pngBytes encodes an image of the given size, so a test can assert on
// dimensions that were read from a real header rather than from a fixture.
//
// The pixels are noise, from a fixed seed so the size is reproducible: a solid
// image compresses to almost nothing, which makes it impossible to write one
// big enough to be refused.
func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()

	rng := rand.New(rand.NewPCG(1, 2))
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	for x := range width {
		for y := range height {
			img.Set(x, y, color.RGBA{
				R: uint8(rng.UintN(256)),
				G: uint8(rng.UintN(256)),
				B: uint8(rng.UintN(256)),
				A: 255,
			})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func writeFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()

	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path
}

// viewImageEvent is the event Codex emits for a view_image call, with the path
// in the file URI form it was observed sending.
func viewImageEvent(t *testing.T, callID, path string) json.RawMessage {
	t.Helper()

	// A URI path is rooted with a slash, which an absolute path already carries
	// everywhere but Windows, where the drive letter comes first.
	uri := url.URL{Scheme: "file", Path: "/" + strings.TrimPrefix(filepath.ToSlash(path), "/")}
	raw, err := json.Marshal(map[string]string{
		"type":    "view_image_tool_call",
		"call_id": callID,
		"path":    uri.String(),
	})
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	return raw
}

// fileBlockOf asserts the pair of events a view_image call produces and returns
// the file the result describes.
func fileBlockOf(t *testing.T, events []agent.AgentEvent, wantPath string) *agent.FileBlock {
	t.Helper()

	if len(events) != 2 {
		t.Fatalf("expected a tool call and its result, got %d events: %+v", len(events), events)
	}

	call, ok := events[0].(agent.ToolCallEvent)
	if !ok {
		t.Fatalf("expected a ToolCallEvent, got %T", events[0])
	}
	if call.ToolName != "Read" {
		t.Errorf("expected the call to be named Read, got %q", call.ToolName)
	}
	var input struct {
		FilePath string `json:"file_path"`
	}
	if err := json.Unmarshal(call.ToolInput, &input); err != nil {
		t.Fatalf("tool input did not decode: %v", err)
	}
	if input.FilePath != wantPath {
		t.Errorf("expected file_path %q, got %q", wantPath, input.FilePath)
	}

	result, ok := events[1].(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("expected a ToolResultEvent, got %T", events[1])
	}
	if call.ToolUseID == "" || result.ToolUseID != call.ToolUseID {
		t.Errorf("expected the result to carry the call's id %q, got %q", call.ToolUseID, result.ToolUseID)
	}
	if len(result.Contents) != 1 || result.Contents[0].Type != agent.ContentBlockFile {
		t.Fatalf("expected one file block, got %+v", result.Contents)
	}
	file := result.Contents[0].File
	if file == nil {
		t.Fatal("expected the file block to describe a file")
	}
	return file
}

func TestViewImage_StoresTheImageAndReferencesItById(t *testing.T) {
	dataDir := t.TempDir()
	sess := newTestSession()
	sess.attachments = attachments.NewStore(dataDir, "session-1")

	data := pngBytes(t, 40, 20)
	// Outside any work directory, which is where Codex puts an image it
	// downloaded and the case a path-based fetch could not serve.
	path := writeFile(t, t.TempDir(), "shot.png", data)

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.AttachmentID == "" {
		t.Fatal("expected the image to be stored and named by id")
	}
	if file.Omitted != "" {
		t.Errorf("expected no omission, got %q", file.Omitted)
	}
	if file.Name != "shot.png" || file.Path != path {
		t.Errorf("expected the file to name itself, got name=%q path=%q", file.Name, file.Path)
	}
	if file.MIME != "image/png" {
		t.Errorf("expected image/png, got %q", file.MIME)
	}
	if file.Size != int64(len(data)) {
		t.Errorf("expected size %d, got %d", len(data), file.Size)
	}
	if file.Width != 40 || file.Height != 20 {
		t.Errorf("expected 40x20, got %dx%d", file.Width, file.Height)
	}

	// The point of storing it: the client reads the copy, so the image survives
	// the original being deleted and is reachable without a path at all.
	if err := os.Remove(path); err != nil {
		t.Fatalf("remove source: %v", err)
	}
	stored, err := os.ReadFile(filepath.Join(attachments.Dir(dataDir, "session-1"), file.AttachmentID))
	if err != nil {
		t.Fatalf("read stored attachment: %v", err)
	}
	if !bytes.Equal(stored, data) {
		t.Error("expected the stored attachment to be the image byte for byte")
	}
}

func TestViewImage_MissingFileIsReportedNotDropped(t *testing.T) {
	sess := newTestSession()
	sess.attachments = attachments.NewStore(t.TempDir(), "session-1")

	// Deleted between the tool call and the event, the case the user is most
	// likely to hit with a screenshot written into a temp directory.
	path := filepath.Join(t.TempDir(), "gone.png")

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected the content to be reported unavailable, got %q", file.Omitted)
	}
	if file.AttachmentID != "" {
		t.Error("expected no attachment id for content that could not be read")
	}
}

func TestViewImage_DirectoryIsReportedUnavailable(t *testing.T) {
	sess := newTestSession()
	sess.attachments = attachments.NewStore(t.TempDir(), "session-1")

	dir := t.TempDir()

	sess.processCodexMsg(viewImageEvent(t, "exec-1", dir), nil)
	file := fileBlockOf(t, drainEvents(sess.events), dir)

	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected a directory to be reported unavailable, got %q", file.Omitted)
	}
}

func TestViewImage_NamedPipeIsRefusedInsteadOfBlockingTheSession(t *testing.T) {
	dir := t.TempDir()
	fifotest.Make(t, dir, "pipe")

	sess := newTestSession()
	sess.attachments = attachments.NewStore(t.TempDir(), "session-1")
	path := filepath.Join(dir, "pipe")

	// Opening a fifo blocks until something writes to it, and this runs on the
	// goroutine that reads Codex's output: a blocked open would stop the session
	// reporting anything for the rest of its life, so the refusal has to happen
	// before the open.
	done := make(chan struct{})
	go func() {
		defer close(done)
		sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("reading the image blocked on the fifo")
	}

	file := fileBlockOf(t, drainEvents(sess.events), path)
	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected a fifo to be reported unavailable, got %q", file.Omitted)
	}
}

// An SVG's bytes say nothing about what they are — nor do AVIF's, HEIC's or
// TIFF's — so the extension travels with the id. Stored under a bare hash they
// would come back as plain text or as an unnamed binary, and an image that was
// kept perfectly well could never be drawn.
func TestViewImage_KeepsTheExtensionThatNamesTheContent(t *testing.T) {
	dataDir := t.TempDir()
	sess := newTestSession()
	sess.attachments = attachments.NewStore(dataDir, "session-1")

	data := []byte(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`)
	path := writeFile(t, t.TempDir(), "diagram.svg", data)

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.MIME != "image/svg+xml" {
		t.Errorf("expected image/svg+xml, got %q", file.MIME)
	}
	if !strings.HasSuffix(file.AttachmentID, ".svg") {
		t.Errorf("expected the id to carry the extension, got %q", file.AttachmentID)
	}
	// What the read side will make of it, which is the whole reason for the
	// extension: named from the id alone, it is the image again.
	stored, err := contents.GetContents(attachments.Dir(dataDir, "session-1"), file.AttachmentID)
	if err != nil {
		t.Fatalf("read it back: %v", err)
	}
	if stored.File == nil || stored.File.MIME != "image/svg+xml" {
		t.Errorf("expected it to read back as an svg, got %+v", stored.File)
	}
}

func TestViewImage_NonImageIsDescribedButNotStored(t *testing.T) {
	dataDir := t.TempDir()
	sess := newTestSession()
	sess.attachments = attachments.NewStore(dataDir, "session-1")

	// The event says Codex viewed an image; the file at the path it named is
	// not one. Copying it into the session's directory on the strength of that
	// assertion would make a chat event a way to take a copy of any file the
	// server can read, for content the UI would not draw in any case.
	data := []byte("root:x:0:0:root:/root:/bin/sh\n")
	path := writeFile(t, t.TempDir(), "passwd", data)

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.Omitted != contents.OmitBinary {
		t.Errorf("expected a non-image to be omitted as binary, got %q", file.Omitted)
	}
	if file.AttachmentID != "" {
		t.Error("expected a non-image not to be stored")
	}
	if entries, err := os.ReadDir(attachments.Dir(dataDir, "session-1")); err == nil && len(entries) > 0 {
		t.Errorf("expected nothing written to the attachment store, found %d entries", len(entries))
	}
	// Still described, so the strip says what it is declining rather than
	// showing an entry with nothing on it.
	if file.Size != int64(len(data)) {
		t.Errorf("expected the file to still be described, got size=%d", file.Size)
	}
}

func TestViewImage_OversizedImageIsDescribedButNotStored(t *testing.T) {
	dataDir := t.TempDir()
	sess := newTestSession()
	sess.attachments = attachments.NewStore(dataDir, "session-1")

	// Over the ceiling one JSON-RPC message may carry, so the client could not
	// be sent it however it was stored.
	data := pngBytes(t, 900, 900)
	if int64(len(data)) <= contents.MaxFileSize {
		t.Fatalf("test image is only %d bytes, under the %d limit", len(data), contents.MaxFileSize)
	}
	path := writeFile(t, t.TempDir(), "huge.png", data)

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.Omitted != contents.OmitTooLarge || file.Limit != contents.MaxFileSize {
		t.Errorf("expected too_large with the limit, got %q limit=%d", file.Omitted, file.Limit)
	}
	if file.AttachmentID != "" {
		t.Error("expected content over the limit not to be stored")
	}
	// Still described well enough for the UI to say what it is refusing.
	if file.MIME != "image/png" || file.Size != int64(len(data)) {
		t.Errorf("expected the file to still be described, got mime=%q size=%d", file.MIME, file.Size)
	}
	if file.Width != 900 || file.Height != 900 {
		t.Errorf("expected 900x900, got %dx%d", file.Width, file.Height)
	}

	if entries, err := os.ReadDir(attachments.Dir(dataDir, "session-1")); err == nil && len(entries) > 0 {
		t.Errorf("expected nothing stored, found %d entries", len(entries))
	}
}

func TestViewImage_StoreFailureIsReportedNotDropped(t *testing.T) {
	// A session with no data directory has nowhere to keep attachments — an
	// anonymous session, or one whose store could not be created.
	sess := newTestSession()

	path := writeFile(t, t.TempDir(), "shot.png", pngBytes(t, 4, 4))

	sess.processCodexMsg(viewImageEvent(t, "exec-1", path), nil)
	file := fileBlockOf(t, drainEvents(sess.events), path)

	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected content that could not be kept to be reported unavailable, got %q", file.Omitted)
	}
	if file.AttachmentID != "" {
		t.Error("expected no attachment id when nothing was stored")
	}
}

func TestViewImage_UnusableCodexPathIsStillReported(t *testing.T) {
	sess := newTestSession()
	sess.attachments = attachments.NewStore(t.TempDir(), "session-1")

	// A URI naming another machine: nothing here can open it, but the turn did
	// look at an image and the transcript has to say so.
	const raw = "file://fileserver/share/shot.png"
	sess.processCodexMsg(json.RawMessage(
		`{"type":"view_image_tool_call","call_id":"exec-1","path":"`+raw+`"}`), nil)

	file := fileBlockOf(t, drainEvents(sess.events), raw)

	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected the content to be reported unavailable, got %q", file.Omitted)
	}
	if file.Path != raw {
		t.Errorf("expected the path Codex named to be shown as it is, got %q", file.Path)
	}
}

func TestViewImage_UnparseableEventEmitsNothing(t *testing.T) {
	sess := newTestSession()

	// An event that does not decode says nothing about what was viewed, not even
	// which call it belongs to, so there is nothing to report against.
	sess.processCodexMsg(json.RawMessage(`{"type":"view_image_tool_call","path":[]}`), nil)

	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("expected no events for an event that did not decode, got %+v", events)
	}
}

func TestLocalPath(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		// want is written as a POSIX path and converted, which is the identity
		// everywhere but Windows.
		want string
	}{
		{
			name: "file URI is the form Codex was observed sending",
			raw:  "file:///tmp/imgprobe/test.png",
			want: "/tmp/imgprobe/test.png",
		},
		{
			// A path is percent-encoded on the way into a URI, and a space in a
			// file name is common enough to reach this every day.
			name: "percent encoding is undone",
			raw:  "file:///tmp/my%20shot.png",
			want: "/tmp/my shot.png",
		},
		{
			name: "localhost names this machine",
			raw:  "file://localhost/tmp/shot.png",
			want: "/tmp/shot.png",
		},
		{
			name: "another host is not a file here",
			raw:  "file://fileserver/share/shot.png",
			want: "",
		},
		{
			name: "a plain path is already what we need",
			raw:  "/tmp/shot.png",
			want: "/tmp/shot.png",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			want := filepath.FromSlash(tt.want)
			if got := localPath(tt.raw); got != want {
				t.Errorf("localPath(%q) = %q, want %q", tt.raw, got, want)
			}
		})
	}
}
