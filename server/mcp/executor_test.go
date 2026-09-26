package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
)

// stubWorkStarter satisfies work.WorkStartHandler without creating real
// sessions. The store transition (claim) is what the tests assert on; the
// kickoff side effects belong to integration tests in the worktree package.
type stubWorkStarter struct{}

func (stubWorkStarter) HandleWorkStart(context.Context, work.Work) error { return nil }

var errStartFailed = errors.New("start handler failed")

// failingWorkStarter always fails, to exercise the rollback path in a start.
type failingWorkStarter struct{ err error }

func (f failingWorkStarter) HandleWorkStart(context.Context, work.Work) error { return f.err }

// stubWorktrees stands in for the worktree registry: it records the names
// a start asked to prepare, and reports each one as newly created unless a
// test set skip or err.
type stubWorktrees struct {
	asked []string
	skip  *worktree.SetupHookSkip
	err   error
}

func (s *stubWorktrees) EnsureWorktree(name string) (bool, *worktree.SetupHookSkip, error) {
	s.asked = append(s.asked, name)
	if s.err != nil {
		return false, nil, s.err
	}
	return true, s.skip, nil
}

// stubSessions stands in for the session layer the question tools reach. The
// zero value knows no sessions and no questions, which is what every test that
// never posts one needs.
type stubSessions struct {
	questions  *stubQuestions
	turns      map[string]map[string]session.TurnState
	located    map[string][]worktree.QuestionLocation
	worktreeOf map[string]string
	askedFor   []string
	resolveErr error
}

func (s *stubSessions) ResolveQuestions(name string) (chat.Questions, func(), error) {
	s.askedFor = append(s.askedFor, name)
	if s.resolveErr != nil {
		return nil, nil, s.resolveErr
	}
	if s.questions == nil {
		s.questions = &stubQuestions{}
	}
	return s.questions, func() {}, nil
}

func (s *stubSessions) SessionTurns(name string) (map[string]session.TurnState, error) {
	return s.turns[name], nil
}

func (s *stubSessions) LocateQuestions(requestID string) []worktree.QuestionLocation {
	return s.located[requestID]
}

func (s *stubSessions) ResolveSessionWorktree(sessionID string) (string, error) {
	name, found := s.worktreeOf[sessionID]
	if !found {
		return "", worktree.ErrSessionNotFound
	}
	return name, nil
}

// stubQuestions records what the tools asked the chat layer to do.
type stubQuestions struct {
	posted    []chat.QuestionSpec
	postedFor []string
	cancelled []string
	// cancelledFor is the session each withdrawal was asked of, which is the
	// whole of "a session may only withdraw its own copy".
	cancelledFor []string
	answered     []stubAnswer
	postErr      error
	cancelErr    error
	answerErr    error
}

// stubAnswer is one delivered answer: what was said, to which session, by whom.
type stubAnswer struct {
	sessionID string
	answer    chat.Answer
	by        agent.QuestionResolver
}

func (q *stubQuestions) PostQuestion(_ context.Context, sessionID string, spec chat.QuestionSpec) (session.PendingQuestion, error) {
	if q.postErr != nil {
		return session.PendingQuestion{}, q.postErr
	}
	q.posted = append(q.posted, spec)
	q.postedFor = append(q.postedFor, sessionID)
	return session.PendingQuestion{
		RequestID: "req-1", Header: spec.Header, Question: spec.Question,
		Options: spec.Options, MultiSelect: spec.MultiSelect,
	}, nil
}

func (q *stubQuestions) AnswerQuestion(_ context.Context, sessionID string, a chat.Answer, by agent.QuestionResolver) error {
	if q.answerErr != nil {
		return q.answerErr
	}
	q.answered = append(q.answered, stubAnswer{sessionID: sessionID, answer: a, by: by})
	return nil
}

func (q *stubQuestions) CancelQuestion(_ context.Context, sessionID, requestID string) error {
	if q.cancelErr != nil {
		return q.cancelErr
	}
	q.cancelled = append(q.cancelled, requestID)
	q.cancelledFor = append(q.cancelledFor, sessionID)
	return nil
}

// stubNotifier satisfies work.Notifier as a no-op.
type stubNotifier struct{}

func (stubNotifier) NotifyStepDone(work.Work) {}
func (stubNotifier) NotifyReopen(work.Work)   {}

// spyNotifier records the works passed to each notification so tests can assert
// the in-process MCP path requests the follow-up messages.
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
	return NewExecutor(store, arStore, work.NewOperations(store, stubWorkStarter{}, stubNotifier{}, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{}), store, roleID
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
	text, err := e.Execute(context.Background(), Caller{}, name, raw)
	if err != nil {
		return result{Text: "Error: " + err.Error(), IsError: true}
	}
	return result{Text: text}
}

func toolText(r result) string { return r.Text }

// --- Tools: story_create / task_create ---

func TestStoryCreate(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "story_create", map[string]string{
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

// task_create makes a task of the story it names — that, and only that, is what
// separates it from story_create, so the created item is read back rather than
// the call merely being checked for an error.
func TestTaskCreate_MakesATaskOfTheNamedStory(t *testing.T) {
	ts := newTestExec(t)
	storyID := extractID(t, toolText(callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Parent Story", "agent_role_id": ts.roleID,
	})))

	taskID := extractID(t, toolText(callTool(t, ts.exec, "task_create", map[string]string{
		"story_id": storyID, "title": "Child Task", "agent_role_id": ts.roleID,
	})))

	task := decodeObject(t, toolText(callTool(t, ts.exec, "work_get", map[string]string{"id": taskID})))
	if got := stringField(t, task, "story_id"); got != storyID {
		t.Errorf("task story_id = %q, want %q", got, storyID)
	}
	if got := stringField(t, task, "type"); got != "task" {
		t.Errorf("task type = %q, want \"task\"", got)
	}

	story := decodeObject(t, toolText(callTool(t, ts.exec, "work_get", map[string]string{"id": storyID})))
	if _, ok := story["story_id"]; ok {
		t.Error("story carries a story_id key; it should be absent, not empty")
	}
	if got := stringField(t, story, "type"); got != "story" {
		t.Errorf("story type = %q, want \"story\"", got)
	}
}

// A task needs a story, and story_create is the tool for one without. Saying so
// beats creating a second story the agent did not ask for.
func TestTaskCreate_RefusesWithoutAStory(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "task_create", map[string]string{
		"title": "Orphan", "agent_role_id": ts.roleID,
	})
	if !result.IsError {
		t.Fatalf("task_create with no story_id was accepted: %q", toolText(result))
	}
	if !strings.Contains(toolText(result), "story_create") {
		t.Errorf("refusal does not name the tool to use instead: %q", toolText(result))
	}
}

// --- Tools: story_list / task_list ---

func TestStoryList_Empty(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "story_list", map[string]string{})

	text := toolText(result)
	if text != "[]" {
		t.Errorf("expected empty JSON array, got %q", text)
	}
}

// The two listings partition the project between them, and each one's whole job
// is the half it leaves out: a story_list with tasks in it is the tree the
// two-level shape removed, and a task_list that crosses stories is worse than
// no filter at all.
func TestStoryListAndTaskList_EachSeeOnlyTheirOwn(t *testing.T) {
	ts := newTestExec(t)

	storyA := extractID(t, toolText(callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story A", "agent_role_id": ts.roleID,
	})))
	storyB := extractID(t, toolText(callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story B", "agent_role_id": ts.roleID,
	})))
	callTool(t, ts.exec, "task_create", map[string]string{
		"story_id": storyA, "title": "Task of A", "agent_role_id": ts.roleID,
	})
	callTool(t, ts.exec, "task_create", map[string]string{
		"story_id": storyB, "title": "Task of B", "agent_role_id": ts.roleID,
	})

	for _, tc := range []struct {
		name  string
		args  map[string]string
		tool  string
		want  []string
		avoid []string
	}{
		{
			name: "story_list names every story and no task",
			tool: "story_list", args: map[string]string{},
			want: []string{"Story A", "Story B"}, avoid: []string{"Task of A", "Task of B"},
		},
		{
			name: "task_list names one story's tasks and nothing else",
			tool: "task_list", args: map[string]string{"story_id": storyA},
			want: []string{"Task of A"}, avoid: []string{"Task of B", "Story A", "Story B"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			titles := listedTitles(t, toolText(callTool(t, ts.exec, tc.tool, tc.args)))
			for _, title := range tc.want {
				if !slices.Contains(titles, title) {
					t.Errorf("%s is missing %q; got %v", tc.tool, title, titles)
				}
			}
			for _, title := range tc.avoid {
				if slices.Contains(titles, title) {
					t.Errorf("%s carries %q, which is not its own; got %v", tc.tool, title, titles)
				}
			}
		})
	}
}

// An empty story_id is what a story's own story_id is, so a fall-through would
// answer "which tasks?" with every story in the project, or with nothing.
func TestTaskList_RefusesWithoutAStory(t *testing.T) {
	ts := newTestExec(t)
	callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story A", "agent_role_id": ts.roleID,
	})

	result := callTool(t, ts.exec, "task_list", map[string]string{})
	if !result.IsError {
		t.Fatalf("task_list with no story_id was accepted: %q", toolText(result))
	}
	if !strings.Contains(toolText(result), "story_list") {
		t.Errorf("refusal does not name where to find a story: %q", toolText(result))
	}
}

// listedTitles reads the titles out of a listing result, in order.
func listedTitles(t *testing.T, text string) []string {
	t.Helper()
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &entries); err != nil {
		t.Fatalf("decode %q: %v", text, err)
	}
	titles := make([]string, len(entries))
	for i, entry := range entries {
		titles[i] = stringField(t, entry, "title")
	}
	return titles
}

// summaryKeys is the exact key set a listing entry carries. story_id is
// omitempty, so a task carries it and a story does not.
//
// Pinned exactly rather than as a "must not contain body" check: the thing that
// would go wrong here is someone widening workSummary — deciding an agent also
// wants the worktree, say — and a deny-list would wave that through. It is also
// why the story/task expectation is driven off the item's type rather than off
// which keys the entry happens to have.
func summaryKeys(isTask bool) []string {
	keys := []string{"id", "type", "agent_role_id", "status", "title"}
	if isTask {
		keys = append(keys, "story_id")
	}
	return keys
}

// assertKeys compares the object's key set against want, order-insensitively.
func assertKeys(t *testing.T, label string, obj map[string]json.RawMessage, want []string) {
	t.Helper()
	got := slices.Sorted(maps.Keys(obj))
	want = slices.Sorted(slices.Values(want))
	if !slices.Equal(got, want) {
		t.Errorf("%s keys = %v, want %v", label, got, want)
	}
}

// decodeObject decodes a tool result that is a single JSON object.
func decodeObject(t *testing.T, text string) map[string]json.RawMessage {
	t.Helper()
	var obj map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &obj); err != nil {
		t.Fatalf("decode %q: %v", text, err)
	}
	return obj
}

// stringField decodes one string-valued key of a decoded object.
func stringField(t *testing.T, obj map[string]json.RawMessage, key string) string {
	t.Helper()
	raw, ok := obj[key]
	if !ok {
		t.Fatalf("missing key %q", key)
	}
	var v string
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("decode %s: %v", key, err)
	}
	return v
}

// TestListings_CarryOnlySummaryFields is the guard for the summary/detail
// split: a listing is the call an agent makes to find one item, so it must not
// hand over the bodies of all the others. See workSummary. It also pins the
// derived `type` to its value: a listing that named every item a story would
// still carry the key, and the key alone is not what a reader groups by.
func TestListings_CarryOnlySummaryFields(t *testing.T) {
	ts := newTestExec(t)

	storyResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Parent Story", "body": "Long prose the list must not carry",
		"agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(storyResult))
	callTool(t, ts.exec, "task_create", map[string]string{
		"story_id": storyID, "title": "Child Task",
		"body": "More prose", "agent_role_id": ts.roleID,
	})
	// Starting the story gives it a session_id and moves it to active, so
	// the assertion covers a running work item and not only a freshly created
	// one — session_id is exactly the kind of field that could leak into a summary.
	callTool(t, ts.exec, "story_start", map[string]string{"id": storyID})

	for _, tc := range []struct {
		tool     string
		args     map[string]string
		title    string
		wantType string
		isTask   bool
	}{
		{"story_list", map[string]string{}, "Parent Story", "story", false},
		{"task_list", map[string]string{"story_id": storyID}, "Child Task", "task", true},
	} {
		text := toolText(callTool(t, ts.exec, tc.tool, tc.args))
		var entries []map[string]json.RawMessage
		if err := json.Unmarshal([]byte(text), &entries); err != nil {
			t.Fatalf("decode %q: %v", text, err)
		}

		var entry map[string]json.RawMessage
		for _, e := range entries {
			if stringField(t, e, "title") == tc.title {
				entry = e
			}
		}
		if entry == nil {
			t.Fatalf("%s is missing %q; got %q", tc.tool, tc.title, text)
		}
		assertKeys(t, tc.title, entry, summaryKeys(tc.isTask))
		if got := stringField(t, entry, "type"); got != tc.wantType {
			t.Errorf("%s: %s type = %q, want %q", tc.tool, tc.title, got, tc.wantType)
		}
	}
}

// TestWorkGet_DetailIsSummaryPlusBody pins the other half of the split: what a
// listing withholds must still be reachable for the one item the agent named.
func TestWorkGet_DetailIsSummaryPlusBody(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "My Story", "body": "Details here", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "work_get", map[string]string{"id": id})
	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	detail := decodeObject(t, toolText(result))
	assertKeys(t, "detail", detail, append(summaryKeys(false), "body"))

	for key, want := range map[string]string{"title": "My Story", "body": "Details here"} {
		if got := stringField(t, detail, key); got != want {
			t.Errorf("%s = %q, want %q", key, got, want)
		}
	}
}

// --- Tool: work_update ---

func TestWorkUpdate(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Old Title", "agent_role_id": ts.roleID,
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

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Delete Me", "agent_role_id": ts.roleID,
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

// --- Tools: story_start / task_start ---

func TestStoryStart(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Start Me", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.exec, "story_start", map[string]string{"id": id})

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
	if w.Status != work.StatusActive {
		t.Errorf("status = %q, want %q", w.Status, work.StatusActive)
	}
	if w.SessionID == "" {
		t.Error("session_id should be set after start")
	}
}

func TestStoryStart_NotFound(t *testing.T) {
	ts := newTestExec(t)
	result := callTool(t, ts.exec, "story_start", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

func TestStoryStart_AlreadyActive(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	callTool(t, ts.exec, "story_start", map[string]string{"id": id})

	result := callTool(t, ts.exec, "story_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for a work that is already active")
	}
}

func TestStoryStart_NoAgentRole(t *testing.T) {
	ts := newTestExec(t)

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))
	empty := ""
	ts.store.Update(context.Background(), id, work.UpdateFields{AgentRoleID: &empty})

	result := callTool(t, ts.exec, "story_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for work without agent_role_id")
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

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
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

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
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

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
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

	createResult := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": ts.roleID,
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

// --- step_done / story_wait ---

func TestStepDone_AdvancesStep(t *testing.T) {
	exec, store, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "Multi-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Implement", "Step 3: Test"},
	})

	result := callTool(t, exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, exec, "task_create", map[string]string{
		"title": "Test Task", "agent_role_id": roleID, "story_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, exec, "story_start", map[string]string{"id": id})

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
	if w.Status != work.StatusActive {
		t.Errorf("Status = %s, want %s", w.Status, work.StatusActive)
	}
}

func TestStepDone_LastStep(t *testing.T) {
	exec, store, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "Two-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Execute"},
	})

	result := callTool(t, exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, exec, "task_create", map[string]string{
		"title": "Test Task", "agent_role_id": roleID, "story_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, exec, "story_start", map[string]string{"id": id})

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

	result := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "task_create", map[string]string{
		"title": "Test Task", "agent_role_id": ts.roleID, "story_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, ts.exec, "story_start", map[string]string{"id": id})

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

func TestStoryWait_StoryWithPendingChildWaits(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "task_create", map[string]string{
		"title": "Test Task", "agent_role_id": ts.roleID, "story_id": storyID,
	})
	taskID := extractID(t, toolText(result))

	callTool(t, ts.exec, "story_start", map[string]string{"id": storyID})
	callTool(t, ts.exec, "task_start", map[string]string{"id": taskID})

	result = callTool(t, ts.exec, "story_wait", map[string]string{"id": storyID})
	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "waiting for its tasks") {
		t.Errorf("expected waiting message, got %q", toolText(result))
	}

	w, _, _ := ts.store.Get(storyID)
	if w.Status != work.StatusActive || w.Wait != work.WaitChild {
		t.Errorf("status/wait = %q/%q, want active/child", w.Status, w.Wait)
	}
}

// A story does not finish while its subtasks are still running, and the refusal
// has to be usable: it names the blockers, because an agent told only that some
// exist will guess which (docs/lifecycle-ui.md §7).
func TestStepDone_RefusesToCloseAStoryWithActiveSubtasks(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "task_create", map[string]string{
		"title": "Reducer", "agent_role_id": ts.roleID, "story_id": storyID,
	})
	taskID := extractID(t, toolText(result))

	callTool(t, ts.exec, "story_start", map[string]string{"id": storyID})
	callTool(t, ts.exec, "task_start", map[string]string{"id": taskID})

	result = callTool(t, ts.exec, "step_done", map[string]string{"id": storyID})
	if !result.IsError {
		t.Fatalf("expected a refusal, got %q", toolText(result))
	}
	for _, want := range []string{`"Reducer"`, "story_wait", "The step was not completed"} {
		if !strings.Contains(toolText(result), want) {
			t.Errorf("refusal %q does not mention %q", toolText(result), want)
		}
	}

	w, _, _ := ts.store.Get(storyID)
	if w.Status != work.StatusActive {
		t.Errorf("Status = %s, want active — a refused step_done moves nothing", w.Status)
	}
}

// The other side of the same rule: a subtask that is no longer active is not a
// blocker, so the story closes.
func TestStepDone_ClosesAStoryWhoseSubtasksAreDone(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	result = callTool(t, ts.exec, "task_create", map[string]string{
		"title": "Test Task", "agent_role_id": ts.roleID, "story_id": storyID,
	})
	taskID := extractID(t, toolText(result))

	callTool(t, ts.exec, "story_start", map[string]string{"id": storyID})
	callTool(t, ts.exec, "task_start", map[string]string{"id": taskID})
	callTool(t, ts.exec, "step_done", map[string]string{"id": taskID})

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
	_, err := ts.exec.Execute(context.Background(), Caller{}, "nonexistent_tool", json.RawMessage(`{}`))
	if err == nil {
		t.Fatal("expected error for unknown tool")
	}
	if !strings.Contains(err.Error(), "unknown tool") {
		t.Errorf("error = %q, want to mention unknown tool", err.Error())
	}
}

// --- New API-path behavior ---

// When the start handler fails, the claim must be rolled back so the work does
// not get stuck active with a dangling session.
func TestStoryStart_RollbackOnHandlerFailure(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	exec := NewExecutor(store, arStore, work.NewOperations(store, failingWorkStarter{err: errStartFailed}, stubNotifier{}, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{})

	created := callTool(t, exec, "story_create", map[string]string{
		"title": "Story", "agent_role_id": roleID,
	})
	id := extractID(t, toolText(created))

	res := callTool(t, exec, "story_start", map[string]string{"id": id})
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

// step_done must request the next-step prompt for the agent: in-process
// mutations don't auto-trigger a follow-up, so the executor must notify.
func TestStepDone_NotifiesNextStep(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{
		Name: "Eng", RolePrompt: "x", Steps: []string{"Plan", "Build"},
	})
	spy := &spyNotifier{}
	exec := NewExecutor(store, arStore, work.NewOperations(store, stubWorkStarter{}, spy, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{})

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "task_create", map[string]string{
		"title": "T", "agent_role_id": roleID, "story_id": storyID,
	})))
	callTool(t, exec, "task_start", map[string]string{"id": taskID})

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
	exec := NewExecutor(store, arStore, work.NewOperations(store, stubWorkStarter{}, spy, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{})

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "task_create", map[string]string{
		"title": "T", "agent_role_id": roleID, "story_id": storyID,
	})))
	callTool(t, exec, "task_start", map[string]string{"id": taskID})

	callTool(t, exec, "step_done", map[string]string{"id": taskID})

	if len(spy.stepDone) != 0 {
		t.Errorf("NotifyStepDone called %d times on close, want 0", len(spy.stepDone))
	}
}

func TestWorkReopen_NotifiesReopen(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	spy := &spyNotifier{}
	exec := NewExecutor(store, arStore, work.NewOperations(store, stubWorkStarter{}, spy, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{})

	id := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))
	callTool(t, exec, "story_start", map[string]string{"id": id})
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
	exec := NewExecutor(store, arStore, work.NewOperations(store, stubWorkStarter{}, stubNotifier{}, agentrole.Steps{Store: arStore}), settingsStore, &stubWorktrees{}, &stubSessions{})

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

// TestEveryAdvertisedToolIsDispatchable guards the two independent tool lists —
// the toolDefinitions advertised via tools/list and the Execute dispatch switch
// — against drift. A tool the AI can see but the server cannot run is a silent
// dead end, so assert every advertised name resolves to a handler.
func TestEveryAdvertisedToolIsDispatchable(t *testing.T) {
	ts := newTestExec(t)
	for _, td := range toolDefinitions {
		// Empty args: a handler may reject them as a user error, but it must not
		// report the tool itself as unknown.
		_, err := ts.exec.Execute(context.Background(), Caller{}, td.Name, json.RawMessage("{}"))
		if errors.Is(err, ErrUnknownTool) {
			t.Errorf("tool %q is advertised via tools/list but not dispatched by Execute", td.Name)
		}
	}
	// Negative control: an unadvertised name must be reported as unknown, so the
	// assertion above can actually fail.
	if _, err := ts.exec.Execute(context.Background(), Caller{}, "definitely_not_a_tool", json.RawMessage("{}")); !errors.Is(err, ErrUnknownTool) {
		t.Errorf("unknown tool: got %v, want ErrUnknownTool", err)
	}
}

// TestIsUserError verifies the classification that keeps caller mistakes out of
// the server's Error logs (see APIHandler). The wrapped-sentinel case is the
// load-bearing one: store errors reach the classifier wrapped, so it must match
// by errors.Is, not by identity.
func TestIsUserError(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want bool
	}{
		{"userErrorf", userErrorf("bad input"), true},
		{"wrapped work-not-found", fmt.Errorf("context: %w", work.ErrWorkNotFound), true},
		{"invalid transition", work.ErrInvalidWork, true},
		{"comment not found", work.ErrCommentNotFound, true},
		{"server fault", errors.New("disk write failed"), false},
	}
	for _, tt := range tests {
		if got := isUserError(tt.err); got != tt.want {
			t.Errorf("%s: isUserError = %v, want %v", tt.name, got, tt.want)
		}
	}
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

// A role with exactly one step: the agent finished a step, and saying "work
// closed" would drop the only step report it was going to get. The reply is
// written from the step count the call actually used, not from where the work
// happened to be sitting.
func TestStepDone_SingleStepRoleReportsTheStep(t *testing.T) {
	exec, _, roleID := newExecWithRole(t, agentrole.AgentRole{
		Name:       "One-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Do the thing"},
	})

	result := callTool(t, exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": roleID,
	})
	id := extractID(t, toolText(result))
	callTool(t, exec, "story_start", map[string]string{"id": id})

	text := toolText(callTool(t, exec, "step_done", map[string]string{"id": id}))

	if !strings.Contains(text, "Step 1 (final step)") {
		t.Errorf("result = %q, want it to name the step that was completed", text)
	}
}

// A role with no steps has none to report — the work simply closed.
func TestStepDone_SteplessRoleReportsOnlyTheClose(t *testing.T) {
	ts := newTestExec(t)

	result := callTool(t, ts.exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(result))
	callTool(t, ts.exec, "story_start", map[string]string{"id": id})

	text := toolText(callTool(t, ts.exec, "step_done", map[string]string{"id": id}))

	if !strings.Contains(text, "closed") || strings.Contains(text, "Step") {
		t.Errorf("result = %q, want it to report a close and no step", text)
	}
}

// countingDeleter stands in for the worktree manager: what a delete cascades to.
type countingDeleter struct{ sessionIDs []string }

func (c *countingDeleter) DeleteSessions(_ context.Context, _ string, sessionIDs []string) {
	c.sessionIDs = append(c.sessionIDs, sessionIDs...)
}

// The AI's work_delete deletes as much as the user's does. The cascade used to
// live in the WebSocket handler, so the two entry points left different amounts
// behind — a session with no work is unreachable, its work being the only way in.
func TestWorkDelete_CascadesToSessionsLikeTheUsersDelete(t *testing.T) {
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{
		Name: "Test Engineer", RolePrompt: "You are a test engineer.",
	})
	ops := work.NewOperations(store, stubWorkStarter{}, stubNotifier{}, agentrole.Steps{Store: arStore})
	deleter := &countingDeleter{}
	ops.SetSessionDeleter(deleter)
	exec := NewExecutor(store, arStore, ops, settingsStore, &stubWorktrees{}, &stubSessions{})

	result := callTool(t, exec, "story_create", map[string]string{
		"title": "Test Story", "agent_role_id": roleID,
	})
	storyID := extractID(t, toolText(result))
	if _, err := store.Start(context.Background(), storyID, "sess-1"); err != nil {
		t.Fatal(err)
	}

	if result := callTool(t, exec, "work_delete", map[string]string{"id": storyID}); result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}

	if len(deleter.sessionIDs) != 1 || deleter.sessionIDs[0] != "sess-1" {
		t.Errorf("cascaded to %v, want [sess-1]", deleter.sessionIDs)
	}
}

// --- story_start's worktree argument ---

// newExecWithWorktrees builds an executor over a stub registry the test can
// inspect, which is what the worktree argument's behavior is observed through.
func newExecWithWorktrees(t *testing.T) (*Executor, work.Store, string, *stubWorktrees) {
	t.Helper()
	store, arStore, settingsStore, roleID := newStoresWithRole(t, agentrole.AgentRole{Name: "Eng", RolePrompt: "x"})
	worktrees := &stubWorktrees{}
	ops := work.NewOperations(store, stubWorkStarter{}, stubNotifier{}, agentrole.Steps{Store: arStore})
	return NewExecutor(store, arStore, ops, settingsStore, worktrees, &stubSessions{}), store, roleID, worktrees
}

func TestStoryStart_WorktreePinsStoryAndCreatesIt(t *testing.T) {
	exec, store, roleID, worktrees := newExecWithWorktrees(t)

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))

	res := callTool(t, exec, "story_start", map[string]string{"id": storyID, "worktree": "feature-x"})
	if res.IsError {
		t.Fatalf("unexpected error: %s", toolText(res))
	}
	if !strings.Contains(toolText(res), "feature-x") {
		t.Errorf("result = %q, want it to name the worktree", toolText(res))
	}

	if !slices.Equal(worktrees.asked, []string{"feature-x"}) {
		t.Errorf("prepared %v, want [feature-x]", worktrees.asked)
	}
	if w, _, _ := store.Get(storyID); w.Worktree != "feature-x" {
		t.Errorf("story worktree = %q, want %q", w.Worktree, "feature-x")
	}
}

// A task runs where its story runs, so there is nothing for it to choose — and
// honoring the argument would split one subtree across two worktrees.
func TestStoryStart_WorktreeRejectedForTask(t *testing.T) {
	exec, store, roleID, worktrees := newExecWithWorktrees(t)

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "task_create", map[string]string{
		"title": "T", "agent_role_id": roleID, "story_id": storyID,
	})))

	res := callTool(t, exec, "story_start", map[string]string{"id": taskID, "worktree": "feature-x"})
	if !res.IsError {
		t.Fatal("expected an error result for a task")
	}
	if !strings.Contains(toolText(res), "story") {
		t.Errorf("error = %q, want it to explain that only a story chooses a worktree", toolText(res))
	}

	if len(worktrees.asked) != 0 {
		t.Errorf("prepared %v, want nothing created for a rejected start", worktrees.asked)
	}
	if w, _, _ := store.Get(taskID); w.Status != work.StatusOpen {
		t.Errorf("task status = %q, want open (not started)", w.Status)
	}
}

// A worktree is not on task_start's schema, and what is not on the schema is
// refused rather than dropped. Before the split the same call was refused by
// assignWorktree; a task_start that simply left the field off its struct would
// start the task in its story's worktree and say nothing, leaving the agent
// believing it had placed the task somewhere it did not.
func TestTaskStart_RefusesAWorktreeRatherThanIgnoringIt(t *testing.T) {
	exec, store, roleID, worktrees := newExecWithWorktrees(t)

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))
	taskID := extractID(t, toolText(callTool(t, exec, "task_create", map[string]string{
		"title": "T", "agent_role_id": roleID, "story_id": storyID,
	})))

	res := callTool(t, exec, "task_start", map[string]string{"id": taskID, "worktree": "feature-x"})
	if !res.IsError {
		t.Fatalf("task_start accepted a worktree and said nothing: %q", toolText(res))
	}
	if !strings.Contains(toolText(res), "story_start") {
		t.Errorf("error = %q, want it to name the tool that does take a worktree", toolText(res))
	}

	if len(worktrees.asked) != 0 {
		t.Errorf("prepared %v, want nothing created for a rejected start", worktrees.asked)
	}
	if w, _, _ := store.Get(taskID); w.Status != work.StatusOpen {
		t.Errorf("task status = %q, want open (not started)", w.Status)
	}
}

// A worktree whose setup hook was skipped looks exactly like a prepared one, so
// the skip has to reach the agent that asked for the worktree.
func TestStoryStart_ReportsSkippedSetupHook(t *testing.T) {
	exec, _, roleID, worktrees := newExecWithWorktrees(t)
	worktrees.skip = &worktree.SetupHookSkip{Reason: "bash not found", Hint: "delete the hook"}

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))

	res := callTool(t, exec, "story_start", map[string]string{"id": storyID, "worktree": "feature-x"})
	if res.IsError {
		t.Fatalf("unexpected error: %s", toolText(res))
	}
	if !strings.Contains(toolText(res), "bash not found") {
		t.Errorf("result = %q, want it to report the skipped setup hook", toolText(res))
	}
}

// A story must not start in a worktree that could not be prepared: the session
// would be created against a directory that is not there.
func TestStoryStart_WorktreeCreationFailureDoesNotStart(t *testing.T) {
	exec, store, roleID, worktrees := newExecWithWorktrees(t)
	worktrees.err = errors.New("git worktree add: exit status 128")

	storyID := extractID(t, toolText(callTool(t, exec, "story_create", map[string]string{
		"title": "S", "agent_role_id": roleID,
	})))

	res := callTool(t, exec, "story_start", map[string]string{"id": storyID, "worktree": "feature-x"})
	if !res.IsError {
		t.Fatal("expected an error result when the worktree cannot be prepared")
	}
	if !strings.Contains(toolText(res), "exit status 128") {
		t.Errorf("error = %q, want it to carry why the worktree could not be prepared", toolText(res))
	}

	if w, _, _ := store.Get(storyID); w.Status != work.StatusOpen {
		t.Errorf("story status = %q, want open (not started)", w.Status)
	}
}
