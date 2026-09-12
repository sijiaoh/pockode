package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A crash while rewriting index.json used to leave truncated JSON that made
// every session unreachable.
func TestFileStore_CorruptIndex_StartsEmptyAndKeepsBackup(t *testing.T) {
	dir := t.TempDir()
	indexPath := filepath.Join(dir, "sessions", "index.json")
	if err := os.MkdirAll(filepath.Dir(indexPath), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	truncated := `{"sessions":[{"id":"s1","title":"Half writ`
	if err := os.WriteFile(indexPath, []byte(truncated), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore should recover from a corrupt index, got: %v", err)
	}

	sessions, err := store.List()
	if err != nil {
		t.Fatalf("List failed: %v", err)
	}
	if len(sessions) != 0 {
		t.Errorf("expected an empty session list, got %d", len(sessions))
	}

	backup, err := os.ReadFile(indexPath + ".corrupt")
	if err != nil {
		t.Fatalf("expected the corrupt index to be kept for recovery: %v", err)
	}
	if string(backup) != truncated {
		t.Errorf("expected backup to keep the original bytes, got %q", backup)
	}

	// The store must be usable afterwards.
	if _, err := store.Create(ctx, "s2", "", ""); err != nil {
		t.Fatalf("Create after recovery failed: %v", err)
	}
	reopened, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if sessions, _ := reopened.List(); len(sessions) != 1 {
		t.Errorf("expected 1 session after recovery, got %d", len(sessions))
	}
}

// A crash mid-append leaves half a JSONL line; the rest of the conversation
// must still load, with the loss reported to the user.
func TestFileStore_GetHistory_PartialLine(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	sessionID := "crashed-session"
	if _, err := store.Create(ctx, sessionID, "", ""); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.AppendToHistory(ctx, sessionID, map[string]string{"type": "text", "content": "hello"}); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}

	historyPath := filepath.Join(dir, "sessions", sessionID, "history.jsonl")
	appendRaw(t, historyPath, `{"type":"text","con`)

	// Appending after the crash must keep the new record readable.
	if _, err := store.AppendToHistory(ctx, sessionID, map[string]string{"type": "text", "content": "world"}); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}

	records, err := store.GetHistory(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(records) != 3 {
		t.Fatalf("expected 2 records plus a warning, got %d: %v", len(records), records)
	}
	if !strings.Contains(string(records[1]), `"world"`) {
		t.Errorf("expected the post-crash record to be intact, got %s", records[1])
	}

	var warning struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(records[2], &warning); err != nil {
		t.Fatalf("unmarshal warning: %v", err)
	}
	if warning.Type != "warning" || warning.Code != "history_corrupted" {
		t.Errorf("expected a history_corrupted warning, got %+v", warning)
	}
}

func appendRaw(t *testing.T, path, content string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	if _, err := f.WriteString(content); err != nil {
		t.Fatalf("write: %v", err)
	}
}

// TestFileStore_DamagedHistory_KeepsSeqsUnique: the warning GetHistory adds for
// unreadable records is not in the file, so it must not take an address a real
// record can also get. Numbered by position it would collide with the next
// append, and a client anchoring on it would name a record it never saw.
func TestFileStore_DamagedHistory_KeepsSeqsUnique(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	sessionID := "damaged-session"
	if _, err := store.Create(ctx, sessionID, "", ""); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.AppendToHistory(ctx, sessionID, map[string]string{"type": "text", "content": "kept"}); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	appendRaw(t, filepath.Join(dir, "sessions", sessionID, "history.jsonl"), `{"type":"text","con`)

	seq, err := store.AppendToHistory(ctx, sessionID, map[string]string{"type": "text", "content": "after the damage"})
	if err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}

	records, err := store.GetHistory(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	page, err := PageHistory(records, NoHistorySeq, DefaultHistoryPageSize)
	if err != nil {
		t.Fatalf("PageHistory failed: %v", err)
	}
	stamped := page.Records

	// Two readable records plus the warning.
	if len(stamped) != 3 {
		t.Fatalf("got %d records, want 3: %s", len(stamped), stamped)
	}

	var seqs []HistorySeq
	for i, raw := range stamped {
		var rec struct {
			Type string     `json:"type"`
			Seq  HistorySeq `json:"seq"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatalf("record %d does not parse: %v", i, err)
		}
		if rec.Seq.Valid() {
			seqs = append(seqs, rec.Seq)
		}
	}

	if len(seqs) != 2 {
		t.Fatalf("%d records are addressable, want the 2 real ones: %s", len(seqs), stamped)
	}
	if seqs[0] == seqs[1] {
		t.Errorf("two records share seq %d", seqs[0])
	}
	if seqs[1] != seq {
		t.Errorf("the appended record reads back as seq %d, was handed %d", seqs[1], seq)
	}
}
