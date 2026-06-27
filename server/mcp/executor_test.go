package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
)

// stubWorkStarter satisfies work.WorkStartHandler without creating real
// sessions. The store transition (claim) is what the tests assert on; the
// kickoff side effects belong to integration tests in the worktree package.
type stubWorkStarter struct{}

func (stubWorkStarter) HandleWorkStart(context.Context, work.Work) error { return nil }

var errStartFailed = errors.New("start handler failed")

// failingWorkStarter always fails, to exercise the rollback path in work_start.
type failingWorkStarter struct{ err error }

func (f failingWorkStarter) HandleWorkStart(context.Context, work.Work) error { return f.err }

// stubNotifier satisfies WorkNotifier as a no-op.
type stubNotifier struct{}

func (stubNotifier) NotifyStepDone(work.Work) {}
func (stubNotifier) NotifyReopen(work.Work)   {}

// spyNotifier records the works passed to each notification so tests can assert
// the in-process MCP path requests the follow-up messages (the AutoResumer only
// auto-sends these for external/fsnotify changes).
type spyNotifier struct {
	stepDone []work.Work
	reopen   []work.Work
}

func (s *spyNotifier) NotifyStepDone(w work.Work) { s.stepDone = append(s.stepDone, w) }
func (s *spyNotifier) NotifyReopen(w work.Work)   { s.reopen = append(s.reopen, w) }

type testExec struct {
	exec   *Executor
	store  work.Store
	roleID string
}

// newStoresWithRole creates fresh work/agent-role/settings stores seeded with
// one role.
func newStoresWithRole(t *testing.T, role agentrole.AgentRole) (work.Store, agentrole.Store, *settings.Store, string) {
	t.Helper()
	dataDir := t.TempDir()
	store, err := work.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	arStore, err := agentrole.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	settingsStore, err := settings.NewStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	created, err := arStore.Create(context.Background(), role)
	if err != nil {
		t.Fatal(err)
	}
	return store, arStore, settingsStore, created.ID
}

func newExecWithRole(t *testing.T, role agentrole.AgentRole) (*Executor, work.Store, string) {
	t.Helper()
	store, arStore, settingsStore, roleID := newStoresWithRole(t, role)
	return NewExecutor(store, arStore, stubWorkStarter{}, stubNotifier{}, settingsStore), store, roleID
}

func newTestExec(t *testing.T) testExec {
	t.Helper()
	exec, store, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "Test Engineer",
		RolePrompt: "You are a test engineer.",
	})
	return testExec{exec: exec, store: store, roleID: roleID}
}

type result struct {
	Text    string
	IsError bool
}

// callTool runs a tool through the executor and reports the result the way the
// MCP layer would: a handler error becomes an isError result, not a transport
// failure.
func callTool(t *testing.T, e *Executor, name string, args interface{}) result {
	t.Helper()
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	text, err := e.Execute(context.Background(), name, raw)
	if err != nil {
		return result{Text: "Error: " + err.Error(), IsError: true}
	}
	return result{Text: text}
}

func toolText(r result) string { return r.Text }

// --- Tool: work_create ---

func TestWorkCreate(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_create", map[string]string{
		"type":          "story",
		"title":         "Login feature",
		"agent_role_id": ts.roleID,
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}

	text := toolText(result)
	if !strings.Contains(text, "Login feature") {
		t.Errorf("result = %q, want to contain title", text)
	}
	if !strings.Contains(text, "story") {
		t.Errorf("result = %q, want to contain type", text)
	}
}

func TestWorkCreate_InvalidType(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_create", map[string]string{
		"type":          "epic",
		"title":         "X",
		"agent_role_id": ts.roleID,
	})

	if !result.IsError {
		t.Error("expected error for invalid type")
	}
}

// --- Tool: work_list ---

func TestWorkList_Empty(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_list", map[string]string{})

	text := toolText(result)
	if text != "[]" {
		t.Errorf("expected empty JSON array, got %q", text)
	}
}

func TestWorkList_WithItems(t *testing.T) {
	ts := newTestExec(t)

	callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story A", "agent_role_id": ts.roleID,
	})
	callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story B", "agent_role_id": ts.roleID,
	})

	result := callTool(t, ts.exec, "work_list", map[string]string{})
	text := toolText(result)

	if !strings.Contains(text, "Story A") || !strings.Contains(text, "Story B") {
		t.Errorf("expected both stories in list, got %q", text)
	}
}

func TestWorkList_FilterByParentID(t *testing.T) {
	ts := newTestExec(t)

	storyResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Parent Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(storyResult))

	callTool(t, ts.exec, "work_create", map[string]string{
		"type": "task", "parent_id": storyID, "title": "Child Task", "agent_role_id": ts.roleID,
	})

	callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Other Story", "agent_role_id": ts.roleID,
	})

	result := callTool(t, ts.exec, "work_list", map[string]string{"parent_id": storyID})
	text := toolText(result)

	if !strings.Contains(text, "Child Task") {
		t.Errorf("expected child task, got %q", text)
	}
	if strings.Contains(text, "Parent Story") || strings.Contains(text, "Other Story") {
		t.Errorf("should not contain non-child items, got %q", text)
	}
}

// --- Tool: work_update ---

func TestWorkUpdate(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Old Title", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_update", map[string]string{
		"id": id, "title": "New Title",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "New Title") {
		t.Errorf("result = %q, want to contain new title", toolText(result))
	}
}

func TestWorkUpdate_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_update", map[string]string{
		"id": "nonexistent", "title": "X",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_get ---

func TestWorkGet(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "My Story", "body": "Details here", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_get", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	text := toolText(result)
	if !strings.Contains(text, "My Story") {
		t.Errorf("result = %q, want to contain title", text)
	}
	if !strings.Contains(text, "Details here") {
		t.Errorf("result = %q, want to contain body", text)
	}
}

func TestWorkGet_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_get", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_delete ---

func TestWorkDelete(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Delete Me", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_delete", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "Deleted") {
		t.Errorf("result = %q, want to contain 'Deleted'", toolText(result))
	}

	getResult := callTool(t, ts.exec, "work_get", map[string]string{"id": id})
	if !getResult.IsError {
		t.Error("expected error when getting deleted work")
	}
}

func TestWorkDelete_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_delete", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_start ---

func TestWorkStart(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Start Me", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_start", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	text := toolText(result)
	if !strings.Contains(text, "Started") {
		t.Errorf("result = %q, want to contain 'Started'", text)
	}
	if !strings.Contains(text, "session:") {
		t.Errorf("result = %q, want to contain 'session:'", text)
	}

	w, found, err := ts.store.Get(id)
	if err != nil || !found {
		t.Fatal("work not found after start")
	}
	if w.Status != work.StatusInProgress {
		t.Errorf("status = %q, want in_progress", w.Status)
	}
	if w.SessionID == "" {
		t.Error("session_id should be set after start")
	}
}

func TestWorkStart_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "work_start", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

func TestWorkStart_AlreadyInProgress(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	callTool(t, ts.exec, "work_start", map[string]string{"id": id})

	result := callTool(t, ts.exec, "work_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for already in_progress work")
	}
}

func TestWorkStart_NoAgentRole(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))
	empty := ""
	ts.store.Update(context.Background(), id, work.UpdateFields{AgentRoleID: &empty})

	result := callTool(t, ts.exec, "work_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for work without agent_role_id")
	}
}

// --- Tool: work_needs_input ---

func TestWorkNeedsInput(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	callTool(t, ts.exec, "work_start", map[string]string{"id": id})

	result := callTool(t, ts.exec, "work_needs_input", map[string]string{
		"id": id, "reason": "Need clarification on requirements",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	text := toolText(result)
	if !strings.Contains(text, "waiting for user input") {
		t.Errorf("result = %q, want to contain 'waiting for user input'", text)
	}
	if !strings.Contains(text, "Need clarification on requirements") {
		t.Errorf("result = %q, want to contain reason", text)
	}

	w, found, err := ts.store.Get(id)
	if err != nil || !found {
		t.Fatal("work not found after needs_input")
	}
	if w.Status != work.StatusNeedsInput {
		t.Errorf("status = %q, want needs_input", w.Status)
	}
}

func TestWorkNeedsInput_NotInProgress(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_needs_input", map[string]string{
		"id": id, "reason": "some reason",
	})
	if !result.IsError {
		t.Error("expected error for needs_input from open status")
	}
}

// --- Tool: agent_role_list ---

func TestAgentRoleList(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "agent_role_list", map[string]string{})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}

	text := toolText(result)
	if !strings.Contains(text, "Test Engineer") {
		t.Errorf("expected role list to contain 'Test Engineer', got %q", text)
	}
	if strings.Contains(text, "role_prompt") {
		t.Error("agent_role_list should not include role_prompt; use agent_role_get for details")
	}
}

// --- Tool: agent_role_get ---

func TestAgentRoleGet(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "agent_role_get", map[string]string{"id": ts.roleID})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}

	text := toolText(result)
	if !strings.Contains(text, "Test Engineer") {
		t.Errorf("result = %q, want to contain name", text)
	}
	if !strings.Contains(text, "You are a test engineer.") {
		t.Errorf("result = %q, want to contain role_prompt", text)
	}
}

func TestAgentRoleGet_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "agent_role_get", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: agent_role_reset_defaults ---

func TestAgentRoleResetDefaults(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "agent_role_reset_defaults", map[string]string{})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "reset to defaults") {
		t.Errorf("result = %q, want to contain 'reset to defaults'", toolText(result))
	}
}

// --- Tool: work_comment_add ---

func TestWorkCommentAdd(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_comment_add", map[string]string{
		"work_id": id, "body": "my comment",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "Comment added") {
		t.Errorf("result = %q, want to contain 'Comment added'", toolText(result))
	}
}

func TestWorkCommentAdd_WorkNotFound(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "work_comment_add", map[string]string{
		"work_id": "nonexistent", "body": "hello",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent work ID")
	}
}

// --- Tool: work_comment_list ---

func TestWorkCommentList_Empty(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_comment_list", map[string]string{"work_id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if toolText(result) != "[]" {
		t.Errorf("expected empty JSON array, got %q", toolText(result))
	}
}

func TestWorkCommentList_WithComments(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	callTool(t, ts.exec, "work_comment_add", map[string]string{
		"work_id": id, "body": "first comment",
	})
	callTool(t, ts.exec, "work_comment_add", map[string]string{
		"work_id": id, "body": "second comment",
	})

	result := callTool(t, ts.exec, "work_comment_list", map[string]string{"work_id": id})

	text := toolText(result)
	if !strings.Contains(text, "first comment") || !strings.Contains(text, "second comment") {
		t.Errorf("expected both comments in list, got %q", text)
	}
}

// --- Tool: work_comment_update ---

func TestWorkCommentUpdate(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	workID := extractID(t, toolText(createResult))

	addResult := callTool(t, ts.exec, "work_comment_add", map[string]string{
		"work_id": workID, "body": "original",
	})
	commentID := extractCommentID(t, toolText(addResult))

	result := callTool(t, ts.exec, "work_comment_update", map[string]string{
		"id": commentID, "body": "edited",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "edited") {
		t.Errorf("result = %q, want to contain 'edited'", toolText(result))
	}

	listResult := callTool(t, ts.exec, "work_comment_list", map[string]string{"work_id": workID})
	if !strings.Contains(toolText(listResult), "edited") {
		t.Errorf("list should show edited comment, got %q", toolText(listResult))
	}
}

func TestWorkCommentUpdate_NotFound(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "work_comment_update", map[string]string{
		"id": "nonexistent", "body": "text",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent comment ID")
	}
}

// --- step_done / work_wait ---

func TestStepDone_AdvancesStep(t *testing.T) {
	exec, store, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "Multi-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Implement", "Step 3: Test"},
	})

	result := callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, exec, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": roleID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, exec, "work_start", map[string]string{"id": id})

	result = callTool(t, exec, "step_done", map[string]string{"id": id})
	text := toolText(result)

	if !strings.Contains(text, "Step 1 completed") {
		t.Errorf("expected step 1 completed message, got %q", text)
	}
	if !strings.Contains(text, "advancing to step 2") {
		t.Errorf("expected advancing to step 2 message, got %q", text)
	}

	w, _, _ := store.Get(id)
	if w.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", w.CurrentStep)
	}
	if w.Status != work.StatusInProgress {
		t.Errorf("Status = %s, want in_progress", w.Status)
	}
}

func TestStepDone_LastStep(t *testing.T) {
	exec, store, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "Two-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Execute"},
	})

	result := callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, exec, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": roleID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, exec, "work_start", map[string]string{"id": id})

	callTool(t, exec, "step_done", map[string]string{"id": id})

	result = callTool(t, exec, "step_done", map[string]string{"id": id})
	text := toolText(result)

	if !strings.Contains(text, "final step") {
		t.Errorf("expected final step message, got %q", text)
	}
	if !strings.Contains(text, "closed") {
		t.Errorf("expected closed message, got %q", text)
	}

	w, _, _ := store.Get(id)
	if w.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1 (should not advance past last step)", w.CurrentStep)
	}
	if w.Status != work.StatusClosed {
		t.Errorf("Status = %s, want closed", w.Status)
	}
}

func TestStepDone_NoSteps(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": ts.roleID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, ts.exec, "work_start", map[string]string{"id": id})

	result = callTool(t, ts.exec, "step_done", map[string]string{"id": id})
	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "closed") {
		t.Errorf("expected closed message, got %q", toolText(result))
	}

	w, _, _ := ts.store.Get(id)
	if w.Status != work.StatusClosed {
		t.Errorf("Status = %s, want closed", w.Status)
	}
}

func TestWorkWait_StoryWithPendingChildWaits(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": ts.roleID, "parent_id": storyID,
	})
	taskID := extractID(t, toolText(result))

	callTool(t, ts.exec, "work_start", map[string]string{"id": storyID})
	callTool(t, ts.exec, "work_start", map[string]string{"id": taskID})

	result = callTool(t, ts.exec, "work_wait", map[string]string{"id": storyID})
	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "waiting for child work") {
		t.Errorf("expected waiting message, got %q", toolText(result))
	}

	w, _, _ := ts.store.Get(storyID)
	if w.Status != work.StatusWaiting {
		t.Errorf("Status = %s, want waiting", w.Status)
	}
}

func TestStepDone_StoryWithPendingChildCloses(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": ts.roleID, "parent_id": storyID,
	})
	taskID := extractID(t, toolText(result))

	callTool(t, ts.exec, "work_start", map[string]string{"id": storyID})
	callTool(t, ts.exec, "work_start", map[string]string{"id": taskID})

	result = callTool(t, ts.exec, "step_done", map[string]string{"id": storyID})
	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "closed") {
		t.Errorf("expected closed message, got %q", toolText(result))
	}

	w, _, _ := ts.store.Get(storyID)
	if w.Status != work.StatusClosed {
		t.Errorf("Status = %s, want closed", w.Status)
	}
}

func TestExecute_UnknownTool(t *testing.T) {
	ts := newTestExec(t)
	_, err := ts.exec.Execute(context.Background(), "nonexistent_tool", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected error for unknown tool")
	}
	if !strings.Contains(err.Error(), "unknown tool") {
		t.Errorf("error = %q, want to mention unknown tool", err.Error())
	}
}

// --- New API-path behavior ---

// When the start handler fails, the claim must be rolled back so the work does
// not get stuck in_progress with a dangling session.
func TestWorkStart_RollbackOnHandlerFailure(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	exec := NewExecutor(store, arStore, failingWorkStarter{err: errStartFailed}, stubNotifier{}, settingsStore)

	created := callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": roleID,
	})
	id := extractID(t, toolText(created))

	res := callTool(t, exec, "work_start", map[string]string{"id": id})
	if !res.IsError {
		t.Fatal("expected error result when start handler fails")
	}

	w, _, _ := store.Get(id)
	if w.Status != work.StatusOpen {
		t.Errorf("status = %q, want open (rolled back)", w.Status)
	}
	if w.SessionID != "" {
		t.Errorf("session_id = %q, want cleared after rollback", w.SessionID)
	}
}

// step_done must request the next-step prompt for the agent. The fsnotify-driven
// Trigger E does not fire for in-process changes, so the executor must notify.
func TestStepDone_NotifiesNextStep(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{
		Name: "Eng", RolePrompt: "x", Steps: []string{"Plan", "Build"},
	})
	spy := &spyNotifier{}
	exec := NewExecutor(store, arStore, stubWorkStarter{}, spy, settingsStore)

	storyID := extractID(t, toolText(callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "work_create", map[string]string{
		"type": "task", "title": "T", "agent_role_id": roleID, "parent_id": storyID,
	})))
	callTool(t, exec, "work_start", map[string]string{"id": taskID})

	callTool(t, exec, "step_done", map[string]string{"id": taskID})

	if len(spy.stepDone) != 1 {
		t.Fatalf("NotifyStepDone called %d times, want 1", len(spy.stepDone))
	}
	if spy.stepDone[0].CurrentStep != 1 {
		t.Errorf("notified CurrentStep = %d, want 1 (advanced)", spy.stepDone[0].CurrentStep)
	}
}

// The final step closes the work; there is no next step to prompt, so no
// notification should be sent.
func TestStepDone_NoNotifyOnClose(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{
		Name: "Eng", RolePrompt: "x", Steps: []string{"Only"},
	})
	spy := &spyNotifier{}
	exec := NewExecutor(store, arStore, stubWorkStarter{}, spy, settingsStore)

	storyID := extractID(t, toolText(callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "work_create", map[string]string{
		"type": "task", "title": "T", "agent_role_id": roleID, "parent_id": storyID,
	})))
	callTool(t, exec, "work_start", map[string]string{"id": taskID})

	callTool(t, exec, "step_done", map[string]string{"id": taskID})

	if len(spy.stepDone) != 0 {
		t.Errorf("NotifyStepDone called %d times on close, want 0", len(spy.stepDone))
	}
}

func TestWorkReopen_NotifiesReopen(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	spy := &spyNotifier{}
	exec := NewExecutor(store, arStore, stubWorkStarter{}, spy, settingsStore)

	id := extractID(t, toolText(callTool(t, exec, "work_create", map[string]string{
		"type": "story", "title": "S", "agent_role_id": roleID,
	})))
	callTool(t, exec, "work_start", map[string]string{"id": id})
	callTool(t, exec, "step_done", map[string]string{"id": id}) // no steps → closes

	res := callTool(t, exec, "work_reopen", map[string]string{"id": id})
	if res.IsError {
		t.Fatalf("unexpected error: %s", toolText(res))
	}
	if len(spy.reopen) != 1 {
		t.Errorf("NotifyReopen called %d times, want 1", len(spy.reopen))
	}
}

// agent_role_reset_defaults must also repoint the default agent role in settings
// (parity with the WebSocket handler), otherwise the default dangles at a
// deleted role.
func TestAgentRoleResetDefaults_UpdatesDefaultRole(t *testing.T) {
	store, arStore, settingsStore, _ := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	// Seed a stale default pointing at a role that the reset will delete.
	if err := settingsStore.Update(settings.Settings{DefaultAgentRoleID: "stale-role-id"}); err != nil {
		t.Fatal(err)
	}
	exec := NewExecutor(store, arStore, stubWorkStarter{}, stubNotifier{}, settingsStore)

	if res := callTool(t, exec, "agent_role_reset_defaults", map[string]string{}); res.IsError {
		t.Fatalf("unexpected error: %s", toolText(res))
	}

	defaultID := settingsStore.Get().DefaultAgentRoleID
	if defaultID == "" || defaultID == "stale-role-id" {
		t.Fatalf("default role = %q, want repointed to a fresh role", defaultID)
	}
	if _, found, err := arStore.Get(defaultID); err != nil || !found {
		t.Errorf("default role %q does not exist after reset", defaultID)
	}
}

// --- Helpers ---

// extractID parses "Created story "title" (ID: xxx)" to extract the ID.
func extractID(t *testing.T, text string) string {
	t.Helper()
	const prefix = "(ID: "
	idx := strings.Index(text, prefix)
	if idx < 0 {
		t.Fatalf("cannot find ID in %q", text)
	}
	rest := text[idx+len(prefix):]
	end := strings.Index(rest, ")")
	if end < 0 {
		t.Fatalf("cannot find closing paren in %q", text)
	}
	return rest[:end]
}

// extractCommentID parses "Comment added (ID: xxx)" to get xxx.
func extractCommentID(t *testing.T, s string) string {
	t.Helper()
	const prefix = "(ID: "
	idx := strings.Index(s, prefix)
	if idx < 0 {
		t.Fatalf("no ID found in %q", s)
	}
	start := idx + len(prefix)
	end := strings.Index(s[start:], ")")
	if end < 0 {
		t.Fatalf("no closing paren in %q", s)
	}
	return s[start : start+end]
}
