package session

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFileStore_ApplyTurn(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "sess-1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	started, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPrompt, At: at(0)})
	if err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	if started.State.Phase != PhaseRunning || !started.Changed {
		t.Fatalf("transition = %+v, want a running turn", started)
	}

	meta, found, err := store.Get("sess-1")
	if err != nil || !found {
		t.Fatalf("Get failed: found=%v err=%v", found, err)
	}
	if meta.Turn.Phase != PhaseRunning {
		t.Errorf("stored phase = %q, want running", meta.Turn.Phase)
	}
}

func TestFileStore_ApplyTurnNonExistent(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	// The specific error matters: it is the one the process treats as ordinary —
	// a session deleted while its stream is still draining — rather than as
	// something worth shouting about.
	if _, err := store.ApplyTurn(ctx, "missing", TurnInput{Signal: SignalPrompt}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("err = %v, want ErrSessionNotFound", err)
	}
}

// An index write per event would be a write per token, and a notification per
// token with it. The reducer decides what counts as a change; this is the store
// honouring that decision, observed through the notification because that is
// what a write costs everyone else.
func TestFileStore_ApplyTurnOnlyWritesRealChanges(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "sess-1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}

	listener := &countingListener{}
	store.AddOnChangeListener(listener)

	for _, in := range []TurnInput{
		{Signal: SignalOutput, At: at(1)},
		{Signal: SignalOutput, At: at(2)},
		{Signal: SignalNoise, At: at(3)},
	} {
		transition, err := store.ApplyTurn(ctx, "sess-1", in)
		if err != nil {
			t.Fatalf("ApplyTurn failed: %v", err)
		}
		if transition.Changed {
			t.Fatalf("%q during a running turn is not a change", in.Signal)
		}
	}
	if listener.count != 0 {
		t.Errorf("the session was announced %d times for a turn state that did not move", listener.count)
	}

	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalDone, At: at(4)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	if listener.count != 1 {
		t.Errorf("the turn ending was announced %d times, want once", listener.count)
	}
}

type countingListener struct{ count int }

func (l *countingListener) OnSessionChange(SessionChangeEvent) { l.count++ }

func TestFileStore_ForkStartsIdle(t *testing.T) {
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "source", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "source", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "source", TurnInput{Signal: SignalPermissionRaised, RequestID: "req-1", At: at(1)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	source, _, err := store.Get("source")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}

	fork, err := store.CreateFork(ctx, "fork", ForkSpec{Source: source, Activated: true})
	if err != nil {
		t.Fatalf("CreateFork failed: %v", err)
	}

	// Nothing is producing output for the fork, and the prompt in the source
	// can only be answered by the source's own process.
	if fork.Turn.InProgress() {
		t.Errorf("fork turn = %+v, want idle", fork.Turn)
	}
	if len(fork.Turn.Blockers) != 0 {
		t.Errorf("fork inherited blockers it cannot clear: %+v", fork.Turn.Blockers)
	}
}

// --- The restart repair ---

// A session mid-turn when the server was killed has to come back saying so,
// because nothing else will: no process survived to report it, and the CLI's own
// transcript may hold nothing about the prompt at all.
func TestFileStore_RestartAbortsAnOpenTurn(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "sess-1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPermissionRaised, RequestID: "req-1", At: at(1)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}

	// No shutdown: the file on disk is what a killed run leaves behind.
	restarted, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	meta, found, err := restarted.Get("sess-1")
	if err != nil || !found {
		t.Fatalf("Get failed: found=%v err=%v", found, err)
	}
	if meta.Turn.Phase != PhaseIdle {
		t.Errorf("phase = %q, want idle", meta.Turn.Phase)
	}
	if meta.Turn.AwaitingUserAnswer() {
		t.Error("a prompt whose process is gone cannot be waiting for an answer")
	}
	if meta.Turn.LastOutcome != OutcomeAborted {
		t.Errorf("outcome = %q, want aborted", meta.Turn.LastOutcome)
	}

	// The transcript gets the record the killed run never wrote. Without it a
	// client replaying the history shows a permission card that looks answerable.
	records, err := restarted.GetHistory(ctx, "sess-1")
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(records) != 1 || recordType(t, records[0]) != HistoryTypeProcessEnded {
		t.Fatalf("history = %s, want one process_ended record", records)
	}
}

// The repair is written back, so a session nobody touches again is not repaired
// from scratch on every start — which would append a process_ended record each
// time.
func TestFileStore_RestartRepairIsWrittenOnce(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "sess-1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}

	for range 3 {
		if _, err := NewFileStore(dir); err != nil {
			t.Fatalf("NewFileStore failed: %v", err)
		}
	}

	final, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	records, err := final.GetHistory(ctx, "sess-1")
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(records) != 1 {
		t.Errorf("history has %d records after four starts, want the one the first repair wrote", len(records))
	}
}

// A session that was idle is the overwhelming majority, and it must come back
// untouched — no rewritten state, and above all no obituary in its transcript.
func TestFileStore_RestartLeavesAnIdleSessionAlone(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	if _, err := store.Create(ctx, "sess-1", CreateSpec{}); err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalPrompt, At: at(0)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}
	if _, err := store.ApplyTurn(ctx, "sess-1", TurnInput{Signal: SignalDone, At: at(1)}); err != nil {
		t.Fatalf("ApplyTurn failed: %v", err)
	}

	restarted, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}
	meta, _, err := restarted.Get("sess-1")
	if err != nil {
		t.Fatalf("Get failed: %v", err)
	}
	if meta.Turn.LastOutcome != OutcomeCompleted {
		t.Errorf("outcome = %q, want the completed turn's own outcome", meta.Turn.LastOutcome)
	}
	records, err := restarted.GetHistory(ctx, "sess-1")
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(records) != 0 {
		t.Errorf("history = %s, want nothing written for a session that was already idle", records)
	}
}

// An index written before turn state existed carries no turn at all, and the
// obsolete needs_input it does carry is simply not read. This is the whole of
// the migration.
func TestFileStore_ReadsAnIndexWrittenBeforeTurnState(t *testing.T) {
	dir := t.TempDir()
	sessionsDir := filepath.Join(dir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0755); err != nil {
		t.Fatalf("failed to create sessions dir: %v", err)
	}
	legacy := `{"sessions":[{"id":"legacy","title":"Legacy","needs_input":true,` +
		`"createdAt":"2024-01-01T00:00:00Z","updatedAt":"2024-01-01T00:00:00Z"}]}`
	if err := os.WriteFile(filepath.Join(sessionsDir, "index.json"), []byte(legacy), 0644); err != nil {
		t.Fatalf("failed to write index: %v", err)
	}

	store, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore failed: %v", err)
	}

	meta, found, err := store.Get("legacy")
	if err != nil || !found {
		t.Fatalf("Get failed: found=%v err=%v", found, err)
	}
	if meta.Turn.InProgress() || meta.Turn.AwaitingUserAnswer() {
		t.Errorf("turn = %+v, want idle", meta.Turn)
	}
	records, err := store.GetHistory(ctx, "legacy")
	if err != nil {
		t.Fatalf("GetHistory failed: %v", err)
	}
	if len(records) != 0 {
		t.Errorf("history = %s, want nothing — there was no turn to abort", records)
	}
}

func recordType(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var fields struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatalf("failed to parse history record %s: %v", raw, err)
	}
	return fields.Type
}
