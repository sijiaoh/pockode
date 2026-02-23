package work

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func newTestStore(t *testing.T) *FileStore {
	t.Helper()
	store, err := NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	return store
}

// testRoleID is a dummy agent_role_id used in tests.
const testRoleID = "test-role-id"

func createStory(t *testing.T, s *FileStore, title string) Work {
	t.Helper()
	w, err := s.Create(context.Background(), Work{Type: WorkTypeStory, Title: title, AgentRoleID: testRoleID})
	if err != nil {
		t.Fatalf("Create story %q: %v", title, err)
	}
	return w
}

func createTask(t *testing.T, s *FileStore, parentID, title string) Work {
	t.Helper()
	w, err := s.Create(context.Background(), Work{Type: WorkTypeTask, ParentID: parentID, Title: title, AgentRoleID: testRoleID})
	if err != nil {
		t.Fatalf("Create task %q: %v", title, err)
	}
	return w
}

func startWork(t *testing.T, s *FileStore, id string) {
	t.Helper()
	status := StatusInProgress
	if err := s.Update(context.Background(), id, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("Start work %s: %v", id, err)
	}
}

// startWorkWithSession transitions to in_progress and links a session atomically,
// matching the real handleWorkStart pattern.
func startWorkWithSession(t *testing.T, s *FileStore, id, sessionID string) {
	t.Helper()
	status := StatusInProgress
	if err := s.Update(context.Background(), id, UpdateFields{
		Status:    &status,
		SessionID: &sessionID,
	}); err != nil {
		t.Fatalf("Start work %s with session %s: %v", id, sessionID, err)
	}
}

func doneWork(t *testing.T, s *FileStore, id string) {
	t.Helper()
	status := StatusDone
	if err := s.Update(context.Background(), id, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("Done work %s: %v", id, err)
	}
}

func getWork(t *testing.T, s *FileStore, id string) Work {
	t.Helper()
	w, found, err := s.Get(id)
	if err != nil {
		t.Fatalf("Get %s: %v", id, err)
	}
	if !found {
		t.Fatalf("Get %s: not found", id)
	}
	return w
}

// --- CRUD ---

func TestCreate_Story(t *testing.T) {
	s := newTestStore(t)

	story := createStory(t, s, "Login feature")

	if story.Type != WorkTypeStory {
		t.Errorf("type = %q, want %q", story.Type, WorkTypeStory)
	}
	if story.Title != "Login feature" {
		t.Errorf("title = %q, want %q", story.Title, "Login feature")
	}
	if story.Status != StatusOpen {
		t.Errorf("status = %q, want %q", story.Status, StatusOpen)
	}
	if story.ID == "" {
		t.Error("expected non-empty ID")
	}
}

func TestCreate_Task(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")

	task := createTask(t, s, story.ID, "Subtask")

	if task.ParentID != story.ID {
		t.Errorf("parent_id = %q, want %q", task.ParentID, story.ID)
	}
}

func TestCreate_TaskRequiresParent(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create(context.Background(), Work{Type: WorkTypeTask, Title: "Orphan", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for task without parent")
	}
}

func TestCreate_TaskCannotBeUnderTask(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")
	task := createTask(t, s, story.ID, "Task")

	_, err := s.Create(context.Background(), Work{Type: WorkTypeTask, ParentID: task.ID, Title: "Sub-task", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for task under task")
	}
}

func TestCreate_StoryMustBeTopLevel(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Parent")

	_, err := s.Create(context.Background(), Work{Type: WorkTypeStory, ParentID: story.ID, Title: "Nested story", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for nested story")
	}
}

func TestCreate_TaskUnderClosedParent(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")
	startWork(t, s, story.ID)
	doneWork(t, s, story.ID) // auto-closes (no children)

	if getWork(t, s, story.ID).Status != StatusClosed {
		t.Fatal("precondition: story should be closed")
	}

	_, err := s.Create(context.Background(), Work{Type: WorkTypeTask, ParentID: story.ID, Title: "Late task", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for task under closed parent")
	}
}

func TestCreate_AgentRoleIDRequired(t *testing.T) {
	s := newTestStore(t)

	// Story without agent_role_id
	_, err := s.Create(context.Background(), Work{Type: WorkTypeStory, Title: "No role"})
	if err == nil {
		t.Fatal("expected error for story without agent_role_id")
	}

	// Task without agent_role_id
	story := createStory(t, s, "Parent")
	_, err = s.Create(context.Background(), Work{Type: WorkTypeTask, ParentID: story.ID, Title: "No role task"})
	if err == nil {
		t.Fatal("expected error for task without agent_role_id")
	}
}

func TestCreate_InvalidType(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create(context.Background(), Work{Type: "epic", Title: "X", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for invalid type")
	}
}

func TestCreate_EmptyTitle(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create(context.Background(), Work{Type: WorkTypeStory, Title: "", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for empty title")
	}
}

func TestList(t *testing.T) {
	s := newTestStore(t)

	works, _ := s.List()
	if len(works) != 0 {
		t.Fatalf("expected empty list, got %d", len(works))
	}

	createStory(t, s, "A")
	createStory(t, s, "B")

	works, _ = s.List()
	if len(works) != 2 {
		t.Fatalf("expected 2, got %d", len(works))
	}
}

func TestUpdate_Title(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Old")

	newTitle := "New"
	if err := s.Update(context.Background(), story.ID, UpdateFields{Title: &newTitle}); err != nil {
		t.Fatal(err)
	}

	got := getWork(t, s, story.ID)
	if got.Title != "New" {
		t.Errorf("title = %q, want %q", got.Title, "New")
	}
}

func TestUpdate_SessionID_RequiresStatusTransition(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// Setting SessionID without status change should fail
	sid := "session-1"
	err := s.Update(context.Background(), story.ID, UpdateFields{SessionID: &sid})
	if err == nil {
		t.Fatal("expected error when setting session_id without status transition")
	}
}

func TestUpdate_SessionID_SetOnStart(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	// Setting SessionID with open → in_progress should succeed
	sid := "session-1"
	status := StatusInProgress
	err := s.Update(context.Background(), story.ID, UpdateFields{
		SessionID: &sid,
		Status:    &status,
	})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.SessionID != sid {
		t.Errorf("session_id = %q, want %q", got.SessionID, sid)
	}
}

func TestUpdate_SessionID_ClearOnRollback(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")

	// Clearing SessionID with in_progress → open should succeed
	empty := ""
	status := StatusOpen
	err := s.Update(context.Background(), story.ID, UpdateFields{
		SessionID: &empty,
		Status:    &status,
	})
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.SessionID != "" {
		t.Errorf("session_id = %q, want empty", got.SessionID)
	}
}

func TestDelete(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "X")

	if err := s.Delete(context.Background(), story.ID); err != nil {
		t.Fatal(err)
	}

	_, found, _ := s.Get(story.ID)
	if found {
		t.Error("expected work to be deleted")
	}
}

func TestDelete_WithChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")
	task := createTask(t, s, story.ID, "Task")

	if err := s.Delete(context.Background(), story.ID); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if _, found, _ := s.Get(story.ID); found {
		t.Error("expected story to be deleted")
	}
	if _, found, _ := s.Get(task.ID); found {
		t.Error("expected child task to be cascade-deleted")
	}
}

func TestDelete_NotFound(t *testing.T) {
	s := newTestStore(t)
	if err := s.Delete(context.Background(), "nonexistent"); err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

// --- Status transitions ---

func TestTransition_OpenToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	got := getWork(t, s, story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

func TestTransition_InProgressToDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// Story with no children: done → auto-close → closed
	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q (auto-close)", got.Status, StatusClosed)
	}
}

func TestTransition_Invalid_OpenToDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	status := StatusDone
	err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status})
	if err == nil {
		t.Fatal("expected error for open → done")
	}
}

func TestTransition_InProgressToOpen(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	status := StatusOpen
	err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status})
	if err != nil {
		t.Fatalf("in_progress → open should be valid (rollback): %v", err)
	}

	w, _, _ := s.Get(story.ID)
	if w.Status != StatusOpen {
		t.Fatalf("expected open, got %s", w.Status)
	}
}

func TestTransition_Invalid_SetClosedDirectly(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	status := StatusClosed
	err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status})
	if err == nil {
		t.Fatal("expected error for setting closed directly")
	}
}

func TestTransition_DoneToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// Create a child task so story doesn't auto-close
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, task.ID)

	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusDone {
		t.Fatalf("status = %q, want %q (child still open)", got.Status, StatusDone)
	}

	// Re-activate parent (done → in_progress)
	status := StatusInProgress
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("done → in_progress: %v", err)
	}
	got = getWork(t, s, story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

// --- stopped / closed restart transitions ---

func TestTransition_StoppedToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// in_progress → stopped
	status := StatusStopped
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("in_progress → stopped: %v", err)
	}

	// stopped → in_progress (restart)
	status = StatusInProgress
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("stopped → in_progress: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

func TestTransition_ClosedToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)
	doneWork(t, s, story.ID) // no children → auto-close → closed

	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Fatalf("precondition: story should be closed, got %q", got.Status)
	}

	// closed → in_progress (parent reactivation)
	status := StatusInProgress
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("closed → in_progress: %v", err)
	}
	got = getWork(t, s, story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

func TestMarkDone_FromStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// in_progress → stopped
	status := StatusStopped
	s.Update(context.Background(), story.ID, UpdateFields{Status: &status})

	// MarkDone from stopped should fail (stopped → done is not valid)
	if err := s.MarkDone(context.Background(), story.ID); err == nil {
		t.Fatal("expected error for MarkDone from stopped")
	}
}

// --- needs_input transitions ---

func TestTransition_InProgressToNeedsInput(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	status := StatusNeedsInput
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err != nil {
		t.Fatalf("in_progress → needs_input: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusNeedsInput {
		t.Errorf("status = %q, want %q", got.Status, StatusNeedsInput)
	}
}

func TestTransition_NeedsInputToInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	niStatus := StatusNeedsInput
	s.Update(context.Background(), story.ID, UpdateFields{Status: &niStatus})

	ipStatus := StatusInProgress
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &ipStatus}); err != nil {
		t.Fatalf("needs_input → in_progress: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

func TestTransition_NeedsInputToStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	niStatus := StatusNeedsInput
	s.Update(context.Background(), story.ID, UpdateFields{Status: &niStatus})

	stoppedStatus := StatusStopped
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &stoppedStatus}); err != nil {
		t.Fatalf("needs_input → stopped: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusStopped {
		t.Errorf("status = %q, want %q", got.Status, StatusStopped)
	}
}

func TestTransition_Invalid_NeedsInputToDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	niStatus := StatusNeedsInput
	s.Update(context.Background(), story.ID, UpdateFields{Status: &niStatus})

	doneStatus := StatusDone
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &doneStatus}); err == nil {
		t.Fatal("expected error for needs_input → done")
	}
}

func TestTransition_Invalid_OpenToNeedsInput(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	status := StatusNeedsInput
	if err := s.Update(context.Background(), story.ID, UpdateFields{Status: &status}); err == nil {
		t.Fatal("expected error for open → needs_input")
	}
}

func TestAutoClose_BlockedByNeedsInputChild(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Put task in needs_input
	niStatus := StatusNeedsInput
	s.Update(context.Background(), task.ID, UpdateFields{Status: &niStatus})

	// Parent done — but task is needs_input, so parent stays done (not closed)
	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusDone {
		t.Errorf("story status = %q, want %q (child needs_input blocks auto-close)", got.Status, StatusDone)
	}
}

func TestAutoClose_BlockedByStoppedChild(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Stop the task (simulates agent crash or retry limit)
	stoppedStatus := StatusStopped
	s.Update(context.Background(), task.ID, UpdateFields{Status: &stoppedStatus})

	// Parent done — but task is stopped, so parent stays done (not closed)
	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusDone {
		t.Errorf("story status = %q, want %q (stopped child blocks auto-close)", got.Status, StatusDone)
	}
}

// --- MarkDone (atomic open/in_progress → done) ---

func TestMarkDone_FromOpen(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	if err := s.MarkDone(context.Background(), story.ID); err != nil {
		t.Fatalf("MarkDone from open: %v", err)
	}
	// No children → auto-closes
	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestMarkDone_FromInProgress(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	if err := s.MarkDone(context.Background(), story.ID); err != nil {
		t.Fatalf("MarkDone from in_progress: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestMarkDone_FromClosed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	s.MarkDone(context.Background(), story.ID) // open → closed

	err := s.MarkDone(context.Background(), story.ID)
	if err == nil {
		t.Fatal("expected error for closed → done")
	}
}

func TestMarkDone_NotFound(t *testing.T) {
	s := newTestStore(t)
	err := s.MarkDone(context.Background(), "nonexistent")
	if err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

func TestMarkDone_ChildClosesButParentStaysDone(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	doneWork(t, s, story.ID) // story stays done (task still open)

	if err := s.MarkDone(context.Background(), task.ID); err != nil {
		t.Fatalf("MarkDone task: %v", err)
	}

	if getWork(t, s, task.ID).Status != StatusClosed {
		t.Error("task should be closed")
	}
	// Parent stays done — reactivation is handled by AutoResumer
	if getWork(t, s, story.ID).Status != StatusDone {
		t.Errorf("story should stay done (awaiting review), got %q", getWork(t, s, story.ID).Status)
	}
}

// --- Auto-close ---

func TestAutoClose_TaskDoneImmediatelyClosed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, task.ID)

	doneWork(t, s, task.ID)

	got := getWork(t, s, task.ID)
	if got.Status != StatusClosed {
		t.Errorf("task status = %q, want %q (no children → immediate close)", got.Status, StatusClosed)
	}
}

func TestAutoClose_StoryWithPendingChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Story done, but task is in_progress → stays done
	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusDone {
		t.Errorf("story status = %q, want %q", got.Status, StatusDone)
	}
}

func TestAutoClose_StoryDoneWhenAllChildrenAlreadyClosed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Close the child first
	doneWork(t, s, task.ID)
	if getWork(t, s, task.ID).Status != StatusClosed {
		t.Fatal("precondition: task should be closed")
	}

	// Story done with all children already closed → auto-closes immediately
	doneWork(t, s, story.ID)
	if getWork(t, s, story.ID).Status != StatusClosed {
		t.Errorf("story should auto-close when done with all children closed, got %q", getWork(t, s, story.ID).Status)
	}
}

func TestAutoClose_ParentStaysDoneWhenChildrenClose(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task1 := createTask(t, s, story.ID, "T1")
	task2 := createTask(t, s, story.ID, "T2")
	startWork(t, s, story.ID)
	startWork(t, s, task1.ID)
	startWork(t, s, task2.ID)

	// Mark story as done first (won't close because children pending)
	doneWork(t, s, story.ID)

	// Complete task1 → closed; parent stays done (awaiting review)
	doneWork(t, s, task1.ID)
	if getWork(t, s, task1.ID).Status != StatusClosed {
		t.Error("task1 should be closed")
	}
	if getWork(t, s, story.ID).Status != StatusDone {
		t.Errorf("story should stay done while task2 is running, got %q", getWork(t, s, story.ID).Status)
	}

	// Complete task2 → closed; parent stays done (AutoResumer handles reactivation)
	doneWork(t, s, task2.ID)
	if getWork(t, s, task2.ID).Status != StatusClosed {
		t.Error("task2 should be closed")
	}
	if getWork(t, s, story.ID).Status != StatusDone {
		t.Errorf("story should stay done (awaiting review), got %q", getWork(t, s, story.ID).Status)
	}
}

// --- Persistence ---

func TestPersistence(t *testing.T) {
	dir := t.TempDir()

	s1, _ := NewFileStore(dir)
	story := createStory(t, s1, "Persistent")
	startWork(t, s1, story.ID)

	// Re-open from same directory
	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}

	got := getWork(t, s2, story.ID)
	if got.Title != "Persistent" {
		t.Errorf("title = %q, want %q", got.Title, "Persistent")
	}
	if got.Status != StatusInProgress {
		t.Errorf("status = %q, want %q", got.Status, StatusInProgress)
	}
}

// --- Listener ---

func TestListener_Events(t *testing.T) {
	s := newTestStore(t)

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	story := createStory(t, s, "S")
	if len(events) != 1 || events[0].Op != OperationCreate {
		t.Fatalf("expected 1 create event, got %d events", len(events))
	}

	newTitle := "Updated"
	s.Update(context.Background(), story.ID, UpdateFields{Title: &newTitle})
	if len(events) != 2 || events[1].Op != OperationUpdate {
		t.Fatalf("expected update event, got %d events", len(events))
	}

	s.Delete(context.Background(), story.ID)
	if len(events) != 3 || events[2].Op != OperationDelete {
		t.Fatalf("expected delete event, got %d events", len(events))
	}
}

func TestListener_ChildCloseDoesNotFireParentEvent(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)
	doneWork(t, s, story.ID)

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	// Task done → auto-close; parent stays done (awaiting review via AutoResumer)
	doneWork(t, s, task.ID)

	if len(events) != 1 {
		t.Fatalf("expected 1 event (task closed only), got %d", len(events))
	}

	taskEvent := findEvent(events, task.ID)
	if taskEvent == nil || taskEvent.Work.Status != StatusClosed {
		t.Error("expected task event with status=closed")
	}
}

// --- Concurrent operations ---

func TestConcurrent_CreateStories(t *testing.T) {
	s := newTestStore(t)
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.Create(context.Background(), Work{
				Type:        WorkTypeStory,
				Title:       fmt.Sprintf("Story %d", i),
				AgentRoleID: testRoleID,
			})
			errs <- err
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Create failed: %v", err)
		}
	}

	works, _ := s.List()
	if len(works) != n {
		t.Errorf("expected %d works, got %d", n, len(works))
	}

	// Verify all IDs are unique
	ids := make(map[string]bool)
	for _, w := range works {
		if ids[w.ID] {
			t.Errorf("duplicate ID: %s", w.ID)
		}
		ids[w.ID] = true
	}
}

func TestConcurrent_CreateTasksUnderStory(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Parent")
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.Create(context.Background(), Work{
				Type:        WorkTypeTask,
				ParentID:    story.ID,
				Title:       fmt.Sprintf("Task %d", i),
				AgentRoleID: testRoleID,
			})
			errs <- err
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Create task failed: %v", err)
		}
	}

	works, _ := s.List()
	// 1 story + n tasks
	if len(works) != n+1 {
		t.Errorf("expected %d works, got %d", n+1, len(works))
	}
}

func TestConcurrent_UpdateSameWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Original")
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			title := fmt.Sprintf("Title %d", i)
			errs <- s.Update(context.Background(), story.ID, UpdateFields{Title: &title})
		}(i)
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Update failed: %v", err)
		}
	}

	got := getWork(t, s, story.ID)
	if got.Title == "Original" {
		t.Error("title should have been updated")
	}
}

func TestConcurrent_DeleteDifferentWorks(t *testing.T) {
	s := newTestStore(t)
	const n = 20

	ids := make([]string, n)
	for i := 0; i < n; i++ {
		w := createStory(t, s, fmt.Sprintf("Story %d", i))
		ids[i] = w.ID
	}

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(id string) {
			errs <- s.Delete(context.Background(), id)
		}(ids[i])
	}

	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Errorf("Delete failed: %v", err)
		}
	}

	works, _ := s.List()
	if len(works) != 0 {
		t.Errorf("expected 0 works, got %d", len(works))
	}
}

func TestConcurrent_MixedOperations(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Base story")
	const n = 10

	done := make(chan struct{}, n*3)

	// Concurrent creates
	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			s.Create(context.Background(), Work{
				Type:        WorkTypeTask,
				ParentID:    story.ID,
				Title:       fmt.Sprintf("Task %d", i),
				AgentRoleID: testRoleID,
			})
		}(i)
	}

	// Concurrent title updates on the story
	for i := 0; i < n; i++ {
		go func(i int) {
			defer func() { done <- struct{}{} }()
			title := fmt.Sprintf("Story v%d", i)
			s.Update(context.Background(), story.ID, UpdateFields{Title: &title})
		}(i)
	}

	// Concurrent reads
	for i := 0; i < n; i++ {
		go func() {
			defer func() { done <- struct{}{} }()
			s.List()
		}()
	}

	for i := 0; i < n*3; i++ {
		<-done
	}

	// Just verify the store is consistent (no panic, no corruption)
	works, err := s.List()
	if err != nil {
		t.Fatalf("List after mixed ops: %v", err)
	}
	// At least the original story should exist
	if len(works) < 1 {
		t.Error("expected at least 1 work item")
	}
}

func TestConcurrent_StartSameWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Race")
	const n = 10

	results := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			status := StatusInProgress
			sid := fmt.Sprintf("session-%d", i)
			results <- s.Update(context.Background(), story.ID, UpdateFields{
				Status:    &status,
				SessionID: &sid,
			})
		}(i)
	}

	var successes, failures int
	for i := 0; i < n; i++ {
		if err := <-results; err != nil {
			failures++
		} else {
			successes++
		}
	}

	// Exactly one should succeed (open → in_progress), rest fail (in_progress → in_progress is invalid)
	if successes != 1 {
		t.Errorf("expected exactly 1 success, got %d successes and %d failures", successes, failures)
	}
}

// --- diffWorks ---

func TestDiffWorks_NoChanges(t *testing.T) {
	works := []Work{
		{ID: "1", Title: "A", Status: StatusOpen},
		{ID: "2", Title: "B", Status: StatusOpen},
	}
	events := diffWorks(works, works)
	if len(events) != 0 {
		t.Errorf("expected 0 events, got %d", len(events))
	}
}

func TestDiffWorks_Create(t *testing.T) {
	old := []Work{{ID: "1", Title: "A", Status: StatusOpen}}
	updated := []Work{
		{ID: "1", Title: "A", Status: StatusOpen},
		{ID: "2", Title: "B", Status: StatusOpen},
	}
	events := diffWorks(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationCreate || events[0].Work.ID != "2" {
		t.Errorf("expected create event for ID 2, got %+v", events[0])
	}
}

func TestDiffWorks_Delete(t *testing.T) {
	old := []Work{
		{ID: "1", Title: "A", Status: StatusOpen},
		{ID: "2", Title: "B", Status: StatusOpen},
	}
	updated := []Work{{ID: "1", Title: "A", Status: StatusOpen}}
	events := diffWorks(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationDelete || events[0].Work.ID != "2" {
		t.Errorf("expected delete event for ID 2, got %+v", events[0])
	}
}

func TestDiffWorks_Update(t *testing.T) {
	old := []Work{{ID: "1", Title: "A", Status: StatusOpen}}
	updated := []Work{{ID: "1", Title: "A Updated", Status: StatusOpen}}
	events := diffWorks(old, updated)
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationUpdate || events[0].Work.Title != "A Updated" {
		t.Errorf("expected update event with new title, got %+v", events[0])
	}
}

func TestDiffWorks_Mixed(t *testing.T) {
	old := []Work{
		{ID: "1", Title: "Keep", Status: StatusOpen},
		{ID: "2", Title: "Delete", Status: StatusOpen},
		{ID: "3", Title: "Update Me", Status: StatusOpen},
	}
	updated := []Work{
		{ID: "1", Title: "Keep", Status: StatusOpen},
		{ID: "3", Title: "Updated", Status: StatusInProgress},
		{ID: "4", Title: "New", Status: StatusOpen},
	}
	events := diffWorks(old, updated)

	// Should have: 1 delete (ID 2), 1 update (ID 3), 1 create (ID 4)
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}

	ops := make(map[Operation]int)
	for _, e := range events {
		ops[e.Op]++
	}
	if ops[OperationDelete] != 1 || ops[OperationUpdate] != 1 || ops[OperationCreate] != 1 {
		t.Errorf("expected 1 of each op type, got %v", ops)
	}
}

// --- Comments ---

func TestAddComment(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	c, err := s.AddComment(context.Background(), story.ID, "hello")
	if err != nil {
		t.Fatalf("AddComment: %v", err)
	}
	if c.ID == "" {
		t.Error("expected non-empty comment ID")
	}
	if c.WorkID != story.ID {
		t.Errorf("work_id = %q, want %q", c.WorkID, story.ID)
	}
	if c.Body != "hello" {
		t.Errorf("body = %q, want %q", c.Body, "hello")
	}
}

func TestAddComment_WorkNotFound(t *testing.T) {
	s := newTestStore(t)
	_, err := s.AddComment(context.Background(), "nonexistent", "hello")
	if err == nil {
		t.Fatal("expected error for nonexistent work")
	}
}

func TestListComments(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	comments, _ := s.ListComments(story.ID)
	if len(comments) != 0 {
		t.Fatalf("expected empty list, got %d", len(comments))
	}

	s.AddComment(context.Background(), story.ID, "first")
	s.AddComment(context.Background(), story.ID, "second")

	comments, _ = s.ListComments(story.ID)
	if len(comments) != 2 {
		t.Fatalf("expected 2 comments, got %d", len(comments))
	}
	if comments[0].Body != "first" || comments[1].Body != "second" {
		t.Errorf("unexpected comment bodies: %q, %q", comments[0].Body, comments[1].Body)
	}
}

func TestListComments_FilterByWorkID(t *testing.T) {
	s := newTestStore(t)
	story1 := createStory(t, s, "S1")
	story2 := createStory(t, s, "S2")

	s.AddComment(context.Background(), story1.ID, "on s1")
	s.AddComment(context.Background(), story2.ID, "on s2")

	comments, _ := s.ListComments(story1.ID)
	if len(comments) != 1 || comments[0].Body != "on s1" {
		t.Errorf("expected 1 comment for s1, got %d", len(comments))
	}
}

func TestComments_Persistence(t *testing.T) {
	dir := t.TempDir()

	s1, _ := NewFileStore(dir)
	story := createStory(t, s1, "S")
	s1.AddComment(context.Background(), story.ID, "persisted")

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}

	comments, _ := s2.ListComments(story.ID)
	if len(comments) != 1 || comments[0].Body != "persisted" {
		t.Fatalf("expected persisted comment, got %v", comments)
	}
}

// --- FindBySessionID ---

func TestFindBySessionID_Found(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWorkWithSession(t, s, task.ID, "sess-1")

	w, found, err := s.FindBySessionID("sess-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !found {
		t.Fatal("expected to find work by session ID")
	}
	if w.ID != task.ID {
		t.Errorf("expected work ID %s, got %s", task.ID, w.ID)
	}
}

func TestFindBySessionID_NotFound(t *testing.T) {
	s := newTestStore(t)
	createStory(t, s, "S")

	_, found, err := s.FindBySessionID("nonexistent")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if found {
		t.Error("expected not found")
	}
}

// --- Test helpers ---

type listenerFunc func(ChangeEvent)

func (f listenerFunc) OnWorkChange(e ChangeEvent) { f(e) }

func findEvent(events []ChangeEvent, workID string) *ChangeEvent {
	for i := range events {
		if events[i].Work.ID == workID {
			return &events[i]
		}
	}
	return nil
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("timed out waiting for condition")
}
