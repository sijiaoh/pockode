package work

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// mockSender records SendMessage calls.
type mockSender struct {
	messagesMu sync.Mutex
	messages   []sentMessage
}

type sentMessage struct {
	SessionID string
	Content   string
}

func (m *mockSender) SendMessage(_ context.Context, sessionID, content string) error {
	m.messagesMu.Lock()
	defer m.messagesMu.Unlock()
	m.messages = append(m.messages, sentMessage{SessionID: sessionID, Content: content})
	return nil
}

func (m *mockSender) getMessages() []sentMessage {
	m.messagesMu.Lock()
	defer m.messagesMu.Unlock()
	out := make([]sentMessage, len(m.messages))
	copy(out, m.messages)
	return out
}

func setupResumerTest(t *testing.T) (*FileStore, *AutoResumer, *mockSender) {
	t.Helper()
	store := newTestStore(t)
	sender := &mockSender{}
	resumer := NewAutoResumer(store, 3)
	resumer.settleDelay = 10 * time.Millisecond
	resumer.SetSender(sender)
	return store, resumer, sender
}

// --- Trigger A: auto-continuation ---

func TestAutoResumer_ContinuesInProgressWork(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].SessionID != sid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, sid)
	}
}

func TestAutoResumer_RunningDoesNotSendMessage(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "running", false, false, false)

	time.Sleep(50 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message for running state")
	}
}

func TestAutoResumer_RunningReactivatesStoppedWork(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Transition to stopped (simulates process exit → work stopped)
	store.Stop(context.Background(), story.ID)

	resumer.HandleProcessStateChange(sid, "running", false, false, false)

	w := getWork(t, store, story.ID)
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want %q after process running on stopped work", w.Status, StatusInProgress)
	}
}

func TestAutoResumer_RunningNoopWhenWorkInProgress(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Work is already in_progress — running should be a no-op
	resumer.HandleProcessStateChange(sid, "running", false, false, false)

	w := getWork(t, store, story.ID)
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want %q (should remain in_progress)", w.Status, StatusInProgress)
	}
}

func TestAutoResumer_RunningNoopWhenNoWork(t *testing.T) {
	_, resumer, _ := setupResumerTest(t)

	// No work linked to this session — should not panic
	resumer.HandleProcessStateChange("unknown-session", "running", false, false, false)
}

func TestAutoResumer_RunningResetsRetryCount(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Use 2 retries
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 2 })

	// Stop work, then reactivate via running
	store.Stop(context.Background(), story.ID)
	resumer.HandleProcessStateChange(sid, "running", false, false, false)

	// Should be able to retry 3 more times (counter reset)
	for i := 0; i < 3; i++ {
		resumer.HandleProcessStateChange(sid, "idle", false, false, false)
		waitFor(t, func() bool { return len(sender.getMessages()) >= 2+i+1 })
	}

	if len(sender.getMessages()) != 5 {
		t.Errorf("expected 5 messages (2 before + 3 after reset), got %d", len(sender.getMessages()))
	}
}

func TestAutoResumer_IgnoresInitialIdle(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, true, false)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message for initial idle on process creation")
	}
}

func TestAutoResumer_InterruptStopsWork(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, true)

	waitFor(t, func() bool {
		w := getWork(t, store, story.ID)
		return w.Status == StatusStopped
	})

	// No continuation message should be sent
	if len(sender.getMessages()) != 0 {
		t.Error("should not send continuation message after interrupt")
	}

	w := getWork(t, store, story.ID)
	if w.Status != StatusStopped {
		t.Errorf("status = %q, want %q after interrupt", w.Status, StatusStopped)
	}
}

func TestAutoResumer_IgnoresNeedsInput(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", true, false, false)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message when NeedsInput is true")
	}
}

func TestAutoResumer_SkipsWhenNoSender(t *testing.T) {
	store := newTestStore(t)
	resumer := NewAutoResumer(store, 3)
	// sender NOT set

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Should not panic
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify no panic
}

func TestAutoResumer_RetryLimit_TransitionsToStopped(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Exhaust retries (maxRetries=3)
	for i := 0; i < 4; i++ {
		resumer.HandleProcessStateChange(sid, "idle", false, false, false)
		if i < 3 {
			waitFor(t, func() bool { return len(sender.getMessages()) >= i+1 })
		} else {
			time.Sleep(50 * time.Millisecond) // 4th attempt should be rejected
		}
	}

	msgs := sender.getMessages()
	if len(msgs) != 3 {
		t.Errorf("expected 3 messages (retry limit), got %d", len(msgs))
	}

	// Work should be transitioned to stopped
	w := getWork(t, store, story.ID)
	if w.Status != StatusStopped {
		t.Errorf("status = %q, want %q after retry limit", w.Status, StatusStopped)
	}
}

func TestAutoResumer_RetryResetOnCompletion(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Use 2 retries
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 2 })

	if len(sender.getMessages()) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(sender.getMessages()))
	}

	// Complete → resets retry count
	resumer.OnWorkChange(ChangeEvent{Op: OperationUpdate, Work: Work{
		ID: task.ID, Status: StatusDone, SessionID: sid,
	}})

	// Re-open task for more work
	store.Reactivate(context.Background(), task.ID)

	// Should be able to retry again from 0
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 3 })

	if len(sender.getMessages()) != 3 {
		t.Errorf("expected 3 messages (retry reset), got %d", len(sender.getMessages()))
	}
}

func TestAutoResumer_NoMessageWhenWorkNeedsInput(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Transition to needs_input
	store.MarkNeedsInput(context.Background(), story.ID)

	// Process stops — but work is needs_input, not in_progress
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send continuation message when work is needs_input")
	}
}

func TestAutoResumer_NoMessageWhenWorkDone(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Mark done (auto-closes since no children)
	doneWork(t, store, task.ID)

	// Process stops — but work is already closed
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message when work is already done/closed")
	}
}

// --- Trigger B: parent reactivation ---

func TestAutoResumer_SendsMessageToParentOnChildClose(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	parentSid := "parent-session"
	startWorkWithSession(t, store, story.ID, parentSid)
	startWork(t, store, task.ID)

	// Parent done, waiting for children
	doneWork(t, store, story.ID)

	// Simulate child closed event
	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationUpdate,
		Work: Work{ID: task.ID, Status: StatusClosed, ParentID: story.ID, Title: "Task"},
	})

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	// Parent transitioned to in_progress so the agent can call work_done again
	parent := getWork(t, store, story.ID)
	if parent.Status != StatusInProgress {
		t.Errorf("parent status = %q, want %q", parent.Status, StatusInProgress)
	}

	// Message sent to parent session
	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 reactivation message, got %d", len(msgs))
	}
	if msgs[0].SessionID != parentSid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, parentSid)
	}
}

func TestAutoResumer_SendsMessageWhenLastChildCompletes(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)
	store.AddOnChangeListener(resumer)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	parentSid := "parent-session"
	startWorkWithSession(t, store, story.ID, parentSid)
	startWork(t, store, task.ID)

	// Parent done, waiting for children
	doneWork(t, store, story.ID)

	// MarkDone on the last task: autoClose closes the task,
	// which triggers handleParentReactivation via OnWorkChange.
	if err := store.MarkDone(context.Background(), task.ID); err != nil {
		t.Fatalf("MarkDone task: %v", err)
	}

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	// Parent transitioned to in_progress for agent review
	parent := getWork(t, store, story.ID)
	if parent.Status != StatusInProgress {
		t.Errorf("parent status = %q, want %q", parent.Status, StatusInProgress)
	}

	// Message was sent to parent session
	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 reactivation message, got %d", len(msgs))
	}
	if msgs[0].SessionID != parentSid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, parentSid)
	}
}

func TestAutoResumer_SendsMessageWhenSiblingsStillRunning(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task1 := createTask(t, store, story.ID, "Task 1")
	task2 := createTask(t, store, story.ID, "Task 2")
	parentSid := "parent-session"
	startWorkWithSession(t, store, story.ID, parentSid)
	startWork(t, store, task1.ID)
	startWork(t, store, task2.ID)

	// Parent done, waiting for children
	doneWork(t, store, story.ID)

	// Simulate child 1 closed event while child 2 is still running
	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationUpdate,
		Work: Work{ID: task1.ID, Status: StatusClosed, ParentID: story.ID, Title: "Task 1"},
	})

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	// Parent transitioned to in_progress
	parent := getWork(t, store, story.ID)
	if parent.Status != StatusInProgress {
		t.Errorf("parent status = %q, want %q", parent.Status, StatusInProgress)
	}

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 reactivation message, got %d", len(msgs))
	}
	if msgs[0].SessionID != parentSid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, parentSid)
	}
}

func TestAutoResumer_NoReactivateWhenParentInProgress(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	parentSid := "parent-session"
	startWorkWithSession(t, store, story.ID, parentSid)
	startWork(t, store, task.ID)

	// Parent is still in_progress (not done)
	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationUpdate,
		Work: Work{ID: task.ID, Status: StatusClosed, ParentID: story.ID},
	})

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not reactivate parent that is still in_progress")
	}
}

func TestAutoResumer_IgnoresNonUpdateEvents(t *testing.T) {
	_, resumer, sender := setupResumerTest(t)

	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationCreate,
		Work: Work{ID: "x", Status: StatusClosed, ParentID: "y"},
	})

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should ignore non-update events")
	}
}

func TestAutoResumer_IgnoresTopLevelClosed(t *testing.T) {
	_, resumer, sender := setupResumerTest(t)

	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationUpdate,
		Work: Work{ID: "x", Status: StatusClosed, ParentID: ""},
	})

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should ignore top-level closed events")
	}
}

// --- Trigger C: external work start ---

// mockStartHandler records HandleWorkStart calls.
type mockStartHandler struct {
	mu    sync.Mutex
	calls []Work
	err   error // if non-nil, HandleWorkStart returns this error
}

func (m *mockStartHandler) HandleWorkStart(_ context.Context, w Work) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, w)
	return m.err
}

func (m *mockStartHandler) getCalls() []Work {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Work, len(m.calls))
	copy(out, m.calls)
	return out
}

func TestAutoResumer_ExternalWorkStart(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)
	handler := &mockStartHandler{}
	resumer.SetStartHandler(handler)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// External event: work started via MCP
	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: true,
		Work:     Work{ID: story.ID, Status: StatusInProgress, SessionID: sid, AgentRoleID: testRoleID},
	})

	waitFor(t, func() bool { return len(handler.getCalls()) >= 1 })

	calls := handler.getCalls()
	if len(calls) != 1 {
		t.Fatalf("expected 1 start call, got %d", len(calls))
	}
	if calls[0].ID != story.ID {
		t.Errorf("work ID = %q, want %q", calls[0].ID, story.ID)
	}
}

func TestAutoResumer_InternalInProgressDoesNotTriggerC(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)
	handler := &mockStartHandler{}
	resumer.SetStartHandler(handler)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Internal event (External=false): e.g. parent reactivation
	resumer.OnWorkChange(ChangeEvent{
		Op:   OperationUpdate,
		Work: Work{ID: story.ID, Status: StatusInProgress, SessionID: sid},
	})

	time.Sleep(50 * time.Millisecond)
	if len(handler.getCalls()) != 0 {
		t.Error("should not trigger work start for internal events")
	}
}

func TestAutoResumer_ExternalWorkStartRollbackOnFailure(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)
	handler := &mockStartHandler{err: fmt.Errorf("session create failed")}
	resumer.SetStartHandler(handler)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: true,
		Work:     Work{ID: story.ID, Status: StatusInProgress, SessionID: sid, AgentRoleID: testRoleID},
	})

	waitFor(t, func() bool { return len(handler.getCalls()) >= 1 })
	// Give rollback time to execute
	time.Sleep(50 * time.Millisecond)

	// Work should be rolled back to open
	w := getWork(t, store, story.ID)
	if w.Status != StatusOpen {
		t.Errorf("status = %q, want %q (rollback)", w.Status, StatusOpen)
	}
	if w.SessionID != "" {
		t.Errorf("sessionID = %q, want empty (rollback)", w.SessionID)
	}
}

// --- Process ended → stopped ---

func TestAutoResumer_ProcessEndedStopsWork(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "ended", false, false, false)

	waitFor(t, func() bool {
		w := getWork(t, store, story.ID)
		return w.Status == StatusStopped
	})

	w := getWork(t, store, story.ID)
	if w.Status != StatusStopped {
		t.Errorf("status = %q, want %q after process ended", w.Status, StatusStopped)
	}
}

func TestAutoResumer_ProcessEndedStopsNeedsInputWork(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Transition to needs_input (agent waiting for user)
	store.MarkNeedsInput(context.Background(), story.ID)

	resumer.HandleProcessStateChange(sid, "ended", false, false, false)

	waitFor(t, func() bool {
		w := getWork(t, store, story.ID)
		return w.Status == StatusStopped
	})

	w := getWork(t, store, story.ID)
	if w.Status != StatusStopped {
		t.Errorf("status = %q, want %q after process ended while needs_input", w.Status, StatusStopped)
	}
}

func TestAutoResumer_ProcessEndedSkippedWhenContinuationPending(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// idle fires first → auto-continuation pending
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)
	// ended fires shortly after → should be suppressed
	resumer.HandleProcessStateChange(sid, "ended", false, false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	// Work should still be in_progress (continuation sent, not stopped)
	w := getWork(t, store, story.ID)
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want %q (ended suppressed by continuation)", w.Status, StatusInProgress)
	}
}

func TestAutoResumer_ProcessEndedNoopWhenWorkDone(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Work completes before process ends
	doneWork(t, store, task.ID)

	resumer.HandleProcessStateChange(sid, "ended", false, false, false)

	time.Sleep(50 * time.Millisecond)

	w := getWork(t, store, task.ID)
	if w.Status != StatusClosed {
		t.Errorf("status = %q, want %q (should remain closed)", w.Status, StatusClosed)
	}
}

func TestAutoResumer_ProcessEndedNoopWhenWorkDoneNotClosed(t *testing.T) {
	store, resumer, _ := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)
	startWork(t, store, task.ID)

	// Story done — stays done (not auto-closed) because task is still running
	doneWork(t, store, story.ID)
	if getWork(t, store, story.ID).Status != StatusDone {
		t.Fatal("precondition: story should be done (not closed)")
	}

	resumer.HandleProcessStateChange(sid, "ended", false, false, false)

	time.Sleep(50 * time.Millisecond)

	w := getWork(t, store, story.ID)
	if w.Status != StatusDone {
		t.Errorf("status = %q, want %q (should remain done)", w.Status, StatusDone)
	}
}

// --- StopOrphanedWork ---

func TestAutoResumer_StopOrphanedWork(t *testing.T) {
	store := newTestStore(t)
	resumer := NewAutoResumer(store, 3)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	startWorkWithSession(t, store, story.ID, "s1")
	startWorkWithSession(t, store, task.ID, "s2")

	// Simulate server restart: both are in_progress with no live sessions
	resumer.StopOrphanedWork()

	s := getWork(t, store, story.ID)
	if s.Status != StatusStopped {
		t.Errorf("story status = %q, want %q", s.Status, StatusStopped)
	}
	tk := getWork(t, store, task.ID)
	if tk.Status != StatusStopped {
		t.Errorf("task status = %q, want %q", tk.Status, StatusStopped)
	}
}

func TestAutoResumer_StopOrphanedWork_NeedsInput(t *testing.T) {
	store := newTestStore(t)
	resumer := NewAutoResumer(store, 3)

	story := createStory(t, store, "Story")
	startWorkWithSession(t, store, story.ID, "s1")

	// Transition to needs_input (simulates agent waiting for user)
	store.MarkNeedsInput(context.Background(), story.ID)

	resumer.StopOrphanedWork()

	s := getWork(t, store, story.ID)
	if s.Status != StatusStopped {
		t.Errorf("story status = %q, want %q (needs_input should be stopped on startup)", s.Status, StatusStopped)
	}
}

func TestAutoResumer_StopOrphanedWork_SkipsNonInProgress(t *testing.T) {
	store := newTestStore(t)
	resumer := NewAutoResumer(store, 3)

	story := createStory(t, store, "Story") // open
	task := createTask(t, store, story.ID, "Task")
	startWork(t, store, task.ID)
	doneWork(t, store, task.ID) // closed

	resumer.StopOrphanedWork()

	s := getWork(t, store, story.ID)
	if s.Status != StatusOpen {
		t.Errorf("story status = %q, want %q (should remain open)", s.Status, StatusOpen)
	}
	tk := getWork(t, store, task.ID)
	if tk.Status != StatusClosed {
		t.Errorf("task status = %q, want %q (should remain closed)", tk.Status, StatusClosed)
	}
}

func TestAutoResumer_StopOrphanedWork_SkipsDone(t *testing.T) {
	store := newTestStore(t)
	resumer := NewAutoResumer(store, 3)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	startWorkWithSession(t, store, story.ID, "s1")
	startWorkWithSession(t, store, task.ID, "s2")

	// Story done — stays done because task is in_progress
	doneWork(t, store, story.ID)
	if getWork(t, store, story.ID).Status != StatusDone {
		t.Fatal("precondition: story should be done")
	}

	resumer.StopOrphanedWork()

	// Story should remain done (orphan detection only targets in_progress/needs_input)
	s := getWork(t, store, story.ID)
	if s.Status != StatusDone {
		t.Errorf("story status = %q, want %q (done should not be stopped)", s.Status, StatusDone)
	}
	// Task was in_progress → should be stopped
	tk := getWork(t, store, task.ID)
	if tk.Status != StatusStopped {
		t.Errorf("task status = %q, want %q (in_progress should be stopped)", tk.Status, StatusStopped)
	}
}

// --- Shutdown edge cases ---

func TestAutoResumer_StopCancelsPendingContinuation(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)
	// Use a longer settle delay so we can cancel before it fires
	resumer.settleDelay = 500 * time.Millisecond

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	// Stop before settle delay completes
	time.Sleep(50 * time.Millisecond)
	resumer.Stop()

	// Wait long enough for the settle delay to have fired if not cancelled
	time.Sleep(600 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("expected no messages after Stop, but continuation was sent")
	}
}

func TestAutoResumer_StopIdempotent(t *testing.T) {
	_, resumer, _ := setupResumerTest(t)

	// Should not panic when called multiple times
	resumer.Stop()
	resumer.Stop()
}

func TestAutoResumer_SendErrorAfterShutdownSuppressesLog(t *testing.T) {
	store := newTestStore(t)
	sender := &errSender{err: fmt.Errorf("connection closed")}
	resumer := NewAutoResumer(store, 3)
	resumer.settleDelay = 10 * time.Millisecond
	resumer.SetSender(sender)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	// Stop while the goroutine is in settle delay
	time.Sleep(5 * time.Millisecond)
	resumer.Stop()

	// Give time for any goroutine to complete
	time.Sleep(50 * time.Millisecond)
	// No panic or deadlock = pass
}

func TestAutoResumer_ConcurrentProcessStateChanges(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)
	const n = 5

	for i := 0; i < n; i++ {
		story := createStory(t, store, fmt.Sprintf("Story %d", i))
		sid := fmt.Sprintf("session-%d", i)
		startWorkWithSession(t, store, story.ID, sid)
	}

	// Fire all process state changes concurrently
	for i := 0; i < n; i++ {
		go resumer.HandleProcessStateChange(fmt.Sprintf("session-%d", i), "idle", false, false, false)
	}

	// All should eventually send messages
	waitFor(t, func() bool { return len(sender.getMessages()) >= n })

	msgs := sender.getMessages()
	if len(msgs) != n {
		t.Errorf("expected %d messages, got %d", n, len(msgs))
	}
}

func TestAutoResumer_ConcurrentOnWorkChange(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	// Setup: story with multiple tasks (create tasks BEFORE marking story done)
	story := createStory(t, store, "Story")
	parentSid := "parent-session"
	startWorkWithSession(t, store, story.ID, parentSid)

	tasks := make([]Work, 5)
	for i := range tasks {
		tasks[i] = createTask(t, store, story.ID, fmt.Sprintf("Task %d", i))
		startWork(t, store, tasks[i].ID)
	}

	doneWork(t, store, story.ID)

	// Fire concurrent child closed events. Only the first goroutine to read
	// the parent as done will transition it to in_progress and send a message;
	// the others see in_progress and skip. At least 1 message must be sent.
	for _, task := range tasks {
		go resumer.OnWorkChange(ChangeEvent{
			Op:   OperationUpdate,
			Work: Work{ID: task.ID, Status: StatusClosed, ParentID: story.ID, Title: task.Title},
		})
	}

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) < 1 {
		t.Error("expected at least 1 reactivation message")
	}

	parent := getWork(t, store, story.ID)
	if parent.Status != StatusInProgress {
		t.Errorf("parent status = %q, want %q", parent.Status, StatusInProgress)
	}
}

// errSender is a mock sender that always returns an error.
type errSender struct {
	err error
}

func (s *errSender) SendMessage(_ context.Context, _, _ string) error {
	return s.err
}

// --- Trigger D: step advance ---

// mockStepProvider provides step information for tests.
type mockStepProvider struct {
	steps map[string][]string // agentRoleID → steps
}

func (m *mockStepProvider) GetSteps(agentRoleID string) ([]string, error) {
	return m.steps[agentRoleID], nil
}

func TestAutoResumer_StepAdvance_TaskWithSteps(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Step 1: Do something", "Step 2: Do another thing", "Step 3: Finish up"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Mark done — task with no children becomes closed immediately due to autoClose
	doneWork(t, store, task.ID)

	// Fire work change event (simulate internal update)
	// Since autoClose promoted done→closed, we send a closed event
	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: false,
		Work:     Work{ID: task.ID, Type: WorkTypeTask, Status: StatusClosed, SessionID: sid, AgentRoleID: testRoleID, CurrentStep: 0},
	})

	waitFor(t, func() bool {
		w := getWork(t, store, task.ID)
		return w.CurrentStep == 1
	})

	w := getWork(t, store, task.ID)
	if w.CurrentStep != 1 {
		t.Errorf("current_step = %d, want 1", w.CurrentStep)
	}
	if w.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", w.Status, StatusInProgress)
	}

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].SessionID != sid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, sid)
	}
}

func TestAutoResumer_StepAdvance_NoSteps(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {}, // No steps
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	doneWork(t, store, task.ID)

	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: false,
		Work:     Work{ID: task.ID, Type: WorkTypeTask, Status: StatusClosed, SessionID: sid, AgentRoleID: testRoleID, CurrentStep: 0},
	})

	// Should not send any messages or advance step
	time.Sleep(50 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message when no steps defined")
	}
}

func TestAutoResumer_StepAdvance_LastStep(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Step 1", "Step 2"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	doneWork(t, store, task.ID)

	// Already at last step (current_step = 1, len(steps) = 2)
	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: false,
		Work:     Work{ID: task.ID, Type: WorkTypeTask, Status: StatusClosed, SessionID: sid, AgentRoleID: testRoleID, CurrentStep: 1},
	})

	// Should not send any messages or advance step
	time.Sleep(50 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message when already at last step")
	}
}

func TestAutoResumer_StepAdvance_StoryIgnored(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Step 1", "Step 2"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	doneWork(t, store, story.ID)

	// Stories should be ignored for step advance
	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: false,
		Work:     Work{ID: story.ID, Type: WorkTypeStory, Status: StatusDone, SessionID: sid, AgentRoleID: testRoleID, CurrentStep: 0},
	})

	time.Sleep(50 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("should not send step advance message for stories")
	}
}

func TestAutoResumer_StepAdvance_ExternalIgnored(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Step 1", "Step 2"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	doneWork(t, store, task.ID)

	// External events should be ignored
	resumer.OnWorkChange(ChangeEvent{
		Op:       OperationUpdate,
		External: true,
		Work:     Work{ID: task.ID, Type: WorkTypeTask, Status: StatusClosed, SessionID: sid, AgentRoleID: testRoleID, CurrentStep: 0},
	})

	time.Sleep(50 * time.Millisecond)
	if len(sender.getMessages()) != 0 {
		t.Error("should not send step advance message for external events")
	}
}

// --- Auto-continuation with step context ---

func TestAutoResumer_AutoContinuation_WithSteps(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Implement feature", "Write tests", "Update docs"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Simulate agent idle without calling work_done
	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}

	// Message should contain step context and step completion check prompt
	msg := msgs[0].Content
	if !containsAll(msg, "## Current Step", "Step 1 of 3", "Implement feature") {
		t.Error("message should contain current step context")
	}
	if !containsAll(msg, "interrupted while working on step", "If YES: Call work_done", "If NO: Continue working") {
		t.Error("message should contain step completion check prompt")
	}
}

func TestAutoResumer_AutoContinuation_WithoutSteps(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	// No step provider set
	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}

	// Message should be the standard auto-continuation message (no step info)
	msg := msgs[0].Content
	if containsAll(msg, "## Current Step") {
		t.Error("message should NOT contain step context when no steps defined")
	}
	if !containsAll(msg, "still in_progress but your session was interrupted") {
		t.Error("message should contain standard auto-continuation nudge")
	}
}

func TestAutoResumer_AutoContinuation_StoryIgnoresSteps(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	sp := &mockStepProvider{
		steps: map[string][]string{
			testRoleID: {"Step 1", "Step 2"},
		},
	}
	resumer.SetStepProvider(sp)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}

	// Stories should use standard message (steps don't apply)
	msg := msgs[0].Content
	if containsAll(msg, "## Current Step") {
		t.Error("story message should NOT contain step context")
	}
	if !containsAll(msg, "Your story is still in_progress") {
		t.Error("story message should contain standard auto-continuation nudge")
	}
}

// containsAll returns true if s contains all substrings.
func containsAll(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if !strings.Contains(s, sub) {
			return false
		}
	}
	return true
}
