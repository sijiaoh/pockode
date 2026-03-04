package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestClearOrphanedNeedsInput(t *testing.T) {
	dataDir := t.TempDir()

	// Setup main sessions with NeedsInput=true
	mainIdx := indexData{Sessions: []SessionMeta{
		{ID: "s1", NeedsInput: true},
		{ID: "s2", NeedsInput: false},
		{ID: "s3", NeedsInput: true},
	}}
	writeIndex(t, filepath.Join(dataDir, "sessions", "index.json"), mainIdx)

	// Setup worktree sessions
	wtIdx := indexData{Sessions: []SessionMeta{
		{ID: "wt-s1", NeedsInput: true},
	}}
	writeIndex(t, filepath.Join(dataDir, "worktrees", "feature-x", "sessions", "index.json"), wtIdx)

	ClearOrphanedNeedsInput(dataDir)

	// Verify main sessions
	main := readIndex(t, filepath.Join(dataDir, "sessions", "index.json"))
	for _, s := range main.Sessions {
		if s.NeedsInput {
			t.Errorf("main session %s: expected NeedsInput=false", s.ID)
		}
	}
	if len(main.Sessions) != 3 {
		t.Errorf("expected 3 sessions, got %d", len(main.Sessions))
	}

	// Verify worktree sessions
	wt := readIndex(t, filepath.Join(dataDir, "worktrees", "feature-x", "sessions", "index.json"))
	if wt.Sessions[0].NeedsInput {
		t.Error("worktree session wt-s1: expected NeedsInput=false")
	}
}

func TestClearOrphanedNeedsInput_NoChange(t *testing.T) {
	dataDir := t.TempDir()

	idx := indexData{Sessions: []SessionMeta{
		{ID: "s1", NeedsInput: false},
	}}
	path := filepath.Join(dataDir, "sessions", "index.json")
	writeIndex(t, path, idx)

	info, _ := os.Stat(path)
	modBefore := info.ModTime()

	ClearOrphanedNeedsInput(dataDir)

	info, _ = os.Stat(path)
	if !info.ModTime().Equal(modBefore) {
		t.Error("file should not be rewritten when no NeedsInput flags are set")
	}
}

func TestClearOrphanedNeedsInput_NoDataDir(t *testing.T) {
	// Should not panic on non-existent directory
	ClearOrphanedNeedsInput("/nonexistent/path")
}

func writeIndex(t *testing.T, path string, idx indexData) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readIndex(t *testing.T, path string) indexData {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return idx
}
