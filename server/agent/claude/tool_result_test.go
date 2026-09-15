package claude

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/attachments"
	"github.com/pockode/server/contents"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// pngBytes is a real PNG, because the parser reads the dimensions out of the
// header: a placeholder string would exercise everything except that.
func pngBytes(t *testing.T, width, height int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

func testStore(t *testing.T) (attachments.Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	return attachments.NewStore(dataDir, "sess-1"), attachments.Dir(dataDir, "sess-1")
}

// toolResultLine wraps a content array the way the CLI delivers it, so the
// tests go through the same decode path streamOutput uses.
func toolResultLine(content string) []byte {
	return fmt.Appendf(nil,
		`{"type":"user","uuid":"msg-1","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":%s}]}}`,
		content)
}

func parseToolResultLine(t *testing.T, store attachments.Store, content string) agent.ToolResultEvent {
	t.Helper()
	var event cliEvent
	if err := json.Unmarshal(toolResultLine(content), &event); err != nil {
		t.Fatalf("decode line: %v", err)
	}
	events := parseUserEvent(discardLogger(), event, store)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d: %#v", len(events), events)
	}
	result, ok := events[0].(agent.ToolResultEvent)
	if !ok {
		t.Fatalf("expected a tool result, got %#v", events[0])
	}
	return result
}

func TestParseToolResultImage(t *testing.T) {
	store, dir := testStore(t)
	data := pngBytes(t, 64, 32)
	content := fmt.Sprintf(`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}}]`,
		base64.StdEncoding.EncodeToString(data))

	result := parseToolResultLine(t, store, content)

	// The event has to say which call it belongs to, or the UI has nowhere to
	// put it.
	if result.ToolUseID != "toolu_1" || result.ProviderMessageID != "msg-1" {
		t.Errorf("lost the identifiers: %+v", result)
	}
	if result.ToolResult != "" {
		t.Errorf("expected the text field to stay empty, got %q", result.ToolResult)
	}
	if len(result.Contents) != 1 || result.Contents[0].Type != agent.ContentBlockFile {
		t.Fatalf("expected one file block, got %#v", result.Contents)
	}

	file := result.Contents[0].File
	if file.MIME != "image/png" || file.Size != int64(len(data)) {
		t.Errorf("unexpected descriptor: %+v", file)
	}
	if file.Width != 64 || file.Height != 32 {
		t.Errorf("expected 64x32, got %dx%d", file.Width, file.Height)
	}
	if file.Omitted != "" {
		t.Errorf("expected content to be kept, got omitted=%q", file.Omitted)
	}

	stored, err := os.ReadFile(filepath.Join(dir, file.AttachmentID))
	if err != nil {
		t.Fatalf("read stored attachment: %v", err)
	}
	if !bytes.Equal(stored, data) {
		t.Errorf("stored bytes differ from the delivered ones")
	}
}

// The whole point of the attachment store: what goes into history must not
// carry the image with it.
func TestParseToolResultKeepsImageOutOfTheRecord(t *testing.T) {
	store, _ := testStore(t)
	data := pngBytes(t, 40, 40)
	encoded := base64.StdEncoding.EncodeToString(data)
	content := fmt.Sprintf(`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}}]`, encoded)

	record, err := json.Marshal(parseToolResultLine(t, store, content).ToRecord())
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if bytes.Contains(record, []byte(encoded[:64])) {
		t.Error("the record still carries the image content")
	}
	if len(record) > 512 {
		t.Errorf("record is %d bytes, expected a reference-sized one", len(record))
	}
}

// An MCP tool answering with prose and a screenshot used to lose the prose,
// the audio notice, the resource text — everything but a warning naming none
// of it.
func TestParseToolResultMixedBlocks(t *testing.T) {
	store, _ := testStore(t)
	data := pngBytes(t, 8, 8)
	content := fmt.Sprintf(`[
		{"type":"text","text":"here are the blocks"},
		{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}},
		{"type":"text","text":"[Audio from probe] Binary content (audio/wav, 15 bytes) saved to ~/.claude"}
	]`, base64.StdEncoding.EncodeToString(data))

	result := parseToolResultLine(t, store, content)

	if len(result.Contents) != 3 {
		t.Fatalf("expected 3 blocks, got %#v", result.Contents)
	}
	if result.Contents[0].Text != "here are the blocks" {
		t.Errorf("lost the leading text: %#v", result.Contents[0])
	}
	if result.Contents[1].Type != agent.ContentBlockFile || result.Contents[1].File.AttachmentID == "" {
		t.Errorf("expected the image in the middle: %#v", result.Contents[1])
	}
	if result.Contents[2].Type != agent.ContentBlockText {
		t.Errorf("lost the trailing text: %#v", result.Contents[2])
	}
}

// A PDF read: a line of text and the document itself.
func TestParseToolResultDocument(t *testing.T) {
	store, _ := testStore(t)
	pdf := []byte("%PDF-1.4 fake")
	content := fmt.Sprintf(`[{"type":"text","text":"PDF file read: /tmp/a.pdf (13 bytes)"},{"type":"document","source":{"type":"base64","media_type":"application/pdf","data":%q}}]`,
		base64.StdEncoding.EncodeToString(pdf))

	result := parseToolResultLine(t, store, content)

	if len(result.Contents) != 2 {
		t.Fatalf("expected 2 blocks, got %#v", result.Contents)
	}
	file := result.Contents[1].File
	if file == nil || file.MIME != "application/pdf" || file.Size != int64(len(pdf)) {
		t.Fatalf("unexpected document block: %#v", result.Contents[1])
	}
	// Not rendered, so not kept — and the text block beside it names the file.
	if file.Omitted != contents.OmitBinary || file.AttachmentID != "" {
		t.Errorf("expected the document content to be omitted, got %+v", file)
	}
}

func TestParseToolResultOversizedImage(t *testing.T) {
	store, dir := testStore(t)
	data := make([]byte, contents.MaxFileSize+1)
	copy(data, pngBytes(t, 4, 4))
	content := fmt.Sprintf(`[{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}}]`,
		base64.StdEncoding.EncodeToString(data))

	file := parseToolResultLine(t, store, content).Contents[0].File
	if file.Omitted != contents.OmitTooLarge || file.Limit != contents.MaxFileSize {
		t.Errorf("expected a too_large verdict, got %+v", file)
	}
	if file.AttachmentID != "" {
		t.Error("stored content it cannot serve back")
	}
	if entries, err := os.ReadDir(dir); err == nil && len(entries) > 0 {
		t.Errorf("expected nothing written, found %d files", len(entries))
	}
}

// A session with nowhere to store anything (the zero store) must still report
// the image it cannot keep, rather than dropping the result.
func TestParseToolResultWithoutAStore(t *testing.T) {
	data := pngBytes(t, 4, 4)
	content := fmt.Sprintf(`[{"type":"text","text":"before"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":%q}}]`,
		base64.StdEncoding.EncodeToString(data))

	result := parseToolResultLine(t, attachments.Store{}, content)

	if len(result.Contents) != 2 {
		t.Fatalf("expected the text to survive alongside the image, got %#v", result.Contents)
	}
	file := result.Contents[1].File
	if file.Omitted != contents.OmitUnavailable || file.AttachmentID != "" {
		t.Errorf("expected an unavailable verdict, got %+v", file)
	}
	if file.MIME != "image/png" || file.Width != 4 {
		t.Errorf("expected the descriptor to survive, got %+v", file)
	}
}

func TestParseToolResultUndecodableImage(t *testing.T) {
	store, _ := testStore(t)
	content := `[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"not base64 at all!!"}}]`

	file := parseToolResultLine(t, store, content).Contents[0].File
	if file.Omitted != contents.OmitUnavailable {
		t.Errorf("expected an unavailable verdict, got %+v", file)
	}
}

// ToolSearch's answer used to reach the transcript as raw JSON.
func TestParseToolResultToolReference(t *testing.T) {
	store, _ := testStore(t)
	content := `[{"type":"tool_reference","tool_name":"mcp__pockode__work_get"},{"type":"tool_reference","tool_name":"mcp__pockode__work_list"}]`

	result := parseToolResultLine(t, store, content)

	if result.ToolResult != "" {
		t.Errorf("expected the text field to stay empty, got %q", result.ToolResult)
	}
	if len(result.Contents) != 2 {
		t.Fatalf("expected 2 blocks, got %#v", result.Contents)
	}
	for i, want := range []string{"mcp__pockode__work_get", "mcp__pockode__work_list"} {
		block := result.Contents[i]
		if block.Type != agent.ContentBlockToolReference || block.ToolName != want {
			t.Errorf("block %d: got %#v, want a reference to %q", i, block, want)
		}
	}
}

// A reference with no name left in it has nothing readable to show, so its raw
// JSON stays visible rather than becoming an empty chip.
func TestParseToolResultNamelessToolReference(t *testing.T) {
	store, _ := testStore(t)
	content := `[{"type":"tool_reference"}]`

	result := parseToolResultLine(t, store, content)
	if result.Contents != nil {
		t.Fatalf("expected nothing to render as blocks, got %#v", result.Contents)
	}
	if result.ToolResult != `{"type":"tool_reference"}` {
		t.Errorf("lost the raw block: %q", result.ToolResult)
	}
}

// Content is addressed by its hash, so a re-read costs one file.
func TestAttachmentStoreDeduplicates(t *testing.T) {
	store, dir := testStore(t)
	data := pngBytes(t, 16, 16)

	first, err := store.Put(data, "")
	if err != nil {
		t.Fatalf("put: %v", err)
	}
	second, err := store.Put(data, "")
	if err != nil {
		t.Fatalf("put again: %v", err)
	}
	if first != second {
		t.Errorf("same content got two ids: %q and %q", first, second)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir: %v", err)
	}
	// The lock filestore's atomic write leaves behind is not an attachment.
	stored := 0
	for _, entry := range entries {
		if filepath.Ext(entry.Name()) != ".lock" {
			stored++
		}
	}
	if stored != 1 {
		t.Errorf("expected 1 file, found %d", stored)
	}
}

func TestAttachmentStoreDisabled(t *testing.T) {
	if _, err := (attachments.Store{}).Put([]byte("x"), ""); err == nil {
		t.Error("expected a disabled store to refuse")
	}
	if store := attachments.NewStore("", "sess"); store != (attachments.Store{}) {
		t.Error("expected no data dir to disable the store")
	}
}

// The CLI's block type is what says this is an image, so an image block whose
// media type went missing must still be stored rather than written off as
// unshowable binary.
func TestParseToolResultImageWithoutAMediaType(t *testing.T) {
	store, _ := testStore(t)
	content := fmt.Sprintf(`[{"type":"image","source":{"type":"base64","data":%q}}]`,
		base64.StdEncoding.EncodeToString(pngBytes(t, 12, 6)))

	file := parseToolResultLine(t, store, content).Contents[0].File
	if file.AttachmentID == "" || file.Omitted != "" {
		t.Errorf("expected the image to be stored, got %+v", file)
	}
	if file.Width != 12 || file.Height != 6 {
		t.Errorf("expected 12x6, got %dx%d", file.Width, file.Height)
	}
}
