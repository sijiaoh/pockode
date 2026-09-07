package claude

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/agent"
)

func TestBackgroundLossStore_ReportsALossOnceAndOnlyOnce(t *testing.T) {
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: t.TempDir()})

	if got := store.peek(testLogger()); got != 0 {
		t.Fatalf("expected nothing to report for a session that never lost anything, got %d", got)
	}

	store.record(testLogger(), 2)

	if got := store.peek(testLogger()); got != 2 {
		t.Fatalf("expected 2 lost tasks, got %d", got)
	}
	// A loss stays on the books until the explanation has actually been handed
	// over, so a process that dies before it can report one does not swallow it.
	if got := store.peek(testLogger()); got != 2 {
		t.Fatalf("expected an unreported loss to survive, got %d", got)
	}

	store.clear(testLogger())

	// Reporting it again on every later start would be worse than not reporting
	// it at all: the explanation would outlive the thing it explains.
	if got := store.peek(testLogger()); got != 0 {
		t.Errorf("expected the loss to be gone once reported, got %d", got)
	}
}

// A record Pockode cannot read explains nothing and would be re-read on every
// future start of this session.
func TestBackgroundLossStore_DiscardsAnUnreadableRecord(t *testing.T) {
	dataDir := t.TempDir()
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: dataDir})
	path := filepath.Join(dataDir, "sessions", "sess-1", backgroundLossFile)

	store.record(testLogger(), 2)
	if err := os.WriteFile(path, []byte("{not json"), 0644); err != nil {
		t.Fatal(err)
	}

	if got := store.peek(testLogger()); got != 0 {
		t.Fatalf("expected nothing to report from an unreadable record, got %d", got)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("expected the unreadable record to be discarded, stat error was %v", err)
	}
}

// Nothing died, so nothing is recorded — the common case must not leave a file
// behind for the next process to trip over.
func TestBackgroundLossStore_IgnoresAProcessThatLostNothing(t *testing.T) {
	dataDir := t.TempDir()
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: dataDir})

	store.record(testLogger(), 0)

	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "sess-1", backgroundLossFile)); !os.IsNotExist(err) {
		t.Errorf("expected no record to be written, stat error was %v", err)
	}
	if got := store.peek(testLogger()); got != 0 {
		t.Errorf("expected no loss to report, got %d", got)
	}
}

// Sessions without a data directory (tests, anonymous sessions) have nowhere to
// keep the record; they must degrade to silence rather than fail.
func TestBackgroundLossStore_DisabledWithoutADataDir(t *testing.T) {
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1"})

	store.record(testLogger(), 3)

	if got := store.peek(testLogger()); got != 0 {
		t.Errorf("expected a disabled store to report nothing, got %d", got)
	}
}

// Close is the only point a server shutdown waits for: it stops the CLI and the
// process exits, so a loss recorded from the streaming goroutine instead would
// often never be written at all — and a server restart is the very case this
// explanation exists for.
func TestSession_CloseRecordsTheLossItIsAboutToCause(t *testing.T) {
	dataDir := t.TempDir()
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: dataDir})

	tracker := &backgroundTaskTracker{}
	parseTestLineWithTracker(testLogger(), []byte(oneLiveTask), tracker)

	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&bytes.Buffer{}},
		backgroundTasks: tracker,
		lossStore:       store,
		cancel:          func() {},
	}
	sess.Close()

	if got := store.peek(testLogger()); got != 1 {
		t.Errorf("expected the running background task to be recorded as lost, got %d", got)
	}
}
