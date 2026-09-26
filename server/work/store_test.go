package work

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
	w, err := s.Create(context.Background(), Work{Title: title, AgentRoleID: testRoleID})
	if err != nil {
		t.Fatalf("Create story %q: %v", title, err)
	}
	return w
}

func createTask(t *testing.T, s *FileStore, storyID, title string) Work {
	t.Helper()
	w, err := s.Create(context.Background(), Work{StoryID: storyID, Title: title, AgentRoleID: testRoleID})
	if err != nil {
		t.Fatalf("Create task %q: %v", title, err)
	}
	return w
}

func startWork(t *testing.T, s *FileStore, id string) {
	t.Helper()
	if _, err := s.Start(context.Background(), id, ""); err != nil {
		t.Fatalf("Start work %s: %v", id, err)
	}
}

// startWorkWithSession transitions to active with a known sessionID, for
// tests that need a deterministic session to assert against.
func startWorkWithSession(t *testing.T, s *FileStore, id, sessionID string) {
	t.Helper()
	if _, err := s.Start(context.Background(), id, sessionID); err != nil {
		t.Fatalf("Start work %s with session %s: %v", id, sessionID, err)
	}
}

func doneWork(t *testing.T, s *FileStore, id string) {
	t.Helper()
	w := getWork(t, s, id)
	if w.Status == StatusOpen {
		startWork(t, s, id)
	}
	if _, err := s.StepDone(context.Background(), id, 0); err != nil {
		t.Fatalf("complete work %s: %v", id, err)
	}
}

// setChildWait parks a work on its subtasks, failing the test if the store
// refuses — which it does whenever none of them is active, and which is a fixture
// mistake rather than the thing under test.
func setChildWait(t *testing.T, s *FileStore, id string) {
	t.Helper()
	set, err := s.SetChildWait(context.Background(), id)
	if err != nil {
		t.Fatalf("SetChildWait %s: %v", id, err)
	}
	if !set {
		t.Fatalf("SetChildWait %s: refused; the fixture has no active subtask", id)
	}
}

// waitOnChild gives a story a running subtask and parks it on that subtask. Two
// steps rather than one because a `child` wait is only ever set when there is a
// child to wait for, which is the rule SetChildWait exists to enforce.
func waitOnChild(t *testing.T, s *FileStore, storyID string) {
	t.Helper()
	child := createTask(t, s, storyID, "Reducer")
	startWork(t, s, child.ID)
	setChildWait(t, s, storyID)
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

	if story.Type() != WorkTypeStory {
		t.Errorf("type = %q, want %q", story.Type(), WorkTypeStory)
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

	task := createTask(t, s, story.ID, "Task")

	if task.StoryID != story.ID {
		t.Errorf("story_id = %q, want %q", task.StoryID, story.ID)
	}
}

// The only shape rule left: story_id must name a story. "A task needs a parent"
// and "a story must be top-level" are not testable any more — a work is
// whichever its story_id says, so neither can be asked for.
func TestCreate_StoryIDMustNameAStory(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")
	task := createTask(t, s, story.ID, "Task")

	_, err := s.Create(context.Background(), Work{StoryID: task.ID, Title: "Nested task", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for a task under a task")
	}
}

func TestCreate_StoryIDMustExist(t *testing.T) {
	s := newTestStore(t)

	_, err := s.Create(context.Background(), Work{StoryID: "nonexistent", Title: "Orphan", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for a task naming a story that does not exist")
	}
}

func TestCreate_TaskUnderClosedStory(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Story")
	startWork(t, s, story.ID)
	doneWork(t, s, story.ID) // auto-closes (no children)

	if getWork(t, s, story.ID).Status != StatusClosed {
		t.Fatal("precondition: story should be closed")
	}

	_, err := s.Create(context.Background(), Work{StoryID: story.ID, Title: "Late task", AgentRoleID: testRoleID})
	if err == nil {
		t.Fatal("expected error for a task under a closed story")
	}
}

func TestCreate_AgentRoleIDRequired(t *testing.T) {
	s := newTestStore(t)

	// Story without agent_role_id
	_, err := s.Create(context.Background(), Work{Title: "No role"})
	if err == nil {
		t.Fatal("expected error for story without agent_role_id")
	}

	// Task without agent_role_id
	story := createStory(t, s, "Story")
	_, err = s.Create(context.Background(), Work{StoryID: story.ID, Title: "No role task"})
	if err == nil {
		t.Fatal("expected error for task without agent_role_id")
	}
}

func TestCreate_EmptyTitle(t *testing.T) {
	s := newTestStore(t)
	_, err := s.Create(context.Background(), Work{Title: "", AgentRoleID: testRoleID})
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

func TestStart_SetsSessionID(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	w, err := s.Start(context.Background(), story.ID, "session-1")
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	if w.SessionID != "session-1" {
		t.Errorf("session_id = %q, want %q", w.SessionID, "session-1")
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want %q", w.Status, StatusActive)
	}
}

func TestClaim_FreshStartGeneratesSession(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	w, restart, err := s.Claim(context.Background(), story.ID, nil)
	if err != nil {
		t.Fatalf("Claim: %v", err)
	}
	if restart {
		t.Error("restart = true, want false for open → active")
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want %q", w.Status, StatusActive)
	}
	if w.SessionID == "" {
		t.Error("want a fresh sessionID")
	}
}

// A work that already owns a session is a restart, so its chat history survives.
func TestClaim_RestartReusesSession(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	first, _, err := s.Claim(context.Background(), story.ID, nil)
	if err != nil {
		t.Fatalf("first Claim: %v", err)
	}
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	again, restart, err := s.Claim(context.Background(), story.ID, nil)
	if err != nil {
		t.Fatalf("restart Claim: %v", err)
	}
	if !restart {
		t.Error("restart = false, want true for stopped → active")
	}
	if again.SessionID != first.SessionID {
		t.Errorf("session = %q, want reuse of %q", again.SessionID, first.SessionID)
	}
}

// A waiting work is active, and starting an active work a second time is the
// one thing ValidateStartable exists to refuse. The user is offered Stop for
// such a work, never Restart (docs/lifecycle-ui.md §3).
func TestClaim_RejectsAWaitingWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	if _, _, err := s.Claim(context.Background(), story.ID, nil); err != nil {
		t.Fatalf("first Claim: %v", err)
	}
	waitOnChild(t, s, story.ID)

	if _, _, err := s.Claim(context.Background(), story.ID, nil); err == nil {
		t.Fatal("Claim on a waiting work succeeded; it is already running")
	}
}

func TestClaim_RejectsAlreadyActive(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	if _, _, err := s.Claim(context.Background(), story.ID, nil); err != nil {
		t.Fatalf("first Claim: %v", err)
	}

	if _, _, err := s.Claim(context.Background(), story.ID, nil); !errors.Is(err, ErrInvalidWork) {
		t.Errorf("err = %v, want ErrInvalidWork", err)
	}
}

// A watched start records its watcher; a start without one leaves the watcher
// the story already has, and it survives the store being read back from disk.
func TestClaim_RecordsAWatcherAndKeepsItAcrossUnwatchedStarts(t *testing.T) {
	dir := t.TempDir()
	s, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	story := createStory(t, s, "S")
	watcher := Watcher{SessionID: "sess-watcher", Worktree: "feature-x"}

	if _, _, err := s.Claim(context.Background(), story.ID, &watcher); err != nil {
		t.Fatalf("watched Claim: %v", err)
	}
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if _, _, err := s.Claim(context.Background(), story.ID, nil); err != nil {
		t.Fatalf("unwatched Claim: %v", err)
	}

	reloaded, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if got := getWork(t, reloaded, story.ID).Watcher; got == nil || *got != watcher {
		t.Errorf("watcher = %+v, want %+v", got, watcher)
	}
}

// Closing is what the watch was for, so it releases the watcher in the same
// write — and says who it released, which is who the close is reported to.
func TestStepDone_ClosingReleasesTheWatcher(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	watcher := Watcher{SessionID: "sess-watcher"}
	if _, _, err := s.Claim(context.Background(), story.ID, &watcher); err != nil {
		t.Fatalf("Claim: %v", err)
	}
	var closing *ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		if e.Work.ID == story.ID && e.Work.Status == StatusClosed {
			closing = &e
		}
	}))

	if _, err := s.StepDone(context.Background(), story.ID, 0); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	if got := getWork(t, s, story.ID).Watcher; got != nil {
		t.Errorf("watcher = %+v after closing, want none", got)
	}
	if closing == nil || closing.PrevWatcher == nil || *closing.PrevWatcher != watcher {
		t.Errorf("closing event = %+v, want it to carry the released watcher %+v", closing, watcher)
	}
}

func TestClaim_RefusesToWatchATask(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")

	if _, _, err := s.Claim(context.Background(), task.ID, &Watcher{SessionID: "sess-watcher"}); !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want ErrInvalidWork", err)
	}
	if got := getWork(t, s, task.ID); got.Status != StatusOpen || got.Watcher != nil {
		t.Errorf("task = %q watched by %+v, want it left open and unwatched", got.Status, got.Watcher)
	}
}

func TestClaim_NotFound(t *testing.T) {
	s := newTestStore(t)
	if _, _, err := s.Claim(context.Background(), "missing", nil); !errors.Is(err, ErrWorkNotFound) {
		t.Errorf("err = %v, want ErrWorkNotFound", err)
	}
}

func TestRollbackStart_ClearsSessionID(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")

	// Fresh start rollback: active → open, clear sessionID
	err := s.RollbackStart(context.Background(), story.ID, "session-1", false)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.SessionID != "" {
		t.Errorf("session_id = %q, want empty", got.SessionID)
	}
	if got.Status != StatusOpen {
		t.Errorf("status = %q, want %q", got.Status, StatusOpen)
	}
}

func TestRollbackStart_RestartPreservesSessionID(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")

	// Restart rollback: active → stopped, preserve sessionID
	err := s.RollbackStart(context.Background(), story.ID, "session-1", true)
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.SessionID != "session-1" {
		t.Errorf("session_id = %q, want %q", got.SessionID, "session-1")
	}
	if got.Status != StatusStopped {
		t.Errorf("status = %q, want %q", got.Status, StatusStopped)
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

func TestTasksOf(t *testing.T) {
	works := []Work{
		{ID: "A"},
		{ID: "B", StoryID: "A"},
		{ID: "C", StoryID: "A"},
		{ID: "D"}, // unrelated story
		{ID: "E", StoryID: "D"},
	}

	var got []string
	for _, task := range TasksOf(works, "A") {
		got = append(got, task.ID)
	}
	if want := []string{"B", "C"}; !slices.Equal(got, want) {
		t.Errorf("TasksOf(A) = %v, want %v", got, want)
	}
}

// "" is how a story spells its own StoryID, so asking for the tasks of no story
// must answer with none — not with every story in the project, which is what a
// plain match would give, and which subtreeIDs would hand to a cascade delete.
func TestTasksOf_EmptyStoryID(t *testing.T) {
	works := []Work{
		{ID: "A"},
		{ID: "B", StoryID: "A"},
		{ID: "C"},
	}

	if got := TasksOf(works, ""); len(got) != 0 {
		t.Errorf(`TasksOf("") = %v, want none`, got)
	}
	if ids := subtreeIDs(works, ""); len(ids) != 1 {
		t.Errorf(`subtreeIDs("") covers %v, want nothing but the id it was given`, ids)
	}
	if HasActiveTask([]Work{{ID: "A", Status: StatusActive}}, "") {
		t.Error(`HasActiveTask("") = true, want false — an active story is not a task of no story`)
	}
}

// A task has no tasks, which is why nothing built on TasksOf needs a walk.
func TestTasksOf_Task(t *testing.T) {
	works := []Work{
		{ID: "A"},
		{ID: "B", StoryID: "A"},
	}

	if got := TasksOf(works, "B"); len(got) != 0 {
		t.Errorf("TasksOf(B) = %v, want none", got)
	}
}

func TestDelete_NotFound(t *testing.T) {
	s := newTestStore(t)
	if err := s.Delete(context.Background(), "nonexistent"); err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

// --- Status transitions ---

func TestTransition_OpenToActive(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	got := getWork(t, s, story.ID)
	if got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
	}
}

func TestTransition_ActiveToClosed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// Story with no children: active → closed directly
	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStart_FromStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "old-session")
	s.Stop(context.Background(), story.ID)

	w, err := s.Start(context.Background(), story.ID, "new-session")
	if err != nil {
		t.Fatalf("Start from stopped: %v", err)
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want %q", w.Status, StatusActive)
	}
	if w.SessionID != "new-session" {
		t.Errorf("session_id = %q, want %q", w.SessionID, "new-session")
	}
}

func TestStart_FromStoppedKeepsTheSession(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	w, err := s.Start(context.Background(), story.ID, "session-1")
	if err != nil {
		t.Fatalf("Start from stopped: %v", err)
	}
	if w.Status != StatusActive {
		t.Errorf("status = %q, want %q", w.Status, StatusActive)
	}
	if w.SessionID != "session-1" {
		t.Errorf("session_id = %q, want %q", w.SessionID, "session-1")
	}
}

// Starting clears whatever the work was waiting for and the nudges it had
// collected: the run that accumulated them is over.
func TestStart_ClearsTheWaitAndTheNudges(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")
	waitOnChild(t, s, story.ID)
	if _, err := s.RecordNudge(context.Background(), story.ID); err != nil {
		t.Fatalf("RecordNudge: %v", err)
	}
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	w, err := s.Start(context.Background(), story.ID, "session-1")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if w.Wait != WaitNone || w.NudgeCount != 0 {
		t.Errorf("wait/nudges = %q/%d, want none", w.Wait, w.NudgeCount)
	}
}

func TestStart_InvalidFromActive(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	// Start from active should fail
	_, err := s.Start(context.Background(), story.ID, "new-session")
	if err == nil {
		t.Fatal("expected error for Start from active")
	}
}

func TestRollbackStart_FreshStartRollsBackToOpen(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")

	err := s.RollbackStart(context.Background(), story.ID, "session-1", false)
	if err != nil {
		t.Fatalf("active → open should be valid (rollback): %v", err)
	}

	w, _, _ := s.Get(story.ID)
	if w.Status != StatusOpen {
		t.Fatalf("expected open, got %s", w.Status)
	}
}

func TestMarkRunning_ClosedRejected(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	doneWork(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Fatalf("status = %q, want %q", got.Status, StatusClosed)
	}

	// MarkRunning rejects closed work (must use Reopen instead)
	if err := s.Activate(context.Background(), story.ID); err == nil {
		t.Fatal("expected error for MarkRunning on closed work")
	}
}

// --- stopped / closed restart transitions ---

// "The session is live again" is one fact however the work was paused, so one
// method covers all three sources.
func TestMarkRunning_FromAnyLiveStatus(t *testing.T) {
	tests := []struct {
		name  string
		pause func(*FileStore, string) error
	}{
		{"stopped", func(s *FileStore, id string) error { return s.Stop(context.Background(), id) }},
		{"wait_on_children", func(s *FileStore, id string) error {
			waitOnChild(t, s, id)
			return nil
		}},
		{"active", func(*FileStore, string) error { return nil }},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			story := createStory(t, s, "S")
			startWork(t, s, story.ID)
			if err := tt.pause(s, story.ID); err != nil {
				t.Fatalf("pause to %s: %v", tt.name, err)
			}

			if err := s.Activate(context.Background(), story.ID); err != nil {
				t.Fatalf("%s → active: %v", tt.name, err)
			}
			if got := getWork(t, s, story.ID); got.Status != StatusActive {
				t.Errorf("status = %q, want %q", got.Status, StatusActive)
			}
		})
	}
}

func TestReopen_ClosedToActive(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)
	doneWork(t, s, story.ID) // no children → auto-close → closed

	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Fatalf("precondition: story should be closed, got %q", got.Status)
	}

	// Reopen allows closed → active
	if err := s.Reopen(context.Background(), story.ID); err != nil {
		t.Fatalf("Reopen: %v", err)
	}
	got = getWork(t, s, story.ID)
	if got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
	}
}

func TestReopen_RejectsNonClosedStatus(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()

	tests := []struct {
		name   string
		setup  func(id string)
		status WorkStatus
	}{
		{
			name:   "open",
			setup:  func(id string) {},
			status: StatusOpen,
		},
		{
			name:   "active",
			setup:  func(id string) { startWork(t, s, id) },
			status: StatusActive,
		},
		{
			name:   "stopped",
			setup:  func(id string) { startWork(t, s, id); s.Stop(ctx, id) },
			status: StatusStopped,
		},
		{
			name:   "wait_on_children",
			setup:  func(id string) { startWork(t, s, id); waitOnChild(t, s, id) },
			status: StatusActive,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			story := createStory(t, s, "S-"+tt.name)
			tt.setup(story.ID)

			got := getWork(t, s, story.ID)
			if got.Status != tt.status {
				t.Fatalf("precondition: expected %q, got %q", tt.status, got.Status)
			}

			if err := s.Reopen(ctx, story.ID); err == nil {
				t.Errorf("expected error for Reopen from %s status", tt.status)
			}
		})
	}
}

func TestReopen_NotFound(t *testing.T) {
	s := newTestStore(t)
	err := s.Reopen(context.Background(), "nonexistent")
	if err != ErrWorkNotFound {
		t.Errorf("expected ErrWorkNotFound, got %v", err)
	}
}

// --- wait transitions ---

func TestTransition_ActiveToWaitOnChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	waitOnChild(t, s, story.ID)

	got := getWork(t, s, story.ID)
	if got.Status != StatusActive || got.Wait != WaitChild {
		t.Errorf("status/wait = %q/%q, want %q/%q", got.Status, got.Wait, StatusActive, WaitChild)
	}
}

func TestTransition_WaitOnChildrenToStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	waitOnChild(t, s, story.ID)

	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("waiting → stopped: %v", err)
	}
	got := getWork(t, s, story.ID)
	if got.Status != StatusStopped {
		t.Errorf("status = %q, want %q", got.Status, StatusStopped)
	}
}

func TestTransition_Invalid_OpenToWaitOnChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	child := createTask(t, s, story.ID, "T")
	startWork(t, s, child.ID)

	if _, err := s.SetChildWait(context.Background(), story.ID); err == nil {
		t.Fatal("expected error for open → waiting on children")
	}
}

// A stopped subtask is not something a wait could be waiting for: only a subtask
// *closing* ends a `child` wait, and a stopped one is not going to close by
// itself. The refusal is the store's; the sentence explaining it to the agent is
// Operations.waitRefusal's.
func TestParentWaiting_RefusedWhenTheOnlyChildIsStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Stop the task (simulates agent crash or retry limit)
	s.Stop(context.Background(), task.ID)

	set, err := s.SetChildWait(context.Background(), story.ID)
	if err != nil {
		t.Fatalf("SetChildWait: %v", err)
	}
	if set {
		t.Error("the story was parked on a subtask that is not going to close")
	}
	if got := getWork(t, s, story.ID); got.Wait != WaitNone {
		t.Errorf("wait = %q, want none", got.Wait)
	}
}

func TestStepDone_ChildClosesWhileParentWaiting(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Parent enters waiting for child
	setChildWait(t, s, story.ID)

	doneWork(t, s, task.ID)

	if getWork(t, s, task.ID).Status != StatusClosed {
		t.Error("task should be closed")
	}
	// Parent stays waiting — waking it is the engine's job, not the store's
	if getWork(t, s, story.ID).Wait != WaitChild {
		t.Errorf("story should stay waiting, got %q", getWork(t, s, story.ID).Wait)
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

func TestStory_UsesWaitingForPendingChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	// Story uses waiting to wait for child completion
	setChildWait(t, s, story.ID)
	got := getWork(t, s, story.ID)
	if got.Status != StatusActive || got.Wait != WaitChild {
		t.Errorf("status/wait = %q/%q, want %q/%q", got.Status, got.Wait, StatusActive, WaitChild)
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

func TestParentWaiting_StaysWaitingWhenChildrenClose(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task1 := createTask(t, s, story.ID, "T1")
	task2 := createTask(t, s, story.ID, "T2")
	startWork(t, s, story.ID)
	startWork(t, s, task1.ID)
	startWork(t, s, task2.ID)

	// Parent enters waiting for children
	setChildWait(t, s, story.ID)

	// Complete task1 → closed; parent stays waiting (the engine handles wakeup)
	doneWork(t, s, task1.ID)
	if getWork(t, s, task1.ID).Status != StatusClosed {
		t.Error("task1 should be closed")
	}
	if getWork(t, s, story.ID).Wait != WaitChild {
		t.Errorf("story should stay waiting while task2 is running, got %q", getWork(t, s, story.ID).Wait)
	}

	// Complete task2 → closed; parent stays waiting (the engine handles wakeup)
	doneWork(t, s, task2.ID)
	if getWork(t, s, task2.ID).Status != StatusClosed {
		t.Error("task2 should be closed")
	}
	if getWork(t, s, story.ID).Wait != WaitChild {
		t.Errorf("story should stay waiting (the engine wakes it up), got %q", getWork(t, s, story.ID).Wait)
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
	if got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
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

	// Task done → auto-close; parent stays done (the engine tells it, not the store)
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
	story := createStory(t, s, "Story")
	const n = 20

	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.Create(context.Background(), Work{
				StoryID:     story.ID,
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
				StoryID:     story.ID,
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
			sid := fmt.Sprintf("session-%d", i)
			_, err := s.Start(context.Background(), story.ID, sid)
			results <- err
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

	// Exactly one should succeed (open → active), rest fail (a work that is already active cannot be started)
	if successes != 1 {
		t.Errorf("expected exactly 1 success, got %d successes and %d failures", successes, failures)
	}
}

// Claim is the production claim path: the restart/session decision happens under
// the store lock, so concurrent claims on the same work must yield exactly one
// winner (no double-claim, no clobbered session).
func TestConcurrent_ClaimSameWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "Race")
	const n = 10

	type outcome struct {
		w   Work
		err error
	}
	results := make(chan outcome, n)
	for i := 0; i < n; i++ {
		go func() {
			w, _, err := s.Claim(context.Background(), story.ID, nil)
			results <- outcome{w: w, err: err}
		}()
	}

	var successes int
	var winningSession string
	for i := 0; i < n; i++ {
		o := <-results
		if o.err != nil {
			continue
		}
		successes++
		winningSession = o.w.SessionID
	}

	if successes != 1 {
		t.Errorf("expected exactly 1 successful claim, got %d", successes)
	}
	final := getWork(t, s, story.ID)
	if final.SessionID != winningSession {
		t.Errorf("final session = %q, want the winning claim's %q (no clobber)", final.SessionID, winningSession)
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

func TestUpdateComment(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")

	c, _ := s.AddComment(context.Background(), story.ID, "original")

	updated, err := s.UpdateComment(context.Background(), c.ID, "edited")
	if err != nil {
		t.Fatalf("UpdateComment: %v", err)
	}
	if updated.Body != "edited" {
		t.Errorf("body = %q, want %q", updated.Body, "edited")
	}
	if updated.ID != c.ID {
		t.Errorf("id = %q, want %q", updated.ID, c.ID)
	}
	if updated.WorkID != story.ID {
		t.Errorf("work_id = %q, want %q", updated.WorkID, story.ID)
	}

	comments, _ := s.ListComments(story.ID)
	if len(comments) != 1 || comments[0].Body != "edited" {
		t.Errorf("expected edited comment in list, got %v", comments)
	}
}

func TestUpdateComment_NotFound(t *testing.T) {
	s := newTestStore(t)
	_, err := s.UpdateComment(context.Background(), "nonexistent", "text")
	if err != ErrCommentNotFound {
		t.Errorf("expected ErrCommentNotFound, got %v", err)
	}
}

func TestUpdateComment_Persistence(t *testing.T) {
	dir := t.TempDir()

	s1, _ := NewFileStore(dir)
	story := createStory(t, s1, "S")
	c, _ := s1.AddComment(context.Background(), story.ID, "original")
	s1.UpdateComment(context.Background(), c.ID, "persisted edit")

	s2, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}

	comments, _ := s2.ListComments(story.ID)
	if len(comments) != 1 || comments[0].Body != "persisted edit" {
		t.Fatalf("expected persisted edit, got %v", comments)
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

// --- StepDone ---

func TestStepDone_AdvancesToNextStep(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, task.ID)

	// 3 total steps, currently on step 0
	hasMore, err := s.StepDone(context.Background(), task.ID, 3)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if !hasMore {
		t.Error("expected hasMoreSteps=true")
	}

	got := getWork(t, s, task.ID)
	if got.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", got.CurrentStep)
	}
	if got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
	}
}

func TestStepDone_LastStepClosesWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, task.ID)

	// Advance to step 1 (second of 2)
	s.StepDone(context.Background(), task.ID, 2)
	got := getWork(t, s, task.ID)
	if got.CurrentStep != 1 {
		t.Fatalf("CurrentStep = %d, want 1 (precondition)", got.CurrentStep)
	}

	// Now on last step (index 1 of 2), StepDone should close the work.
	hasMore, err := s.StepDone(context.Background(), task.ID, 2)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if hasMore {
		t.Error("expected hasMoreSteps=false for last step")
	}

	got = getWork(t, s, task.ID)
	if got.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1 (unchanged)", got.CurrentStep)
	}
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStepDone_StoryAdvancesToNextStep(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	hasMore, err := s.StepDone(context.Background(), story.ID, 3)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if !hasMore {
		t.Error("expected hasMoreSteps=true")
	}

	got := getWork(t, s, story.ID)
	if got.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", got.CurrentStep)
	}
	if got.Status != StatusActive {
		t.Errorf("status = %q, want %q", got.Status, StatusActive)
	}
}

func TestStepDone_StoryLastStepClosesWithPendingChildren(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	if _, err := s.StepDone(context.Background(), story.ID, 2); err != nil {
		t.Fatalf("StepDone first step: %v", err)
	}

	hasMore, err := s.StepDone(context.Background(), story.ID, 2)
	if err != nil {
		t.Fatalf("StepDone last step: %v", err)
	}
	if hasMore {
		t.Error("expected hasMoreSteps=false for story completion")
	}

	got := getWork(t, s, story.ID)
	if got.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", got.CurrentStep)
	}
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStepDone_StoryLastStepClosesWhenChildrenClosed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)
	doneWork(t, s, task.ID)

	if _, err := s.StepDone(context.Background(), story.ID, 2); err != nil {
		t.Fatalf("StepDone first step: %v", err)
	}

	hasMore, err := s.StepDone(context.Background(), story.ID, 2)
	if err != nil {
		t.Fatalf("StepDone last step: %v", err)
	}
	if hasMore {
		t.Error("expected hasMoreSteps=false for story completion")
	}

	got := getWork(t, s, story.ID)
	if got.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", got.CurrentStep)
	}
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStepDone_NoStepsClosesWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)

	hasMore, err := s.StepDone(context.Background(), story.ID, 0)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if hasMore {
		t.Error("expected hasMoreSteps=false for work without steps")
	}

	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStepDone_StoryWithPendingChildrenClosesWhenNoSteps(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, story.ID)
	startWork(t, s, task.ID)

	hasMore, err := s.StepDone(context.Background(), story.ID, 0)
	if err != nil {
		t.Fatalf("StepDone: %v", err)
	}
	if hasMore {
		t.Error("expected hasMoreSteps=false for story completion")
	}

	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

func TestStepDone_RejectsUnstartedAndClosedStatus(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*FileStore, string)
	}{
		{"open", func(*FileStore, string) {}},
		{"closed", func(s *FileStore, id string) {
			doneWork(t, s, id)
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			story := createStory(t, s, "S")
			tt.setup(s, story.ID)

			_, err := s.StepDone(context.Background(), story.ID, 3)
			if err == nil {
				t.Fatalf("expected error for StepDone on %s work", tt.name)
			}
		})
	}
}

// A live status is only a claim about the agent process, and it goes stale
// (crashed process, missed event). It must never lock a work item: the agent
// reporting progress proves it is running, so the advance also repairs status.
func TestStepDone_AdvancesFromStaleLiveStatus(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*FileStore, string)
	}{
		{"stopped", func(s *FileStore, id string) {
			if err := s.Stop(context.Background(), id); err != nil {
				t.Fatalf("Stop: %v", err)
			}
		}},
		{"wait_on_children", func(s *FileStore, id string) {
			waitOnChild(t, s, id)
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			story := createStory(t, s, "S")
			startWork(t, s, story.ID)
			tt.setup(s, story.ID)

			hasMore, err := s.StepDone(context.Background(), story.ID, 3)
			if err != nil {
				t.Fatalf("StepDone from %s: %v", tt.name, err)
			}
			if !hasMore {
				t.Fatal("hasMoreSteps = false, want true")
			}

			got := getWork(t, s, story.ID)
			if got.CurrentStep != 1 {
				t.Errorf("CurrentStep = %d, want 1", got.CurrentStep)
			}
			if got.Status != StatusActive {
				t.Errorf("status = %q, want %q", got.Status, StatusActive)
			}
		})
	}
}

func TestStepDone_ClosesFromStaleLiveStatus(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	hasMore, err := s.StepDone(context.Background(), story.ID, 1)
	if err != nil {
		t.Fatalf("StepDone from stopped: %v", err)
	}
	if hasMore {
		t.Fatal("hasMoreSteps = true, want false")
	}

	got := getWork(t, s, story.ID)
	if got.Status != StatusClosed {
		t.Errorf("status = %q, want %q", got.Status, StatusClosed)
	}
}

// SetChildWait is where the "a wait must have something that could end it" rule
// is actually applied, so the interesting cases are the store's, not the
// caller's: it must refuse without writing, and it must still admit a stale
// `stopped` — an agent able to call story_wait is running whatever status says.
func TestSetChildWait(t *testing.T) {
	t.Run("refuses, and writes nothing, with no active child", func(t *testing.T) {
		store := newTestStore(t)
		story := createStory(t, store, "S")
		startWork(t, store, story.ID)
		createTask(t, store, story.ID, "never started")

		set, err := store.SetChildWait(context.Background(), story.ID)
		if err != nil || set {
			t.Fatalf("set = %v/%v, want false/nil", set, err)
		}
		if got := getWork(t, store, story.ID); got.Wait != WaitNone {
			t.Errorf("wait = %q; a refused wait writes nothing", got.Wait)
		}
	})

	t.Run("sets it, and repairs a stale stopped", func(t *testing.T) {
		store := newTestStore(t)
		story := createStory(t, store, "S")
		startWork(t, store, story.ID)
		child := createTask(t, store, story.ID, "T")
		startWork(t, store, child.ID)
		if err := store.Stop(context.Background(), story.ID); err != nil {
			t.Fatalf("Stop: %v", err)
		}

		set, err := store.SetChildWait(context.Background(), story.ID)
		if err != nil || !set {
			t.Fatalf("set = %v/%v, want true/nil", set, err)
		}
		got := getWork(t, store, story.ID)
		if got.Status != StatusActive || got.Wait != WaitChild {
			t.Errorf("story = %q/%q, want active/child", got.Status, got.Wait)
		}
	})

	t.Run("reports a closed work as an error, not a refusal", func(t *testing.T) {
		store := newTestStore(t)
		story := createStory(t, store, "S")
		doneWork(t, store, story.ID)

		if _, err := store.SetChildWait(context.Background(), story.ID); !errors.Is(err, ErrInvalidWork) {
			t.Errorf("err = %v, want ErrInvalidWork: a closed work is reopened, not waited on", err)
		}
	})

	t.Run("reports a missing work as not found", func(t *testing.T) {
		store := newTestStore(t)
		if _, err := store.SetChildWait(context.Background(), "nope"); !errors.Is(err, ErrWorkNotFound) {
			t.Errorf("err = %v, want ErrWorkNotFound", err)
		}
	})
}

// ClearChildWaitIfStranded is the one transition whose condition spans the work
// and its children, and it answers rather than just acting: the engine sends a
// message on the strength of that answer, so a `true` that two callers can both
// get, or that is given while a subtask is running, is a message that lies.
// Tested here rather than through the engine because the lock is what holds it.
func TestClearChildWaitIfStranded(t *testing.T) {
	newWaitingStory := func(t *testing.T) (*FileStore, Work, Work) {
		t.Helper()
		store := newTestStore(t)
		story := createStory(t, store, "S")
		startWork(t, store, story.ID)
		child := createTask(t, store, story.ID, "T")
		startWork(t, store, child.ID)
		setChildWait(t, store, story.ID)
		return store, getWork(t, store, story.ID), child
	}

	t.Run("clears once and says so once", func(t *testing.T) {
		store, story, child := newWaitingStory(t)
		if err := store.Stop(context.Background(), child.ID); err != nil {
			t.Fatalf("Stop: %v", err)
		}

		first, err := store.ClearChildWaitIfStranded(context.Background(), story.ID)
		if err != nil || !first {
			t.Fatalf("first call = %v/%v, want true/nil", first, err)
		}
		// The second caller is the other subtask's follow-up. It must come away
		// empty-handed, or the same news is delivered twice.
		second, err := store.ClearChildWaitIfStranded(context.Background(), story.ID)
		if err != nil || second {
			t.Errorf("second call = %v/%v, want false/nil", second, err)
		}
		if got := getWork(t, store, story.ID); got.Status != StatusActive || got.Wait != WaitNone {
			t.Errorf("story = %q/%q, want active with no wait", got.Status, got.Wait)
		}
	})

	t.Run("refuses while a subtask is still active", func(t *testing.T) {
		store, story, _ := newWaitingStory(t)

		cleared, err := store.ClearChildWaitIfStranded(context.Background(), story.ID)
		if err != nil || cleared {
			t.Fatalf("cleared = %v/%v, want false/nil; the wait can still end properly", cleared, err)
		}
		if got := getWork(t, store, story.ID); got.Wait != WaitChild {
			t.Errorf("wait = %q, want it left alone", got.Wait)
		}
	})

	t.Run("leaves a work that declared no wait alone", func(t *testing.T) {
		store, story, child := newWaitingStory(t)
		if err := store.Activate(context.Background(), story.ID); err != nil {
			t.Fatalf("Activate: %v", err)
		}
		if err := store.Stop(context.Background(), child.ID); err != nil {
			t.Fatalf("Stop: %v", err)
		}

		cleared, err := store.ClearChildWaitIfStranded(context.Background(), story.ID)
		if err != nil || cleared {
			t.Fatalf("cleared = %v/%v, want false/nil; there was no wait to strand", cleared, err)
		}
	})
}

// story_wait must not be lockable by a stale stopped either: the agent reporting
// what it is waiting on is running, whatever status says.
func TestLiveStatusSetters_AcceptStoppedSource(t *testing.T) {
	tests := []struct {
		name string
		mark func(*FileStore, string) error
		want WorkWait
	}{
		{"wait_on_children", func(s *FileStore, id string) error {
			waitOnChild(t, s, id)
			return nil
		}, WaitChild},
		{"running", func(s *FileStore, id string) error { return s.Activate(context.Background(), id) }, WaitNone},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			story := createStory(t, s, "S")
			startWork(t, s, story.ID)
			if err := s.Stop(context.Background(), story.ID); err != nil {
				t.Fatalf("Stop: %v", err)
			}

			if err := tt.mark(s, story.ID); err != nil {
				t.Fatalf("stopped → %s: %v", tt.want, err)
			}
			// Every one of them also takes the work back to active: an agent
			// reporting on its own work is proof the work is being driven.
			if got := getWork(t, s, story.ID); got.Status != StatusActive || got.Wait != tt.want {
				t.Errorf("status/wait = %q/%q, want %q/%q", got.Status, got.Wait, StatusActive, tt.want)
			}
		})
	}
}

// Liveness signals repeat, so re-asserting the status a work already has must
// succeed without emitting a change event listeners would treat as news.
func TestLiveStatusSetters_RepeatIsSilentNoop(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("repeated Stop: %v", err)
	}
	if len(events) != 0 {
		t.Errorf("got %d change events, want 0", len(events))
	}
	if got := getWork(t, s, story.ID); got.Status != StatusStopped {
		t.Errorf("status = %q, want %q", got.Status, StatusStopped)
	}
}

func TestStepDone_NotFound(t *testing.T) {
	s := newTestStore(t)
	_, err := s.StepDone(context.Background(), "nonexistent", 3)
	if err == nil {
		t.Fatal("expected error for nonexistent ID")
	}
}

func TestStepDone_FiresUpdateEvent(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	task := createTask(t, s, story.ID, "T")
	startWork(t, s, task.ID)

	var events []ChangeEvent
	s.AddOnChangeListener(listenerFunc(func(e ChangeEvent) {
		events = append(events, e)
	}))

	s.StepDone(context.Background(), task.ID, 3)

	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].Op != OperationUpdate {
		t.Errorf("expected update event, got %s", events[0].Op)
	}
	if events[0].Work.CurrentStep != 1 {
		t.Errorf("event Work.CurrentStep = %d, want 1", events[0].Work.CurrentStep)
	}
}

// The whole of the work index's migration: old values are read as what they
// always meant. The three statuses this replaces were this model flattened —
// one status and three waits — which is why none of it is a guess. The `user`
// wait is gone now, so needs_input lands on plain active: a message is what
// wakes such a work either way.
func TestFileStore_NormalisesOldStatusesOnLoad(t *testing.T) {
	dir := t.TempDir()
	index := `{"works":[
		{"id":"w1","type":"story","title":"driven","status":"in_progress","agent_role_id":"r"},
		{"id":"w2","type":"story","title":"was waiting on the user","status":"needs_input","agent_role_id":"r"},
		{"id":"w3","type":"story","title":"waiting on children","status":"waiting","agent_role_id":"r"},
		{"id":"w4","type":"story","title":"stopped","status":"stopped","agent_role_id":"r"},
		{"id":"w5","type":"story","title":"closed","status":"closed","agent_role_id":"r"}
	]}`
	if err := os.MkdirAll(filepath.Join(dir, "works"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "works", "index.json"), []byte(index), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	s, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	want := map[string]struct {
		status WorkStatus
		wait   WorkWait
	}{
		"w1": {StatusActive, WaitNone},
		"w2": {StatusActive, WaitNone},
		"w3": {StatusActive, WaitChild},
		"w4": {StatusStopped, WaitNone},
		"w5": {StatusClosed, WaitNone},
	}
	for id, expected := range want {
		got := getWork(t, s, id)
		if got.Status != expected.status || got.Wait != expected.wait {
			t.Errorf("%s (%s) = %q/%q, want %q/%q", id, got.Title, got.Status, got.Wait, expected.status, expected.wait)
		}
	}
}

// `type` is on the wire (rpc.WorkDetailItem, rpc.WorkListItem) and must stay
// off the disk: the hierarchy is one field, and a stored kind beside story_id is
// the second copy of the fact this shape was collapsed to remove — free to
// disagree with story_id the moment either is written alone.
//
// Asserted against the file's bytes rather than against a reloaded Work, because
// a reloaded Work cannot see the difference: the field is gone from the struct,
// so an unmarshal would drop a stored `type` and report the same thing either
// way. What this guards against is a MarshalJSON on the domain type — the
// tempting way to put a derived key on the wire — since persistIndex marshals
// the records themselves into this file, so anything Work marshals lands here.
func TestPersistedIndexCarriesNoType(t *testing.T) {
	dir := t.TempDir()
	s, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	story := createStory(t, s, "A story")
	task := createTask(t, s, story.ID, "A task")

	raw, err := os.ReadFile(filepath.Join(dir, "works", "index.json"))
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	// Parsed rather than searched for `"type"`: the same file holds the comments,
	// so a comment body is free to contain that text, and a substring match also
	// depends on how the file happens to be indented.
	var index struct {
		Works []map[string]json.RawMessage `json:"works"`
	}
	if err := json.Unmarshal(raw, &index); err != nil {
		t.Fatalf("unmarshal index: %v", err)
	}
	if len(index.Works) != 2 {
		t.Fatalf("index holds %d works, want the story and its task: %s", len(index.Works), raw)
	}

	for _, record := range index.Works {
		if _, present := record["type"]; present {
			t.Errorf("index.json stores a type: %s", record["type"])
		}
	}
	// The task's own record names its story, so the absence above is the absence
	// of a key rather than of the hierarchy. Found by id rather than by position,
	// which the store never promised.
	var stored map[string]json.RawMessage
	for _, record := range index.Works {
		if string(record["id"]) == `"`+task.ID+`"` {
			stored = record
		}
	}
	if stored == nil {
		t.Fatalf("the task is not in the index: %s", raw)
	}
	if got := string(stored["story_id"]); got != `"`+story.ID+`"` {
		t.Errorf("the stored task names its story as %s, want %q", got, story.ID)
	}
}

// The other half of that migration: a record written before the hierarchy was
// one field. `parent_id` is read as `story_id` — every value it holds on disk
// is a story id, because nothing deeper was ever creatable — and `type` is read
// and dropped, because story_id now says the same thing.
func TestFileStore_ReadsOldParentIDAsStoryIDOnLoad(t *testing.T) {
	dir := t.TempDir()
	index := `{"works":[
		{"id":"s1","type":"story","title":"a story","status":"open","agent_role_id":"r"},
		{"id":"t1","type":"task","parent_id":"s1","title":"a task","status":"open","agent_role_id":"r"}
	]}`
	if err := os.MkdirAll(filepath.Join(dir, "works"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "works", "index.json"), []byte(index), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}

	s, err := NewFileStore(dir)
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	story := getWork(t, s, "s1")
	if story.StoryID != "" || story.Type() != WorkTypeStory {
		t.Errorf("s1 = story_id %q / type %q, want the story it was", story.StoryID, story.Type())
	}
	task := getWork(t, s, "t1")
	if task.StoryID != "s1" || task.Type() != WorkTypeTask {
		t.Errorf("t1 = story_id %q / type %q, want s1 / task", task.StoryID, task.Type())
	}

	// And the next write does not put either old key back. Asserted on the
	// file rather than on LegacyParentID being empty: the claim is about what
	// lands on disk, and a cleared field only implies it for as long as the tag
	// says omitempty.
	createStory(t, s, "any write")
	raw, err := os.ReadFile(filepath.Join(dir, "works", "index.json"))
	if err != nil {
		t.Fatalf("read index: %v", err)
	}
	var written struct {
		Works []map[string]json.RawMessage `json:"works"`
	}
	if err := json.Unmarshal(raw, &written); err != nil {
		t.Fatalf("unmarshal index: %v", err)
	}
	for _, record := range written.Works {
		for _, old := range []string{"parent_id", "type"} {
			if v, present := record[old]; present {
				t.Errorf("record %s was written back with %s = %s", record["id"], old, v)
			}
		}
		if string(record["id"]) == `"t1"` && string(record["story_id"]) != `"s1"` {
			t.Errorf("t1 was written back with story_id %s, want \"s1\"", record["story_id"])
		}
	}
}

// A wait means nothing once the engine has let go of the work, and one left
// behind would show the user a work "waiting for you" that nothing will resume.
func TestNormalizeDropsAWaitOnWorkThatIsNotActive(t *testing.T) {
	for _, status := range []WorkStatus{StatusOpen, StatusStopped, StatusClosed} {
		got := Work{Status: status, Wait: WaitChild}.Normalize()
		if got.Wait != WaitNone {
			t.Errorf("%s kept wait %q", status, got.Wait)
		}
	}
}

// A failed kickoff deletes the session it created, and the engine stops the work
// of a deleted session — so the stop and the rollback race. Both orders have to
// land on the same answer, or a work whose start failed is left stopped, holding
// a session id that names nothing.
func TestRollbackStart_UndoesAStartTheEngineAlreadyStopped(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")
	if err := s.Stop(context.Background(), story.ID); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	if err := s.RollbackStart(context.Background(), story.ID, "session-1", false); err != nil {
		t.Fatalf("rollback after a racing stop: %v", err)
	}

	got := getWork(t, s, story.ID)
	if got.Status != StatusOpen || got.SessionID != "" {
		t.Errorf("work = %q/%q, want open with no session", got.Status, got.SessionID)
	}
}

// The session id is what says which start is being undone. A work already
// started again — on a session of its own — is not it.
func TestRollbackStart_RefusesAStartThatIsNotTheOneThatFailed(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-2")

	err := s.RollbackStart(context.Background(), story.ID, "session-1", false)
	if !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want ErrInvalidWork", err)
	}
	if got := getWork(t, s, story.ID); got.Status != StatusActive || got.SessionID != "session-2" {
		t.Errorf("work = %q/%q, want it left alone", got.Status, got.SessionID)
	}
}

// A closed work is one the agent moved on; undoing a start into it would clobber
// live state.
func TestRollbackStart_RefusesAClosedWork(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWorkWithSession(t, s, story.ID, "session-1")
	if _, err := s.StepDone(context.Background(), story.ID, 0); err != nil {
		t.Fatalf("StepDone: %v", err)
	}

	if err := s.RollbackStart(context.Background(), story.ID, "session-1", false); !errors.Is(err, ErrInvalidWork) {
		t.Fatalf("err = %v, want ErrInvalidWork", err)
	}
}

// The no-op path leaves the record alone, `UpdatedAt` included — that field
// orders the closed group and is what a client uses to tell a stale row from a
// fresh one, so a liveness signal that moved nothing must not touch it either.
func TestLiveStatusSetters_NoopLeavesTheRecordUntouched(t *testing.T) {
	s := newTestStore(t)
	story := createStory(t, s, "S")
	startWork(t, s, story.ID)
	waitOnChild(t, s, story.ID)
	before := getWork(t, s, story.ID)

	setChildWait(t, s, story.ID)

	if got := getWork(t, s, story.ID); got != before {
		t.Errorf("record = %+v, want it unchanged from %+v", got, before)
	}
}
