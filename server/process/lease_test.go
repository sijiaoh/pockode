package process

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// leaseTestBudgets are all different and all long, so that a test never waits
// for one and never expires the wrong one: expiry is driven by handing
// reapLeasesAsOf an instant past the budget under test, which is the only way
// entries measured in hours are testable at all.
var leaseTestBudgets = session.LeaseBudgets{
	Turn:       time.Hour,
	Answer:     2 * time.Hour,
	Background: 3 * time.Hour,
	Idle:       4 * time.Hour,
}

// pastBudget is an instant just past the given budget: far enough that the lease
// under test has certainly run out, close enough that it stays inside every
// longer budget in the table. Overshooting would expire rows the test is not
// about, and then a reaper that consulted the wrong one would still pass.
func pastBudget(budget time.Duration) time.Time {
	return time.Now().Add(budget + time.Minute)
}

// startedTurn is the state every lease test starts from: a process with a turn
// under way, which is how a session comes to be holding anything at all.
func startedTurn(t *testing.T, budgets session.LeaseBudgets) (*Manager, *mockAgent, session.Store, *Process) {
	t.Helper()
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, budgets)
	t.Cleanup(m.Shutdown)

	proc, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("failed to create process: %v", err)
	}
	if err := proc.SendMessage("go"); err != nil {
		t.Fatalf("failed to send: %v", err)
	}
	return m, mock, store, proc
}

func historyRecords(t *testing.T, store session.Store, sessionID string) []agent.EventRecord {
	t.Helper()
	raw, err := store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("failed to read history: %v", err)
	}
	records := make([]agent.EventRecord, 0, len(raw))
	for _, line := range raw {
		var record agent.EventRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatalf("failed to decode a history record: %v", err)
		}
		records = append(records, record)
	}
	return records
}

// lastWarning returns the last warning in history, so a test can say
// which explanation the user was given without depending on what else was
// written around it.
func lastWarning(t *testing.T, store session.Store, sessionID string) agent.EventRecord {
	t.Helper()
	var last agent.EventRecord
	for _, record := range historyRecords(t, store, sessionID) {
		if record.Type == agent.EventTypeWarning {
			last = record
		}
	}
	return last
}

// A background wait is the one expiry nobody can be asked about: the CLI is not
// listening, it is waiting on work of its own. The ending is delivered on its
// behalf, and both halves of the explanation go out — the user's in the
// transcript, the agent's on its next prompt.
func TestLease_BackgroundWaitEndsWhenTheBudgetRunsOut(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)

	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the turn to park", func() bool { return holdOf(proc) == session.LeaseBackground })

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Background))

	if turn := proc.turnState(); turn.Phase != session.PhaseIdle {
		t.Errorf("phase after the background budget = %q, want idle", turn.Phase)
	}
	if turn := proc.turnState(); turn.LastOutcome != session.OutcomeCompleted {
		t.Errorf("outcome = %q; the existing warning-plus-done path ends the turn as finished, "+
			"so the work engine carries on the way it did before background waits existed",
			turn.LastOutcome)
	}
	if warning := lastWarning(t, store, "sess-1"); warning.Code != backgroundTimeoutCode {
		t.Errorf("warning code = %q, want %q; a lease running out is never silent", warning.Code, backgroundTimeoutCode)
	}
	if notes := sess.queuedNotes(); len(notes) != 1 || !strings.Contains(notes[0], "background task") {
		t.Errorf("the agent was not told why Pockode stopped waiting, got %v", notes)
	}
	if sess.isClosed() {
		t.Error("the background budget ended the turn, not the process; the idle lease collects it")
	}
}

// Ending the wait is what makes the process collectable at all: the turn falls
// to idle, and the idle lease takes it from there. Nothing else in the table
// closes a process on its own.
func TestLease_BackgroundExpiryLeavesTheProcessToTheIdleLease(t *testing.T) {
	m, mock, _, proc := startedTurn(t, leaseTestBudgets)

	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the turn to park", func() bool { return holdOf(proc) == session.LeaseBackground })

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Background))
	if holdOf(proc) != session.LeaseIdle {
		t.Fatalf("hold after the background budget = %q, want idle", holdOf(proc))
	}

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Idle))
	if m.GetProcess("sess-1") != nil {
		t.Error("the idle lease did not collect a process nothing was waiting on")
	}
}

// A permission request nobody decided is withdrawn on the user's behalf, which
// is what an interrupt is: Codex cancels the outstanding approval before it
// stops the turn, and Claude's interrupt releases the control request it is
// blocking on.
//
// One case rather than a table: a permission request is the only thing left that
// holds a turn open waiting for a person.
func TestLease_UnansweredPromptIsWithdrawn(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)

	sess := mock.session(t, "sess-1")
	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1"})
	waitUntil(t, "the prompt", func() bool { return holdOf(proc) == session.LeaseAnswer })

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Answer))

	if got := sess.interrupts.Load(); got != 1 {
		t.Errorf("interrupts = %d, want 1", got)
	}
	if warning := lastWarning(t, store, "sess-1"); warning.Code != answerTimeoutCode {
		t.Errorf("warning code = %q, want %q", warning.Code, answerTimeoutCode)
	}
	// The turn is not written down as over here: the InterruptedEvent coming
	// back is what ends it, the same as a user's own Stop.
	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	// And the card says which of the three things happened to it. The user is the
	// one who ran out of time; a banner saying the process died would send them
	// looking for a fault that was not there.
	waitUntil(t, "the expiry to be recorded", func() bool {
		return expiryReasonFor(t, store, "req-1") == agent.ReasonTimeout
	})
}

// expiryReasonFor reports the reason on the last request_cancelled record for
// this prompt, or the empty reason if nothing settled it.
func expiryReasonFor(t *testing.T, store session.Store, requestID string) agent.CancelReason {
	t.Helper()
	var reason agent.CancelReason
	found := false
	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Type == agent.EventTypeRequestCancelled && record.RequestID == requestID {
			reason, found = record.Reason, true
		}
	}
	if !found {
		return "unrecorded"
	}
	return reason
}

// A turn that outruns its budget is asked to stop, not taken away: a CLI winding
// down finishes properly, and the abort is recorded once, by the path a user's
// own Stop already uses.
func TestLease_OverrunningTurnIsInterrupted(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Turn))

	if got := sess.interrupts.Load(); got != 1 {
		t.Errorf("interrupts = %d, want 1", got)
	}
	if warning := lastWarning(t, store, "sess-1"); warning.Code != turnTimeoutCode {
		t.Errorf("warning code = %q, want %q", warning.Code, turnTimeoutCode)
	}

	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })
	if turn := proc.turnState(); turn.LastOutcome != session.OutcomeAborted {
		t.Errorf("outcome = %q, want aborted; the turn was taken away rather than finished", turn.LastOutcome)
	}
}

// One expired lease produces one interrupt, however many times the reaper looks
// at it. Otherwise a wedged CLI collects an interrupt per tick and a warning per
// tick with it.
func TestLease_AsksOnce(t *testing.T) {
	m, mock, store, _ := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	expired := pastBudget(leaseTestBudgets.Turn)
	m.reapLeasesAsOf(expired)
	m.reapLeasesAsOf(expired.Add(time.Second))

	if got := sess.interrupts.Load(); got != 1 {
		t.Errorf("interrupts = %d, want 1", got)
	}
	warnings := 0
	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Type == agent.EventTypeWarning {
			warnings++
		}
	}
	if warnings != 1 {
		t.Errorf("warnings = %d, want 1", warnings)
	}
}

// The interrupt is a request, and a CLI can ignore one. Ending the process is
// the stop that needs no cooperation, and without it an expired lease would be
// permanent — which is the exact failure the lease table exists to remove.
func TestLease_UnansweredInterruptEndsTheProcess(t *testing.T) {
	m, mock, _, _ := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	expired := pastBudget(leaseTestBudgets.Turn)
	m.reapLeasesAsOf(expired)
	if m.GetProcess("sess-1") == nil {
		t.Fatal("the process was ended before the CLI had a chance to stop the turn itself")
	}

	m.reapLeasesAsOf(expired.Add(leaseGrace + time.Second))
	if m.GetProcess("sess-1") != nil {
		t.Error("a CLI that ignored the interrupt kept its process")
	}
	if !sess.isClosed() {
		t.Error("expected the agent session to be closed")
	}
}

// A new turn is a new lease, so the one interrupt it is entitled to is its own.
func TestLease_ASecondTurnGetsItsOwnAsk(t *testing.T) {
	m, mock, _, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Turn))
	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	if err := proc.SendMessage("again"); err != nil {
		t.Fatalf("failed to send: %v", err)
	}
	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Turn))

	if got := sess.interrupts.Load(); got != 2 {
		t.Errorf("interrupts = %d, want 2", got)
	}
}

// Nothing happens inside a budget. Stated on its own because every test above
// drives the clock past one, and a reaper that acted regardless would pass all
// of them.
func TestLease_NothingHappensInsideTheBudget(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.BackgroundWaitEvent{})
	// The record, not the hold: the hold flips while the event is being reduced,
	// which is before the record is written, so counting records against the hold
	// would race the append.
	waitForHistory(t, store, "sess-1", 1)

	// Past the turn budget, which is shorter — and not the one holding this
	// process. A table that picked the wrong row would act here.
	m.reapLeasesAsOf(time.Now().Add(leaseTestBudgets.Background - time.Minute))

	if got := sess.interrupts.Load(); got != 0 {
		t.Errorf("interrupts = %d, want 0", got)
	}
	if holdOf(proc) != session.LeaseBackground {
		t.Errorf("hold = %q, want the background wait it is still inside", holdOf(proc))
	}
	if n := len(historyRecords(t, store, "sess-1")); n != 1 {
		t.Errorf("history grew to %d records; nothing should have been written", n)
	}
}

// A budget of zero is an operator saying "hold this for as long as it takes".
func TestLease_UnbudgetedWaitIsNeverCollected(t *testing.T) {
	m, mock, _, proc := startedTurn(t, session.LeaseBudgets{Idle: time.Hour})
	sess := mock.session(t, "sess-1")

	m.reapLeasesAsOf(time.Now().Add(1000 * time.Hour))

	if got := sess.interrupts.Load(); got != 0 {
		t.Errorf("interrupts = %d; a turn with no budget was interrupted anyway", got)
	}
	if m.GetProcess("sess-1") == nil || holdOf(proc) != session.LeaseTurn {
		t.Error("a turn with no budget lost its process")
	}
}

// Progress from a background task that outlived its budget used to push the
// session back to running, with nothing left to end it and no lease that could
// ever collect it. Noise keeps a turn alive; it cannot start one.
func TestLease_ProgressAfterTheTurnEndedDoesNotReviveIt(t *testing.T) {
	m, mock, store, proc := startedTurn(t, leaseTestBudgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.BackgroundWaitEvent{})
	waitUntil(t, "the turn to park", func() bool { return holdOf(proc) == session.LeaseBackground })
	m.reapLeasesAsOf(pastBudget(leaseTestBudgets.Background))

	// The task Pockode stopped waiting for is still running, and still talking.
	sess.emit(t, agent.ToolActivityEvent{ToolUseID: "call-1", Activity: "still going"})
	sess.emit(t, agent.SystemEvent{Content: "background_tasks_changed"})
	// background_wait, the expiry's warning, its done, and the system frame. The
	// tool_activity is not in the count: it is broadcast and never recorded.
	waitForHistory(t, store, "sess-1", 4)

	if turn := proc.turnState(); turn.Phase != session.PhaseIdle {
		t.Errorf("phase = %q, want idle: a task reporting progress is not a turn", turn.Phase)
	}
	if holdOf(proc) != session.LeaseIdle {
		t.Errorf("hold = %q, want idle; anything else is a process no lease can collect", holdOf(proc))
	}
}

// A process whose CLI exited on its own is removed from the manager, but nothing
// set its closed flag — that is reserved for a process Pockode ended. An expiry
// decided from a snapshot taken a moment earlier must still write nothing: the
// stream goroutine has already recorded everything this session will ever
// record, and an explanation appended after it belongs to no process at all.
func TestLease_NothingIsRecordedAfterTheStreamEnds(t *testing.T) {
	_, mock, store, proc := startedTurn(t, leaseTestBudgets)

	mock.session(t, "sess-1").Close()
	select {
	case <-proc.done:
	case <-time.After(awaitTimeout):
		t.Fatal("timed out waiting for the event stream to finish")
	}

	proc.inject(agent.WarningEvent{Message: "too late", Code: "after_the_end"})

	for _, record := range historyRecords(t, store, "sess-1") {
		if record.Code == "after_the_end" {
			t.Error("an expiry wrote into the transcript of a process that had already ended")
		}
	}
}

// A budget of zero turns off its own row and nothing else. It used to turn off
// collection altogether, because there was only one number; an operator who
// wants nothing collected now sets all four.
func TestLease_OneZeroBudgetDoesNotDisarmTheRest(t *testing.T) {
	budgets := session.LeaseBudgets{Idle: 0, Answer: time.Hour}
	m, mock, _, proc := startedTurn(t, budgets)
	sess := mock.session(t, "sess-1")

	sess.emit(t, agent.PermissionRequestEvent{RequestID: "req-1"})
	waitUntil(t, "the prompt", func() bool { return holdOf(proc) == session.LeaseAnswer })

	m.reapLeasesAsOf(pastBudget(budgets.Answer))
	if got := sess.interrupts.Load(); got != 1 {
		t.Errorf("interrupts = %d; a zero idle budget disarmed the answer budget too", got)
	}

	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	m.reapLeasesAsOf(time.Now().Add(1000 * time.Hour))
	if m.GetProcess("sess-1") == nil {
		t.Error("a zero idle budget collected an idle process anyway")
	}
}

// The reaper decides outside processesMu and the message paths hold it, so the
// decision is re-checked before the process is taken away. Driving closeProcess
// with an instant that does not expire the lease is what the interleave looks
// like from inside: a user sent something, lastActive moved, and the reading the
// reaper condemned this process on is no longer true.
func TestLease_CloseSparesAProcessWhoseLeaseCameBack(t *testing.T) {
	m, _, _, proc := startedTurn(t, leaseTestBudgets)

	m.closeProcess(proc, time.Now(), "should not happen", slog.Default())

	if m.GetProcess("sess-1") == nil {
		t.Error("a process whose lease is not expired was collected anyway; a message " +
			"arriving between the reaper's snapshot and the kill would be lost with it")
	}
}

// The grace backstop is a second look, not a scheduled execution. A CLI that did
// end the turn after being asked leaves a process nothing has condemned, and the
// backstop must see that rather than carry out a decision made a minute ago.
func TestLease_StopThatLandsCancelsTheBackstop(t *testing.T) {
	// No idle budget, so the only thing that could collect this process is the
	// backstop itself.
	budgets := session.LeaseBudgets{Turn: time.Hour}
	m, mock, _, proc := startedTurn(t, budgets)
	sess := mock.session(t, "sess-1")

	expired := pastBudget(budgets.Turn)
	m.reapLeasesAsOf(expired)

	sess.emit(t, agent.InterruptedEvent{})
	waitUntil(t, "the turn to end", func() bool { return holdOf(proc) == session.LeaseIdle })

	m.reapLeasesAsOf(expired.Add(leaseGrace + time.Second))
	if m.GetProcess("sess-1") == nil {
		t.Error("the backstop ended a process whose turn had already stopped as asked")
	}
}
