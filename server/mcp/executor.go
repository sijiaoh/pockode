package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
	"github.com/pockode/server/worktree"
)

// ErrUnknownTool indicates a tools/call referenced a tool that does not exist.
var ErrUnknownTool = errors.New("unknown tool")

// userError marks an error as caused by the caller's input — a malformed
// argument, a missing/invalid ID, a not-found lookup — rather than a server
// fault. Both kinds are still returned to the AI as an is_error tool result
// (MCP reports tool errors to the model, not the transport); the distinction
// only governs logging, so a routine "the AI asked for something that doesn't
// exist" is not logged as a server fault. See APIHandler and isUserError.
type userError struct{ err error }

func (e *userError) Error() string { return e.err.Error() }
func (e *userError) Unwrap() error { return e.err }

func userErrorf(format string, a ...any) error {
	return &userError{err: fmt.Errorf(format, a...)}
}

// isUserError reports whether err was caused by the caller's input rather than a
// server fault. Work store sentinels (not-found / invalid transition) are
// caller errors too, so they count even when they reach here unwrapped.
func isUserError(err error) bool {
	var ue *userError
	if errors.As(err, &ue) {
		return true
	}
	return errors.Is(err, work.ErrWorkNotFound) ||
		errors.Is(err, work.ErrInvalidWork) ||
		errors.Is(err, work.ErrCommentNotFound) ||
		// A question the agent asked about is gone, or it asked one nobody
		// could have answered. Both are things an agent gets wrong in the
		// ordinary course of running, not faults of this server.
		errors.Is(err, chat.ErrQuestionNotPending) ||
		errors.Is(err, chat.ErrAnswerShape) ||
		errors.Is(err, chat.ErrSessionNotFound)
}

// SettingsStore is the slice of the settings store the executor needs to keep
// the default agent role in sync on agent_role_reset_defaults (parity with the
// WebSocket handler).
type SettingsStore interface {
	Get() settings.Settings
	Update(settings.Settings) error
}

// WorktreeProvisioner makes a named worktree usable, creating it when it does
// not exist yet. It is the one worktree operation the AI can reach, and
// worktree.Registry — the same implementation behind the worktree.create RPC —
// is what satisfies it.
type WorktreeProvisioner interface {
	EnsureWorktree(name string) (created bool, setupHookSkip *worktree.SetupHookSkip, err error)
}

// WorkEngine is the part of work.Engine the question tools reach: what happens
// to a work item when its agent posts a question, and when somebody answers
// one. Satisfied by *work.Engine.
//
// It is here rather than reached through work.Operations because neither of
// these is a command anybody issued against a work item — they are things that
// happened to its session, which is what the engine's inputs are.
type WorkEngine interface {
	// HandleQuestionPosted passes a subtask's question up to the story above
	// it, if it has one and that story is running.
	HandleQuestionPosted(sessionID string, q session.PendingQuestion)
	// HandleAnswer wakes the answered work and gives it its nudge allowance
	// back. It is the same input the user's own answers go through: an answer
	// starts a turn there whoever gave it.
	HandleAnswer(sessionID string)
}

// Executor runs MCP tool calls against the live server stores. It is the
// in-process counterpart to the stdio proxy: the proxy (running inside the AI
// CLI subprocess) forwards each tool call over HTTP, and the Executor performs
// the actual work using the same stores and work.Operations as the WebSocket
// handlers. This keeps the server as the single writer of work data.
type Executor struct {
	workStore      work.Store
	agentRoleStore agentrole.Store
	workOps        *work.Operations
	settingsStore  SettingsStore
	worktrees      WorktreeProvisioner
	sessions       Sessions
	workEngine     WorkEngine
}

// SetWorkEngine installs what the question tools report to. Left unset, a
// question posted reaches no parent story and an answer resets no nudge
// allowance — which is what the narrow tests in this package want; the server
// always sets it.
func (e *Executor) SetWorkEngine(engine WorkEngine) {
	e.workEngine = engine
}

// NewExecutor creates an Executor. workOps performs every work transition and
// its side effects — the same operations the WebSocket layer calls, which is
// what keeps a tool call and a tap on a button the same act; it is required
// whenever any work_* tool is reachable. settingsStore keeps the default agent
// role in sync on reset; a nil settingsStore skips that update. worktrees
// prepares the worktree story_start names, and like workOps is required
// whenever the work_* tools are reachable. sessions is the session layer the
// question_* tools act on, and is required whenever those are reachable. Nils
// are tolerated only where the corresponding tools are unreachable (e.g. narrow
// tests).
func NewExecutor(workStore work.Store, agentRoleStore agentrole.Store, workOps *work.Operations, settingsStore SettingsStore, worktrees WorktreeProvisioner, sessions Sessions) *Executor {
	return &Executor{workStore: workStore, agentRoleStore: agentRoleStore, workOps: workOps, settingsStore: settingsStore, worktrees: worktrees, sessions: sessions}
}

// Execute runs the named tool and returns its text result. It returns a
// wrapped ErrUnknownTool when the name is not recognized.
//
// caller is the session the call came from; it is passed per call rather than
// held on the Executor because one Executor serves every session at once.
func (e *Executor) Execute(ctx context.Context, caller Caller, name string, args json.RawMessage) (string, error) {
	switch name {
	case "story_list":
		return e.storyList()
	case "task_list":
		return e.taskList(args)
	case "story_create":
		return e.storyCreate(ctx, args)
	case "task_create":
		return e.taskCreate(ctx, args)
	case "work_update":
		return e.workUpdate(ctx, args)
	case "work_get":
		return e.workGet(args)
	case "work_delete":
		return e.workDelete(ctx, args)
	case "story_start":
		return e.storyStart(ctx, caller, args)
	case "task_start":
		return e.taskStart(ctx, args)
	case "work_reopen":
		return e.workReopen(ctx, args)
	case "story_wait":
		return e.storyWait(ctx, args)
	case "step_done":
		return e.stepDone(ctx, args)
	case "work_comment_add":
		return e.workCommentAdd(ctx, args)
	case "work_comment_list":
		return e.workCommentList(args)
	case "work_comment_update":
		return e.workCommentUpdate(ctx, args)
	case "agent_role_list":
		return e.agentRoleList()
	case "agent_role_get":
		return e.agentRoleGet(args)
	case "agent_role_reset_defaults":
		return e.agentRoleResetDefaults(ctx)
	case "question_post":
		return e.questionPost(ctx, caller, args)
	case "question_cancel":
		return e.questionCancel(ctx, caller, args)
	case "question_answer":
		return e.questionAnswer(ctx, caller, args)
	default:
		return "", fmt.Errorf("%w: %s", ErrUnknownTool, name)
	}
}

// workSummary is one entry of a story_list / task_list result: enough for the
// agent to pick an item and walk the story/task tree, and nothing more.
//
// Body is left out to contain prompt injection, not to save bytes. A body is
// user-authored instructions, so a list that carried them would let every
// unrelated work item in the project speak into the agent's context on a call
// the agent made to find one item. Reading a body has to be the deliberate act
// of asking for that item — which is what work_get is. Same rule, same reason,
// for agent_role_list and role_prompt; see the security section of
// docs/projects/api.md. The saved context is real but incidental: do not let it
// argue the field back in if a listing ever looks cheap enough.
//
// It is named apart from rpc.WorkListItem (server/rpc/types.go), and is
// deliberately not that type. rpc.WorkListItem is the row the web list draws,
// and its extra fields exist for the UI: session_id maps rows to the session
// list, worktree feeds a badge, updated_at orders the closed group. None of them
// mean anything to an agent, and sharing the type would let a field added for a
// badge widen every agent's list output.
type workSummary struct {
	ID string `json:"id"`
	// Type is derived from StoryID, never stored, and is sent beside it so an
	// agent reads a work item's kind the same way here as the web client does on
	// a row (rpc.WorkListItem).
	Type        string `json:"type"`
	StoryID     string `json:"story_id,omitempty"`
	AgentRoleID string `json:"agent_role_id,omitempty"`
	Status      string `json:"status"`
	Title       string `json:"title"`
}

// workDetail is what work_get returns: the summary plus the one field a summary
// is not allowed to carry. It is built from the summary rather than beside it,
// so that relationship holds by construction and the two shapes cannot drift
// into disagreeing about the same field.
type workDetail struct {
	workSummary
	Body string `json:"body,omitempty"`
	// PendingQuestions are the questions this work's session has asked and
	// nobody has answered. They are on the detail rather than the summary for
	// the same reason Body is — they are the item's own content, not a fact a
	// list of other people's work needs — and they are here at all so an agent
	// reading a work it did not run can see what it is waiting on.
	PendingQuestions []session.PendingQuestion `json:"pending_questions,omitempty"`
}

// newWorkSummary narrows a work item to its summary. Every tool that returns one
// goes through here, so the narrowing — and the derivation of Type — is decided
// in one place.
func newWorkSummary(w work.Work) workSummary {
	return workSummary{
		ID:          w.ID,
		Type:        string(w.Type()),
		StoryID:     w.StoryID,
		AgentRoleID: w.AgentRoleID,
		Status:      string(w.Status),
		Title:       w.Title,
	}
}

func (e *Executor) storyList() (string, error) {
	works, err := e.workStore.List()
	if err != nil {
		return "", err
	}

	var stories []work.Work
	for _, w := range works {
		if w.Type() == work.WorkTypeStory {
			stories = append(stories, w)
		}
	}
	return marshalSummaries(stories)
}

func (e *Executor) taskList(args json.RawMessage) (string, error) {
	var params struct {
		StoryID string `json:"story_id"`
	}
	if len(args) > 0 {
		if err := json.Unmarshal(args, &params); err != nil {
			return "", userErrorf("invalid arguments: %w", err)
		}
	}
	// Not defensiveness about a missing argument: an empty story_id is what a
	// story's own StoryID is, so work.TasksOf would be being asked a question
	// with no answer. Saying so beats the empty list a silent fall-through
	// would return.
	if params.StoryID == "" {
		return "", userErrorf("story_id is required: name the story whose tasks you want, or call story_list to see the stories")
	}

	works, err := e.workStore.List()
	if err != nil {
		return "", err
	}
	return marshalSummaries(work.TasksOf(works, params.StoryID))
}

// marshalSummaries renders a listing. Always a JSON array, for consistent
// parsing by the AI agent: formatted text would risk prompt injection via
// user-supplied titles.
func marshalSummaries(works []work.Work) (string, error) {
	items := make([]workSummary, len(works))
	for i, w := range works {
		items[i] = newWorkSummary(w)
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal work list: %w", err)
	}
	return string(b), nil
}

func (e *Executor) storyCreate(ctx context.Context, args json.RawMessage) (string, error) {
	return e.createWork(ctx, args, "")
}

func (e *Executor) taskCreate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		StoryID string `json:"story_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if params.StoryID == "" {
		return "", userErrorf("story_id is required: a task belongs to a story. Use story_create for a top-level story")
	}
	return e.createWork(ctx, args, params.StoryID)
}

// createWork is the whole of both creation tools. storyID is what the tool the
// agent picked decides — nothing in the arguments can contradict it, which is
// why the split removed the type argument rather than validating it.
func (e *Executor) createWork(ctx context.Context, args json.RawMessage, storyID string) (string, error) {
	var params struct {
		Title       string `json:"title"`
		Body        string `json:"body"`
		AgentRoleID string `json:"agent_role_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	// Validate agent_role_id is provided and exists
	if params.AgentRoleID == "" {
		return "", userErrorf("agent_role_id is required")
	}
	if _, found, err := e.agentRoleStore.Get(params.AgentRoleID); err != nil {
		return "", fmt.Errorf("failed to validate agent role: %w", err)
	} else if !found {
		return "", userErrorf("agent role %q not found", params.AgentRoleID)
	}

	created, err := e.workStore.Create(ctx, work.Work{
		StoryID:     storyID,
		Title:       params.Title,
		Body:        params.Body,
		AgentRoleID: params.AgentRoleID,
	})
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Created %s %q (ID: %s)", created.Type(), created.Title, created.ID), nil
}

func (e *Executor) workUpdate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID          string  `json:"id"`
		Title       *string `json:"title"`
		Body        *string `json:"body"`
		AgentRoleID *string `json:"agent_role_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	// Validate agent_role_id exists if specified
	if params.AgentRoleID != nil && *params.AgentRoleID != "" {
		if _, found, err := e.agentRoleStore.Get(*params.AgentRoleID); err != nil {
			return "", fmt.Errorf("failed to validate agent role: %w", err)
		} else if !found {
			return "", userErrorf("agent role %q not found", *params.AgentRoleID)
		}
	}

	fields := work.UpdateFields{
		Title:       params.Title,
		Body:        params.Body,
		AgentRoleID: params.AgentRoleID,
	}
	if err := e.workStore.Update(ctx, params.ID, fields); err != nil {
		return "", err
	}

	var parts []string
	if params.Title != nil {
		parts = append(parts, fmt.Sprintf("title to %q", *params.Title))
	}
	if params.Body != nil {
		parts = append(parts, "body")
	}
	if params.AgentRoleID != nil {
		parts = append(parts, "agent_role_id")
	}
	if len(parts) == 0 {
		return fmt.Sprintf("Updated work %s (no fields changed)", params.ID), nil
	}
	return fmt.Sprintf("Updated work %s %s", params.ID, strings.Join(parts, " and ")), nil
}

func (e *Executor) workGet(args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	w, found, err := e.workStore.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", userErrorf("work %s not found", params.ID)
	}

	b, err := json.Marshal(workDetail{
		workSummary:      newWorkSummary(w),
		Body:             w.Body,
		PendingQuestions: e.pendingQuestions(w),
	})
	if err != nil {
		return "", fmt.Errorf("marshal work item: %w", err)
	}
	return string(b), nil
}

// pendingQuestions reads the unanswered questions of the session a work runs
// in, or none when it has no session, no session layer to ask, or a worktree
// that cannot be read. A work item whose questions cannot be listed is still
// worth returning: none of the rest of the detail depends on them.
func (e *Executor) pendingQuestions(w work.Work) []session.PendingQuestion {
	if w.SessionID == "" || e.sessions == nil {
		return nil
	}
	turns, err := e.sessions.SessionTurns(w.Worktree)
	if err != nil {
		slog.Warn("could not read session turns for work_get",
			"workId", w.ID, "worktree", w.Worktree, "error", err)
		return nil
	}
	return turns[w.SessionID].Unanswered
}

func (e *Executor) workDelete(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	if err := e.workOps.DeleteWork(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Deleted work %s", params.ID), nil
}

// storyStart's watch is a flag rather than a session id, and the session it
// names is always the caller's own. That is the question tools' rule
// (question_post posts into the caller's chat without being told which): an
// agent has no business choosing whom Pockode wakes, a model asked for an id
// would sooner or later pass one it half-remembers, and the one session that
// certainly wants the news is the one asking for it. It is the story_wait
// shape too — the session that declares a wait is the one woken when it ends.
func (e *Executor) storyStart(ctx context.Context, caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		ID       string `json:"id"`
		Worktree string `json:"worktree"`
		Watch    bool   `json:"watch"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	var watcher *work.Watcher
	if params.Watch {
		if caller.SessionID == "" {
			return "", errNoCallerSession("story_start with watch", "there is no chat to wake with the story's news; call it without watch")
		}
		watcher = &work.Watcher{SessionID: caller.SessionID, Worktree: caller.Worktree}
	}
	return e.startWork(ctx, params.ID, params.Worktree, watcher)
}

// taskStart takes no worktree, which is the only difference between the two
// start tools: a task runs where its story runs, so there is nothing to choose.
// assignWorktree still refuses a task that is named to story_start, because an
// id is a string and the agent can reach for the wrong tool.
//
// It reads the argument anyway, in order to refuse one. Leaving it off the
// struct would drop it silently, and an agent that asked to place this task
// somewhere would be told nothing while its request was discarded — the same
// call story_start answers with a sentence. What is not in the schema is
// refused, not ignored.
func (e *Executor) taskStart(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID       string `json:"id"`
		Worktree string `json:"worktree"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	if params.Worktree != "" {
		return "", userErrorf("task_start takes no worktree: a task runs in the worktree of the story it belongs to. Start that story in %q with story_start instead", params.Worktree)
	}
	return e.startWork(ctx, params.ID, "", nil)
}

// startWork is both start tools. It deliberately does not check that the id it
// was given is of the kind the tool names: starting is the same act for a story
// and a task, and the only thing that actually forks is the worktree, which the
// two schemas and assignWorktree already settle between them. Refusing
// story_start on a task would reject a call whose outcome is correct — an id is
// a string, and an agent that reached for the neighbouring tool still asked for
// something this can do.
func (e *Executor) startWork(ctx context.Context, id, worktree string, watcher *work.Watcher) (string, error) {
	var note string
	if worktree != "" {
		var err error
		if note, err = e.assignWorktree(ctx, id, worktree); err != nil {
			return "", err
		}
	}

	w, err := e.workOps.StartWork(ctx, id, watcher)
	if err != nil {
		return "", err
	}

	if watcher != nil {
		note += ". This chat is watching it: you will get a message when it closes, is stopped, or asks a question of its own"
	}
	return fmt.Sprintf("Started work %s (session: %s)%s", w.ID, w.SessionID, note), nil
}

// assignWorktree pins a story to the named worktree, creating the worktree
// first when it does not exist yet, and returns what the caller should be told
// beyond "started": which worktree it is in, whether it had to be created, and
// whether the setup hook was skipped while creating it.
//
// The pinning goes through the store before the worktree is created so the
// store stays the only place that decides whether a work may still change
// worktree; a work left pinned by a failed creation is still open, and the next
// start retries the creation.
func (e *Executor) assignWorktree(ctx context.Context, id, name string) (string, error) {
	w, found, err := e.workStore.Get(id)
	if err != nil {
		return "", err
	}
	if !found {
		return "", userErrorf("work %s not found", id)
	}
	// A story and its tasks share one worktree: a task runs where its story
	// runs, decided when the story started, and there is nothing left here to
	// choose.
	if w.StoryID != "" {
		return "", userErrorf("work %s is a task: only a story can choose a worktree, and a task runs in the worktree of the story it belongs to. Start its story %s in %q instead", id, w.StoryID, name)
	}

	if err := e.workStore.SetWorktree(ctx, id, name); err != nil {
		return "", err
	}

	created, skip, err := e.worktrees.EnsureWorktree(name)
	if err != nil {
		return "", fmt.Errorf("prepare worktree %q: %w", name, err)
	}

	note := fmt.Sprintf(" in worktree %q", name)
	if created {
		note += " (created)"
	}
	if skip != nil {
		note += fmt.Sprintf(". Its setup hook did not run: %s (%s)", skip.Reason, skip.Hint)
	}
	return note, nil
}

func (e *Executor) workReopen(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	if err := e.workOps.ReopenWork(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Reopened work %s", params.ID), nil
}

func (e *Executor) storyWait(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	if err := e.workOps.Wait(ctx, params.ID); err != nil {
		return "", err
	}

	return fmt.Sprintf("Story %s is now waiting for its tasks to complete", params.ID), nil
}

func (e *Executor) stepDone(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	// Read before the advance: what the agent just finished is the step the work
	// is on now, and the reply is written from the agent's point of view.
	w, found, err := e.workStore.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", work.ErrWorkNotFound
	}

	hasMoreSteps, totalSteps, err := e.workOps.StepDone(ctx, params.ID)
	if err != nil {
		return "", err
	}

	if hasMoreSteps {
		return fmt.Sprintf("Step %d completed for work %s, advancing to step %d of %d",
			w.CurrentStep+1, params.ID, w.CurrentStep+2, totalSteps), nil
	}
	// A role with no steps at all: there was no step to report, only a work that
	// is now finished.
	if totalSteps == 0 {
		return fmt.Sprintf("Work %s closed", params.ID), nil
	}
	return fmt.Sprintf("Step %d (final step) completed for work %s. Work is now closed.",
		w.CurrentStep+1, params.ID), nil
}

func (e *Executor) workCommentAdd(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
		Body   string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	comment, err := e.workStore.AddComment(ctx, params.WorkID, params.Body)
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("Comment added (ID: %s)", comment.ID), nil
}

func (e *Executor) workCommentList(args json.RawMessage) (string, error) {
	var params struct {
		WorkID string `json:"work_id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	comments, err := e.workStore.ListComments(params.WorkID)
	if err != nil {
		return "", err
	}

	type commentItem struct {
		ID        string `json:"id"`
		WorkID    string `json:"work_id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
	}
	items := make([]commentItem, len(comments))
	for i, c := range comments {
		items[i] = commentItem{
			ID:        c.ID,
			WorkID:    c.WorkID,
			Body:      c.Body,
			CreatedAt: c.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
		}
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal comment list: %w", err)
	}
	return string(b), nil
}

func (e *Executor) workCommentUpdate(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		ID   string `json:"id"`
		Body string `json:"body"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	comment, err := e.workStore.UpdateComment(ctx, params.ID, params.Body)
	if err != nil {
		return "", err
	}

	type commentDetail struct {
		ID        string `json:"id"`
		WorkID    string `json:"work_id"`
		Body      string `json:"body"`
		CreatedAt string `json:"created_at"`
	}
	b, err := json.Marshal(commentDetail{
		ID:        comment.ID,
		WorkID:    comment.WorkID,
		Body:      comment.Body,
		CreatedAt: comment.CreatedAt.Format("2006-01-02T15:04:05Z07:00"),
	})
	if err != nil {
		return "", fmt.Errorf("marshal comment: %w", err)
	}
	return string(b), nil
}

func (e *Executor) agentRoleList() (string, error) {
	roles, err := e.agentRoleStore.List()
	if err != nil {
		return "", err
	}

	type roleItem struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	items := make([]roleItem, len(roles))
	for i, r := range roles {
		items[i] = roleItem{
			ID:   r.ID,
			Name: r.Name,
		}
	}
	b, err := json.Marshal(items)
	if err != nil {
		return "", fmt.Errorf("marshal agent role list: %w", err)
	}
	return string(b), nil
}

func (e *Executor) agentRoleGet(args json.RawMessage) (string, error) {
	var params struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}

	role, found, err := e.agentRoleStore.Get(params.ID)
	if err != nil {
		return "", err
	}
	if !found {
		return "", userErrorf("agent role %q not found", params.ID)
	}

	type roleDetail struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		RolePrompt string `json:"role_prompt"`
	}
	b, err := json.Marshal(roleDetail{
		ID:         role.ID,
		Name:       role.Name,
		RolePrompt: role.RolePrompt,
	})
	if err != nil {
		return "", fmt.Errorf("marshal agent role: %w", err)
	}
	return string(b), nil
}

func (e *Executor) agentRoleResetDefaults(ctx context.Context) (string, error) {
	pmRoleID, err := e.agentRoleStore.ResetDefaults(ctx)
	if err != nil {
		return "", err
	}

	// Repoint the default agent role to the new PM role, like the WebSocket
	// handler. Otherwise settings.DefaultAgentRoleID dangles at the now-deleted
	// old role, which breaks the settings UI and settings.update validation.
	if e.settingsStore != nil {
		s := e.settingsStore.Get()
		s.DefaultAgentRoleID = pmRoleID
		if err := e.settingsStore.Update(s); err != nil {
			slog.Error("failed to set default agent role after reset", "error", err)
		}
	}

	return "Agent roles reset to defaults", nil
}
