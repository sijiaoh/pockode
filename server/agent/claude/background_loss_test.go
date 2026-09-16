package claude

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/pockode/server/agent"
)

func TestBackgroundLossStore_ReportsALossOnceAndOnlyOnce(t *testing.T) {
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: t.TempDir()})

	if got := store.peek(testLogger()); got.reportable() {
		t.Fatalf("expected nothing to report for a session that never lost anything, got %+v", got)
	}

	store.record(testLogger(), backgroundLossRecord{LostTasks: 2, LostCalls: []string{"call-a", "call-b"}})

	// Both halves survive the round trip: the count is what the warning is
	// worded from, the ids are what settles the rows.
	got := store.peek(testLogger())
	if got.LostTasks != 2 {
		t.Fatalf("expected 2 lost tasks, got %d", got.LostTasks)
	}
	if !slices.Equal(got.LostCalls, []string{"call-a", "call-b"}) {
		t.Fatalf("lost calls = %v, want the two recorded ids", got.LostCalls)
	}
	// A loss stays on the books until the explanation has actually been handed
	// over, so a process that dies before it can report one does not swallow it.
	if got := store.peek(testLogger()); got.LostTasks != 2 {
		t.Fatalf("expected an unreported loss to survive, got %+v", got)
	}

	store.clear(testLogger())

	// Reporting it again on every later start would be worse than not reporting
	// it at all: the explanation would outlive the thing it explains.
	if got := store.peek(testLogger()); got.reportable() {
		t.Errorf("expected the loss to be gone once reported, got %+v", got)
	}
}

// A record left by a build that only counted the tasks must still be read: the
// upgrade that added the ids must not turn the last process's loss into either
// a crash or a silence.
func TestBackgroundLossStore_ReadsARecordWrittenBeforeCallsWereKept(t *testing.T) {
	dataDir := t.TempDir()
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: dataDir})
	path := filepath.Join(dataDir, "sessions", "sess-1", backgroundLossFile)

	store.record(testLogger(), backgroundLossRecord{LostTasks: 1})
	if err := os.WriteFile(path, []byte(`{"lostTasks":3}`), 0644); err != nil {
		t.Fatal(err)
	}

	got := store.peek(testLogger())
	if got.LostTasks != 3 {
		t.Errorf("lost tasks = %d, want the 3 the old record names", got.LostTasks)
	}
	if got.LostCalls != nil {
		t.Errorf("lost calls = %v, want none: the old format named none", got.LostCalls)
	}
}

// The ids alone are worth keeping: they settle the rows even when the task level
// never reported a count for them.
func TestBackgroundLossStore_RecordsCallsWithoutACount(t *testing.T) {
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: t.TempDir()})

	store.record(testLogger(), backgroundLossRecord{LostCalls: []string{"call-a"}})

	got := store.peek(testLogger())
	if !slices.Equal(got.LostCalls, []string{"call-a"}) {
		t.Errorf("lost calls = %v, want the recorded id", got.LostCalls)
	}
}

// A record Pockode cannot read explains nothing and would be re-read on every
// future start of this session.
func TestBackgroundLossStore_DiscardsAnUnreadableRecord(t *testing.T) {
	dataDir := t.TempDir()
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1", DataDir: dataDir})
	path := filepath.Join(dataDir, "sessions", "sess-1", backgroundLossFile)

	store.record(testLogger(), backgroundLossRecord{LostTasks: 2})
	if err := os.WriteFile(path, []byte("{not json"), 0644); err != nil {
		t.Fatal(err)
	}

	if got := store.peek(testLogger()); got.reportable() {
		t.Fatalf("expected nothing to report from an unreadable record, got %+v", got)
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

	store.record(testLogger(), backgroundLossRecord{})

	if _, err := os.Stat(filepath.Join(dataDir, "sessions", "sess-1", backgroundLossFile)); !os.IsNotExist(err) {
		t.Errorf("expected no record to be written, stat error was %v", err)
	}
	if got := store.peek(testLogger()); got.reportable() {
		t.Errorf("expected no loss to report, got %+v", got)
	}
}

// Sessions without a data directory (tests, anonymous sessions) have nowhere to
// keep the record; they must degrade to silence rather than fail.
func TestBackgroundLossStore_DisabledWithoutADataDir(t *testing.T) {
	store := newBackgroundLossStore(agent.StartOptions{SessionID: "sess-1"})

	store.record(testLogger(), backgroundLossRecord{LostTasks: 3})

	if got := store.peek(testLogger()); got.reportable() {
		t.Errorf("expected a disabled store to report nothing, got %+v", got)
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
	parseTestLineWithTracker(testLogger(), []byte(bgTaskStarted), tracker)
	parseTestLineWithTracker(testLogger(), []byte(bgPlaceholder), tracker)

	sess := &cliSession{
		log:             testLogger(),
		stdin:           nopWriteCloser{&bytes.Buffer{}},
		backgroundTasks: tracker,
		lossStore:       store,
		cancel:          func() {},
	}
	sess.Close()

	got := store.peek(testLogger())
	if got.LostTasks != 1 {
		t.Errorf("expected the running background task to be recorded as lost, got %+v", got)
	}
	// Without the id the next process can only say how many died, and the row
	// for this call goes on claiming the work is still running.
	if !slices.Equal(got.LostCalls, []string{"toolu_bg"}) {
		t.Errorf("lost calls = %v, want the call whose work was killed", got.LostCalls)
	}
}

// What the next process needs is the calls whose work has not reported an
// outcome yet — and only those.
func TestBackgroundTaskTracker_LossNamesTheCallsStillInFlight(t *testing.T) {
	tracker := &backgroundTaskTracker{}
	for _, line := range []string{
		oneLiveTask,
		bgTaskStarted, bgPlaceholder, // backgrounded: its outcome is still owed
		inlineTaskStarted,  // ran inside its own call, which reports for it
		ambientTaskStarted, // housekeeping the CLI asks hosts to hide
	} {
		parseTestLineWithTracker(testLogger(), []byte(line), tracker)
	}

	if got := tracker.loss(); !slices.Equal(got.LostCalls, []string{"toolu_bg"}) {
		t.Errorf("lost calls = %v, want only the backgrounded call", got.LostCalls)
	}

	parseTestLineWithTracker(testLogger(), []byte(bgNotified), tracker)

	// It reported its outcome, so it is not owed one: asserting it died would be
	// overwriting the CLI's own word with a guess.
	if got := tracker.loss(); got.LostCalls != nil {
		t.Errorf("lost calls = %v after the outcome arrived, want none", got.LostCalls)
	}
}

// The point of the whole record: each row that was left saying "running" gets a
// settled result, and the summary explains why they all ended at once.
func TestDeliverBackgroundLoss_SettlesEachCallThenExplains(t *testing.T) {
	events := make(chan agent.AgentEvent, 8)

	if !deliverBackgroundLoss(context.Background(), events, backgroundLossRecord{
		LostTasks: 2,
		LostCalls: []string{"toolu_a", "toolu_b"},
	}) {
		t.Fatal("expected the whole explanation to be delivered")
	}
	close(events)

	var results []agent.ToolResultEvent
	var warnings []agent.WarningEvent
	for event := range events {
		switch e := event.(type) {
		case agent.ToolResultEvent:
			results = append(results, e)
		case agent.WarningEvent:
			warnings = append(warnings, e)
		default:
			t.Fatalf("unexpected event %#v", event)
		}
	}

	if len(results) != 2 {
		t.Fatalf("expected one result per lost call, got %#v", results)
	}
	for i, id := range []string{"toolu_a", "toolu_b"} {
		result := results[i]
		if result.ToolUseID != id {
			t.Errorf("result %d is about %q, want %q", i, result.ToolUseID, id)
		}
		// The subtype is what keeps this honest: it is Pockode's own reading of
		// a process it saw end, not something the CLI reported.
		if result.Subtype != agent.ToolResultBackgroundLost {
			t.Errorf("subtype = %q, want %q", result.Subtype, agent.ToolResultBackgroundLost)
		}
		if !result.IsError {
			t.Error("work that was killed before it finished is not a success")
		}
		if result.ToolResult == "" {
			t.Error("a settled row still needs words in it")
		}
	}
	if len(warnings) != 1 || warnings[0].Code != backgroundTasksLostCode {
		t.Fatalf("expected the one summary warning, got %#v", warnings)
	}
}

// A record written before the ids were kept still explains itself, and a record
// with ids but no count still settles its rows. Neither half is derived from the
// other, so each has to stand alone.
func TestDeliverBackgroundLoss_ReportsWhicheverHalfItHas(t *testing.T) {
	for _, tt := range []struct {
		name         string
		loss         backgroundLossRecord
		wantResults  int
		wantWarnings int
	}{
		{"a record from before the ids were kept", backgroundLossRecord{LostTasks: 3}, 0, 1},
		{"calls the task level never counted", backgroundLossRecord{LostCalls: []string{"toolu_a"}}, 1, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			events := make(chan agent.AgentEvent, 8)
			if !deliverBackgroundLoss(context.Background(), events, tt.loss) {
				t.Fatal("expected delivery to succeed")
			}
			close(events)

			results, warnings := 0, 0
			for event := range events {
				switch event.(type) {
				case agent.ToolResultEvent:
					results++
				case agent.WarningEvent:
					warnings++
				}
			}
			if results != tt.wantResults || warnings != tt.wantWarnings {
				t.Errorf("got %d results and %d warnings, want %d and %d", results, warnings, tt.wantResults, tt.wantWarnings)
			}
		})
	}
}

// A process that dies mid-explanation must not report the loss as delivered:
// the caller clears the record on this answer, and a half-told loss cleared is
// a loss never told.
func TestDeliverBackgroundLoss_ReportsAnUndeliveredExplanation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if deliverBackgroundLoss(ctx, make(chan agent.AgentEvent), backgroundLossRecord{LostTasks: 1, LostCalls: []string{"toolu_a"}}) {
		t.Error("expected a dead process to report the explanation as undelivered")
	}
}
