package filestore

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type jsonlRecord struct {
	N int `json:"n"`
}

func TestAppendJSONL_RoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "history.jsonl")

	for i := 0; i < 3; i++ {
		if err := AppendJSONL(path, jsonlRecord{N: i}); err != nil {
			t.Fatalf("AppendJSONL failed: %v", err)
		}
	}

	records, stats, err := ReadJSONL(path, 0)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if stats.Damaged() {
		t.Errorf("expected undamaged file, got %+v", stats)
	}
	if len(records) != 3 {
		t.Fatalf("expected 3 records, got %d", len(records))
	}
	if string(records[2]) != `{"n":2}` {
		t.Errorf("unexpected record: %s", records[2])
	}
}

func TestReadJSONL_MissingFile(t *testing.T) {
	records, stats, err := ReadJSONL(filepath.Join(t.TempDir(), "absent.jsonl"), 0)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if len(records) != 0 || stats.Damaged() {
		t.Errorf("expected no records and no damage, got %d records, %+v", len(records), stats)
	}
}

// A crash mid-append leaves a partial line: the rest of the file must still load.
func TestReadJSONL_SkipsTruncatedTail(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	writeRaw(t, path, `{"n":0}`+"\n"+`{"n":1}`+"\n"+`{"n":2`)

	records, stats, err := ReadJSONL(path, 0)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 intact records, got %d", len(records))
	}
	if stats.Corrupted != 1 {
		t.Errorf("expected 1 corrupted record, got %+v", stats)
	}
}

// Appending after a crash must not glue the new record onto the broken line.
func TestAppendJSONL_TerminatesPartialLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	writeRaw(t, path, `{"n":0}`+"\n"+`{"n":1`)

	if err := AppendJSONL(path, jsonlRecord{N: 2}); err != nil {
		t.Fatalf("AppendJSONL failed: %v", err)
	}

	records, stats, err := ReadJSONL(path, 0)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if stats.Corrupted != 1 {
		t.Errorf("expected damage limited to 1 record, got %+v", stats)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 readable records, got %d: %v", len(records), records)
	}
	if string(records[1]) != `{"n":2}` {
		t.Errorf("expected the new record to be intact, got %s", records[1])
	}
}

// An oversized line is skipped rather than aborting the scan, so later records
// still load.
func TestReadJSONL_SkipsOversizedLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")
	huge := fmt.Sprintf(`{"text":%q}`, strings.Repeat("x", 512))
	writeRaw(t, path, `{"n":0}`+"\n"+huge+"\n"+`{"n":2}`+"\n")

	records, stats, err := ReadJSONL(path, 64)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if stats.Oversized != 1 || stats.Corrupted != 0 {
		t.Errorf("expected exactly 1 oversized record, got %+v", stats)
	}
	if len(records) != 2 {
		t.Fatalf("expected 2 records around the oversized one, got %d", len(records))
	}
	if string(records[1]) != `{"n":2}` {
		t.Errorf("expected scanning to resume after the oversized line, got %s", records[1])
	}
}

func TestAppendJSONL_ConcurrentAppendsStayIntact(t *testing.T) {
	path := filepath.Join(t.TempDir(), "history.jsonl")

	const writers, perWriter = 4, 10
	var wg sync.WaitGroup
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				if err := AppendJSONL(path, jsonlRecord{N: w*perWriter + i}); err != nil {
					t.Errorf("AppendJSONL failed: %v", err)
					return
				}
			}
		}(w)
	}
	wg.Wait()

	records, stats, err := ReadJSONL(path, 0)
	if err != nil {
		t.Fatalf("ReadJSONL failed: %v", err)
	}
	if stats.Damaged() {
		t.Errorf("expected no interleaved records, got %+v", stats)
	}
	if len(records) != writers*perWriter {
		t.Errorf("expected %d records, got %d", writers*perWriter, len(records))
	}
}

func writeRaw(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
}
