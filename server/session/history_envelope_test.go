package session

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// writeHistoryFile puts lines on disk as some earlier writer left them.
func writeHistoryFile(t *testing.T, dataDir, sessionID string, lines ...string) string {
	t.Helper()
	path := historyPath(dataDir, sessionID)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func newStoreWithSession(t *testing.T, sessionID string) (*FileStore, string) {
	t.Helper()
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, sessionID, CreateSpec{AgentType: AgentTypeClaude, Mode: ModeDefault}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	return store, dir
}

// pageSeqs is the seq of each record of the whole history, NoHistorySeq for
// one in no file: what every seq a client is handed names.
func pageSeqs(t *testing.T, reader Reader, sessionID string) []HistorySeq {
	t.Helper()
	records, err := reader.GetHistory(ctx, sessionID)
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	return HistorySeqs(records)
}

// A file written before seqs were stored is numbered exactly as positions
// numbered it — damaged lines skipped and the warning still shown — so every
// seq a client already holds names the record it named before the upgrade.
// Reading it rewrites nothing, through the store or without one.
func TestHistory_OldFileKeepsItsPositionalNumbering(t *testing.T) {
	store, dir := newStoreWithSession(t, "old")
	path := writeHistoryFile(t, dir, "old",
		`{"type":"message","content":"one"}`,
		`{"type":"text","content":"tw`, // cut off by a crash
		`{"type":"text","content":"three"}`,
		`{"type":"done"}`,
	)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}

	want := []HistorySeq{1, 2, 3, NoHistorySeq}
	for name, reader := range map[string]Reader{"store": store, "dir reader": NewDirReader(dir)} {
		if got := pageSeqs(t, reader, "old"); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: seqs = %v, want %v (damaged line unnumbered, warning last)", name, got, want)
		}
	}

	records, _ := store.GetHistory(ctx, "old")
	var warning struct {
		Type string `json:"type"`
		Code string `json:"code"`
	}
	if err := json.Unmarshal(records[len(records)-1], &warning); err != nil || warning.Code != "history_corrupted" {
		t.Errorf("last record = %s, want the skipped-entries warning", records[len(records)-1])
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Errorf("reading rewrote the file:\n%s", after)
	}
}

// New records appended to an old file go on from the old numbering, and so do
// records a downgraded server appended after new ones: one numbering across
// every format the file holds, the same after a restart.
func TestHistory_MixedFileNumbersOnFromTheOldRecords(t *testing.T) {
	store, dir := newStoreWithSession(t, "mixed")
	path := writeHistoryFile(t, dir, "mixed",
		`{"type":"message","content":"one"}`,
		`{"type":"text","content":"two"}`,
	)

	seq, err := store.AppendToHistory(ctx, "mixed", testRecord{"type": "text", "content": "three"}, HistoryTurn{})
	if err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	if seq != 3 {
		t.Fatalf("append to a two-record old file got seq %d, want 3", seq)
	}

	// A downgraded server appends flat records. Ending on its process's end
	// keeps the reopened store from closing out a run (see
	// abortTurnsTheLastRunLeftOpen), which would take a seq of its own.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(`{"type":"process_ended"}` + "\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()

	reopened, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	seq, err = reopened.AppendToHistory(ctx, "mixed", testRecord{"type": "text", "content": "five"}, HistoryTurn{})
	if err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	if seq != 5 {
		t.Errorf("append after a downgraded server's record got seq %d, want 5", seq)
	}

	if got, want := pageSeqs(t, reopened, "mixed"), []HistorySeq{1, 2, 3, 4, 5}; !reflect.DeepEqual(got, want) {
		t.Errorf("seqs = %v, want %v", got, want)
	}

	data, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	if lines[0] != `{"type":"message","content":"one"}` {
		t.Errorf("old line rewritten: %s", lines[0])
	}
	if !strings.HasPrefix(lines[2], `{"seq":3,"v":3,`) {
		t.Errorf("new line = %s, want it to store its seq and format version", lines[2])
	}
}

// Stored seqs can have gaps — a power loss takes an unsynced tail the counter
// had already moved past — and paging, forking by seq and the next append all
// go by the stored numbers rather than by position.
func TestHistory_GapsInStoredSeqs(t *testing.T) {
	store, dir := newStoreWithSession(t, "gaps")
	writeHistoryFile(t, dir, "gaps",
		`{"seq":1,"v":2,"type":"message","content":"one"}`,
		`{"seq":2,"v":2,"type":"text","content":"two"}`,
		`{"seq":5,"v":2,"type":"text","content":"five"}`,
	)
	records, err := store.GetHistory(ctx, "gaps")
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}

	if got, want := pageSeqs(t, store, "gaps"), []HistorySeq{1, 2, 5}; !reflect.DeepEqual(got, want) {
		t.Errorf("seqs = %v, want %v", got, want)
	}

	if i, found := FindHistorySeq(records, 5); !found || i != 2 {
		t.Errorf("FindHistorySeq(5) = %d, %v; want index 2", i, found)
	}
	if _, found := FindHistorySeq(records, 3); found {
		t.Error("FindHistorySeq(3) found a record in the gap")
	}

	seq, err := store.AppendToHistory(ctx, "gaps", testRecord{"type": "text", "content": "six"}, HistoryTurn{})
	if err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	if seq != 6 {
		t.Errorf("append got seq %d, want 6 (after the newest stored seq, not the count)", seq)
	}
}

func TestHistorySeqs(t *testing.T) {
	tests := []struct {
		name  string
		lines []string
		want  []HistorySeq
	}{
		{
			name:  "a readable record that is not an object still takes its position",
			lines: []string{`{"type":"text"}`, `[1]`, `{"type":"text"}`},
			want:  []HistorySeq{1, 2, 3},
		},
		{
			name:  "a stored seq not past the one before is numbered as if absent",
			lines: []string{`{"seq":5,"v":2,"type":"text"}`, `{"seq":3,"v":2,"type":"text"}`, `{"seq":6,"v":2,"type":"text"}`},
			want:  []HistorySeq{5, 6, 7},
		},
		{
			name:  "a seq stored anywhere in the record counts",
			lines: []string{`{"content":"x","seq":4,"type":"text"}`, `{"type":"text"}`},
			want:  []HistorySeq{4, 5},
		},
		{
			name:  "the bytes seq inside a value are not a seq",
			lines: []string{`{"type":"text","content":"seq"}`, `{"type":"text","content":"{\"seq\":9}"}`},
			want:  []HistorySeq{1, 2},
		},
		{
			name:  "a record carrying seq 0 takes no number",
			lines: []string{`{"type":"text"}`, `{"type":"warning","seq":0}`, `{"type":"text"}`},
			want:  []HistorySeq{1, NoHistorySeq, 2},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records := make([]json.RawMessage, len(tt.lines))
			for i, line := range tt.lines {
				records[i] = json.RawMessage(line)
			}
			if got := HistorySeqs(records); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("HistorySeqs = %v, want %v", got, tt.want)
			}
		})
	}
}

// A fork's copy is a new session's history, and not a prefix of the source's
// (TruncateHistory drops dangling calls), so it is numbered from 1 — whatever
// seqs, and whatever format, the copied records arrived in.
func TestFileStore_WriteHistoryRenumbers(t *testing.T) {
	store, dir := newStoreWithSession(t, "fork")

	copied := []json.RawMessage{
		json.RawMessage(`{"seq":3,"v":2,"type":"message","content":"three"}`),
		json.RawMessage(`{"seq":7,"v":2,"type":"text","content":"seven"}`),
		json.RawMessage(`{"type":"text","content":"old format"}`),
		json.RawMessage(`{"content":"stamped by an old server","seq":9,"type":"text"}`),
	}
	if err := store.WriteHistory(ctx, "fork", copied); err != nil {
		t.Fatalf("WriteHistory failed: %v", err)
	}

	data, err := os.ReadFile(historyPath(dir, "fork"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{
		`{"seq":1,"v":3,"type":"message","content":"three"}`,
		`{"seq":2,"v":3,"type":"text","content":"seven"}`,
		`{"seq":3,"v":3,"type":"text","content":"old format"}`,
		`{"seq":4,"v":3,"content":"stamped by an old server","type":"text"}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("written lines:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}

	seq, err := store.AppendToHistory(ctx, "fork", testRecord{"type": "text"}, HistoryTurn{})
	if err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	if seq != 5 {
		t.Errorf("first append to the fork got seq %d, want 5", seq)
	}
}

// A line on disk is the record as it marshals plus the envelope and nothing
// else, so a downgraded server — which reads records by their own fields — and
// DirReader still read it. In particular the envelope brings no timestamp: a
// record carries observed_at only where it was honestly observed.
func TestAppendToHistory_LineIsTheRecordPlusTheEnvelope(t *testing.T) {
	store, dir := newStoreWithSession(t, "sess")
	record := testRecord{"type": "tool_call", "tool_use_id": "t1", "input": map[string]any{"seq": 1}}

	if _, err := store.AppendToHistory(ctx, "sess", record, HistoryTurn{}); err != nil {
		t.Fatalf("AppendToHistory failed: %v", err)
	}
	data, err := os.ReadFile(historyPath(dir, "sess"))
	if err != nil {
		t.Fatal(err)
	}

	var line map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(data), &line); err != nil {
		t.Fatalf("line does not parse: %v", err)
	}
	if line["seq"] != float64(1) || line["v"] != float64(historyFormatVersion) {
		t.Errorf("envelope = seq %v, v %v; want 1, %d", line["seq"], line["v"], historyFormatVersion)
	}
	delete(line, "seq")
	delete(line, "v")

	own, _ := record.MarshalJSON()
	var want map[string]any
	if err := json.Unmarshal(own, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(line, want) {
		t.Errorf("line without its envelope = %v, want the record's own fields %v", line, want)
	}
}

// The turn a record belongs to is the third envelope field, and has three
// values: a turn, none (null), or nothing said at all — a message, and every
// line from before turns had ids. A reader tells them apart without parsing the
// record, and a client is sent none of it.
func TestAppendToHistory_StoresTheTurnInTheEnvelope(t *testing.T) {
	store, dir := newStoreWithSession(t, "sess")
	for _, turn := range []HistoryTurn{InTurn("t-1"), NoTurn, {}} {
		if _, err := store.AppendToHistory(ctx, "sess", testRecord{"type": "text"}, turn); err != nil {
			t.Fatalf("AppendToHistory failed: %v", err)
		}
	}

	data, err := os.ReadFile(historyPath(dir, "sess"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{
		`{"seq":1,"v":3,"turn":"t-1","type":"text"}`,
		`{"seq":2,"v":3,"turn":null,"type":"text"}`,
		`{"seq":3,"v":3,"type":"text"}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Fatalf("written lines:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}

	records, err := store.GetHistory(ctx, "sess")
	if err != nil {
		t.Fatal(err)
	}
	wantTurns := []HistoryTurn{InTurn("t-1"), NoTurn, {}}
	for i, raw := range records {
		if got := HistoryTurnOf(raw); got != wantTurns[i] {
			t.Errorf("record %d turn = %+v, want %+v", i, got, wantTurns[i])
		}
	}
	if seqs := HistorySeqs(records); !reflect.DeepEqual(seqs, []HistorySeq{1, 2, 3}) {
		t.Errorf("seqs = %v, want the stored ones", seqs)
	}

}

// A fork's copy holds the same turns as the records it copied, so each keeps
// its tag through the renumbering — including saying it has none.
func TestFileStore_WriteHistoryKeepsEachRecordsTurn(t *testing.T) {
	store, dir := newStoreWithSession(t, "fork")
	copied := []json.RawMessage{
		json.RawMessage(`{"seq":4,"v":3,"type":"message","content":"go"}`),
		json.RawMessage(`{"seq":5,"v":3,"turn":"t-1","type":"turn_started","turn_id":"t-1","origin":"prompt"}`),
		json.RawMessage(`{"seq":6,"v":3,"turn":null,"type":"interrupted"}`),
	}
	if err := store.WriteHistory(ctx, "fork", copied); err != nil {
		t.Fatalf("WriteHistory failed: %v", err)
	}
	data, err := os.ReadFile(historyPath(dir, "fork"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	want := []string{
		`{"seq":1,"v":3,"type":"message","content":"go"}`,
		`{"seq":2,"v":3,"turn":"t-1","type":"turn_started","turn_id":"t-1","origin":"prompt"}`,
		`{"seq":3,"v":3,"turn":null,"type":"interrupted"}`,
	}
	if !reflect.DeepEqual(lines, want) {
		t.Errorf("written lines:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(want, "\n"))
	}
}
