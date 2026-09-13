package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func float64Ptr(v float64) *float64 { return &v }

func TestUsageApply(t *testing.T) {
	tests := []struct {
		name        string
		start       Usage
		report      UsageReport
		want        Usage
		wantChanged bool
	}{
		{
			name:   "accumulates token counts",
			start:  Usage{TokenUsage: TokenUsage{InputTokens: 10, OutputTokens: 2, CacheReadTokens: 100, CacheWriteTokens: 5}},
			report: UsageReport{Added: TokenUsage{InputTokens: 1, OutputTokens: 3, CacheReadTokens: 50, CacheWriteTokens: 7}},
			want: Usage{
				TokenUsage: TokenUsage{InputTokens: 11, OutputTokens: 5, CacheReadTokens: 150, CacheWriteTokens: 12},
			},
			wantChanged: true,
		},
		{
			name:        "first cost report starts the total",
			report:      UsageReport{AddedCostUSD: float64Ptr(0.25)},
			want:        Usage{CostUSD: float64Ptr(0.25)},
			wantChanged: true,
		},
		{
			name:        "later cost reports add to it",
			start:       Usage{CostUSD: float64Ptr(0.25)},
			report:      UsageReport{AddedCostUSD: float64Ptr(0.5)},
			want:        Usage{CostUSD: float64Ptr(0.75)},
			wantChanged: true,
		},
		{
			name:        "a report without a cost leaves the stored one alone",
			start:       Usage{CostUSD: float64Ptr(0.25)},
			report:      UsageReport{Added: TokenUsage{OutputTokens: 1}},
			want:        Usage{TokenUsage: TokenUsage{OutputTokens: 1}, CostUSD: float64Ptr(0.25)},
			wantChanged: true,
		},
		{
			name:        "an agent that reports no cost leaves it absent",
			report:      UsageReport{Added: TokenUsage{OutputTokens: 1}},
			want:        Usage{TokenUsage: TokenUsage{OutputTokens: 1}},
			wantChanged: true,
		},
		{
			name:        "context is replaced, not accumulated",
			start:       Usage{ContextTokens: 90000, ContextWindow: 200000},
			report:      UsageReport{ContextTokens: 12000, ContextWindow: 1000000},
			want:        Usage{ContextTokens: 12000, ContextWindow: 1000000},
			wantChanged: true,
		},
		{
			name:        "an unreported context keeps the last known one",
			start:       Usage{ContextTokens: 90000, ContextWindow: 200000},
			report:      UsageReport{Added: TokenUsage{OutputTokens: 1}},
			want:        Usage{TokenUsage: TokenUsage{OutputTokens: 1}, ContextTokens: 90000, ContextWindow: 200000},
			wantChanged: true,
		},
		{
			name:        "a report that changes nothing is reported as no change",
			start:       Usage{TokenUsage: TokenUsage{InputTokens: 10}, ContextWindow: 200000},
			report:      UsageReport{ContextWindow: 200000},
			want:        Usage{TokenUsage: TokenUsage{InputTokens: 10}, ContextWindow: 200000},
			wantChanged: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.start
			changed := got.apply(tt.report)

			if changed != tt.wantChanged {
				t.Errorf("changed = %v, want %v", changed, tt.wantChanged)
			}
			if !got.equal(tt.want) {
				t.Errorf("usage = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestTokenUsageTotal(t *testing.T) {
	u := TokenUsage{InputTokens: 2, OutputTokens: 14, CacheReadTokens: 10126, CacheWriteTokens: 5382}
	if got, want := u.Total(), int64(15524); got != want {
		t.Errorf("Total() = %d, want %d", got, want)
	}
}

func TestUsageReportIsEmpty(t *testing.T) {
	zero := 0.0
	tests := []struct {
		name   string
		report UsageReport
		want   bool
	}{
		{name: "nothing at all", report: UsageReport{}, want: true},
		{name: "tokens", report: UsageReport{Added: TokenUsage{OutputTokens: 1}}},
		// A zero cost increment still says "this agent reports cost", which is
		// what distinguishes a free turn from an agent that never prices anything.
		{name: "a zero cost increment", report: UsageReport{AddedCostUSD: &zero}},
		{name: "context only", report: UsageReport{ContextWindow: 200000}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tt.report.IsEmpty(); got != tt.want {
				t.Errorf("IsEmpty() = %v, want %v", got, tt.want)
			}
		})
	}
}

// Usage is stored inside SessionMeta, so the JSON the store writes and the JSON
// clients read are the same shape. The flattened counters are what makes a
// session's usage readable without knowing about the embedded type.
func TestUsageJSONShape(t *testing.T) {
	data, err := json.Marshal(Usage{
		TokenUsage:    TokenUsage{InputTokens: 1, OutputTokens: 2, CacheReadTokens: 3, CacheWriteTokens: 4},
		CostUSD:       float64Ptr(0.5),
		ContextTokens: 10,
		ContextWindow: 20,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var fields map[string]any
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd", "context_tokens", "context_window"} {
		if _, ok := fields[key]; !ok {
			t.Errorf("missing %q in %s", key, data)
		}
	}

	// An agent that prices nothing must not look like one that priced a turn at
	// zero, so the field is absent rather than 0.
	data, err = json.Marshal(Usage{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var empty map[string]any
	if err := json.Unmarshal(data, &empty); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := empty["cost_usd"]; ok {
		t.Errorf("cost_usd present for an agent that reports no cost: %s", data)
	}
}

func TestFileStoreAddUsage(t *testing.T) {
	ctx := context.Background()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	meta, err := store.Create(ctx, "sess-1", CreateSpec{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if !meta.Usage.IsZero() {
		t.Fatalf("new session starts with usage %+v", meta.Usage)
	}

	for range 2 {
		report := UsageReport{
			Added:         TokenUsage{InputTokens: 5, OutputTokens: 10},
			AddedCostUSD:  float64Ptr(0.25),
			ContextTokens: 1000,
			ContextWindow: 200000,
		}
		if err := store.AddUsage(ctx, "sess-1", report); err != nil {
			t.Fatalf("AddUsage: %v", err)
		}
	}

	want := Usage{
		TokenUsage:    TokenUsage{InputTokens: 10, OutputTokens: 20},
		CostUSD:       float64Ptr(0.5),
		ContextTokens: 1000,
		ContextWindow: 200000,
	}

	got, found, err := store.Get("sess-1")
	if err != nil || !found {
		t.Fatalf("Get: found=%v err=%v", found, err)
	}
	if !got.Usage.equal(want) {
		t.Errorf("in-memory usage = %+v, want %+v", got.Usage, want)
	}

	// Usage has to survive a restart the way the rest of the metadata does: it is
	// a session total, and a server restart is not a reason to start counting again.
	reopened, err := NewFileStore(store.dataDir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	persisted, found, err := reopened.Get("sess-1")
	if err != nil || !found {
		t.Fatalf("Get after reopen: found=%v err=%v", found, err)
	}
	if !persisted.Usage.equal(want) {
		t.Errorf("persisted usage = %+v, want %+v", persisted.Usage, want)
	}
}

// Recording usage must not reorder the session list: it happens while a turn is
// metered, which is not news about the conversation.
func TestFileStoreAddUsageKeepsUpdatedAt(t *testing.T) {
	ctx := context.Background()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	created, err := store.Create(ctx, "sess-1", CreateSpec{})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if err := store.AddUsage(ctx, "sess-1", UsageReport{Added: TokenUsage{OutputTokens: 1}}); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}

	got, _, err := store.Get("sess-1")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if !got.UpdatedAt.Equal(created.UpdatedAt) {
		t.Errorf("UpdatedAt moved from %v to %v", created.UpdatedAt, got.UpdatedAt)
	}
}

func TestFileStoreAddUsageUnknownSession(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	err = store.AddUsage(context.Background(), "gone", UsageReport{Added: TokenUsage{OutputTokens: 1}})
	if err != ErrSessionNotFound {
		t.Errorf("AddUsage for a deleted session: %v, want %v", err, ErrSessionNotFound)
	}
}

// A fork copies the conversation but not what the conversation cost: those
// tokens were spent by the source, and any sum over sessions would count them
// twice.
func TestCreateForkStartsUsageEmpty(t *testing.T) {
	ctx := context.Background()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	if _, err := store.Create(ctx, "source", CreateSpec{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := store.AddUsage(ctx, "source", UsageReport{
		Added:         TokenUsage{InputTokens: 100, OutputTokens: 200},
		AddedCostUSD:  float64Ptr(1.5),
		ContextTokens: 5000,
		ContextWindow: 200000,
	}); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}
	source, _, err := store.Get("source")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}

	fork, err := store.CreateFork(ctx, "fork", ForkSpec{Source: source, Activated: true})
	if err != nil {
		t.Fatalf("CreateFork: %v", err)
	}
	if !fork.Usage.equal(Usage{}) {
		t.Errorf("fork usage = %+v, want empty", fork.Usage)
	}
}

// A session index written before this field existed must load with an empty
// usage rather than failing, and must start counting from there.
func TestFileStoreLoadsIndexWithoutUsage(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	legacy := `{"sessions":[{"id":"old","title":"Old chat","agent_type":"claude","mode":"default","activated":true}]}`
	if err := os.WriteFile(filepath.Join(dataDir, "sessions", "index.json"), []byte(legacy), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	meta, found, err := store.Get("old")
	if err != nil || !found {
		t.Fatalf("Get: found=%v err=%v", found, err)
	}
	if !meta.Usage.equal(Usage{}) {
		t.Errorf("usage = %+v, want empty", meta.Usage)
	}

	if err := store.AddUsage(context.Background(), "old", UsageReport{Added: TokenUsage{OutputTokens: 3}}); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}
	meta, _, err = store.Get("old")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if meta.Usage.OutputTokens != 3 {
		t.Errorf("output tokens = %d, want 3", meta.Usage.OutputTokens)
	}
}

// ReadUsages is how a reader that does not own a data directory — work usage
// aggregation, across worktrees — sees what its sessions consumed. The numbers
// must be the ones the owning store just wrote: it persists the index before
// notifying anyone, so a reader woken by that notification never reads a stale
// file.
func TestReadUsages(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := NewFileStore(dataDir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	for _, id := range []string{"sess-1", "sess-2"} {
		if _, err := store.Create(ctx, id, CreateSpec{}); err != nil {
			t.Fatalf("Create %s: %v", id, err)
		}
	}
	if err := store.AddUsage(ctx, "sess-1", UsageReport{
		Added:        TokenUsage{InputTokens: 7, CacheReadTokens: 100},
		AddedCostUSD: float64Ptr(0.5),
	}); err != nil {
		t.Fatalf("AddUsage: %v", err)
	}

	usages, err := ReadUsages(dataDir)
	if err != nil {
		t.Fatalf("ReadUsages: %v", err)
	}

	got, found := usages["sess-1"]
	if !found {
		t.Fatalf("sess-1 missing from %+v", usages)
	}
	want := Usage{TokenUsage: TokenUsage{InputTokens: 7, CacheReadTokens: 100}, CostUSD: float64Ptr(0.5)}
	if !got.equal(want) {
		t.Errorf("sess-1 usage = %+v, want %+v", got, want)
	}
	// A session that spent nothing is still a session: present, with nothing on it.
	if got, found := usages["sess-2"]; !found || !got.IsZero() {
		t.Errorf("sess-2 usage = %+v (found=%v), want present and zero", got, found)
	}
	if len(usages) != 2 {
		t.Errorf("read %d sessions, want 2", len(usages))
	}
}

// A worktree nothing has run in yet has no index, which is not a failure — the
// aggregation that asked has simply nothing to add from it.
func TestReadUsagesWithoutIndex(t *testing.T) {
	usages, err := ReadUsages(t.TempDir())
	if err != nil {
		t.Fatalf("ReadUsages: %v", err)
	}
	if len(usages) != 0 {
		t.Errorf("read %d sessions from a directory with no index", len(usages))
	}
}

// A corrupt index is reported rather than read as "nothing was spent": the
// caller decides what to do with a total it knows is incomplete, and a silent
// zero would not let it.
func TestReadUsagesCorruptIndex(t *testing.T) {
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "sessions", "index.json"), []byte("{not json"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if _, err := ReadUsages(dataDir); err == nil {
		t.Fatal("expected an error for a corrupt index")
	}
}
