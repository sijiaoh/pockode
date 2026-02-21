package work

import (
	"context"
	"fmt"
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

	resumer.HandleProcessStateChange(sid, "idle", false, false)

	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })

	msgs := sender.getMessages()
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message, got %d", len(msgs))
	}
	if msgs[0].SessionID != sid {
		t.Errorf("sessionID = %q, want %q", msgs[0].SessionID, sid)
	}
}

func TestAutoResumer_IgnoresRunningState(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "running", false, false)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message for running state")
	}
}

func TestAutoResumer_IgnoresInitialIdle(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, true)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message for initial idle on process creation")
	}
}

func TestAutoResumer_IgnoresNeedsInput(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", true, false)

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
	resumer.HandleProcessStateChange(sid, "idle", false, false)

	time.Sleep(50 * time.Millisecond) // negative assertion: verify no panic
}

func TestAutoResumer_RetryLimit(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	// Exhaust retries (maxRetries=3)
	for i := 0; i < 4; i++ {
		resumer.HandleProcessStateChange(sid, "idle", false, false)
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
}

func TestAutoResumer_RetryResetOnCompletion(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)

	story := createStory(t, store, "Story")
	task := createTask(t, store, story.ID, "Task")
	sid := "session-1"
	startWorkWithSession(t, store, task.ID, sid)

	// Use 2 retries
	resumer.HandleProcessStateChange(sid, "idle", false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 1 })
	resumer.HandleProcessStateChange(sid, "idle", false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 2 })

	if len(sender.getMessages()) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(sender.getMessages()))
	}

	// Complete → resets retry count
	resumer.OnWorkChange(ChangeEvent{Op: OperationUpdate, Work: Work{
		ID: task.ID, Status: StatusDone, SessionID: sid,
	}})

	// Re-open task for more work
	status := StatusInProgress
	store.Update(context.Background(), task.ID, UpdateFields{Status: &status})

	// Should be able to retry again from 0
	resumer.HandleProcessStateChange(sid, "idle", false, false)
	waitFor(t, func() bool { return len(sender.getMessages()) >= 3 })

	if len(sender.getMessages()) != 3 {
		t.Errorf("expected 3 messages (retry reset), got %d", len(sender.getMessages()))
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
	resumer.HandleProcessStateChange(sid, "idle", false, false)
	time.Sleep(50 * time.Millisecond) // negative assertion: verify nothing fires
	if len(sender.getMessages()) != 0 {
		t.Error("should not send message when work is already done/closed")
	}
}

// --- Trigger B: parent reactivation ---

func TestAutoResumer_ReactivatesParent(t *testing.T) {
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

	// Parent should be reactivated to in_progress
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

// --- Shutdown edge cases ---

func TestAutoResumer_StopCancelsPendingContinuation(t *testing.T) {
	store, resumer, sender := setupResumerTest(t)
	// Use a longer settle delay so we can cancel before it fires
	resumer.settleDelay = 500 * time.Millisecond

	story := createStory(t, store, "Story")
	sid := "session-1"
	startWorkWithSession(t, store, story.ID, sid)

	resumer.HandleProcessStateChange(sid, "idle", false, false)

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

	resumer.HandleProcessStateChange(sid, "idle", false, false)

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
		go resumer.HandleProcessStateChange(fmt.Sprintf("session-%d", i), "idle", false, false)
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

	// Fire concurrent child closed events — only one reactivation should succeed
	// because after the first reactivation the parent is in_progress, not done.
	for _, task := range tasks {
		go resumer.OnWorkChange(ChangeEvent{
			Op:   OperationUpdate,
			Work: Work{ID: task.ID, Status: StatusClosed, ParentID: story.ID, Title: task.Title},
		})
	}

	// Wait for goroutines to complete
	time.Sleep(100 * time.Millisecond)

	msgs := sender.getMessages()
	// Only one reactivation message should have been sent because the parent
	// transitions from done → in_progress on the first call; subsequent calls
	// see in_progress and skip.
	if len(msgs) != 1 {
		t.Errorf("expected 1 reactivation message (concurrent dedup), got %d", len(msgs))
	}
}

// errSender is a mock sender that always returns an error.
type errSender struct {
	err error
}

func (s *errSender) SendMessage(_ context.Context, _, _ string) error {
	return s.err
}
