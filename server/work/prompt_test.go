package work

import (
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

func assertContains(t *testing.T, msg, substr, label string) {
	t.Helper()
	if !strings.Contains(msg, substr) {
		t.Errorf("expected %s (%q) in message:\n%s", label, substr, msg)
	}
}

func TestBuildKickoffMessage_Task(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		AgentRoleID: testRoleID,
		Title:       "Fix the bug",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, testRoleID, "agent role ID")
	assertContains(t, msg, "agent_role_get", "agent_role_get instruction")
	assertContains(t, msg, "Fix the bug", "task title")
	assertContains(t, msg, "task-1", "work ID")
	assertContains(t, msg, "agent role", "agent-role-driven lifecycle instruction")
	assertContains(t, msg, "`step_done` with ID task-1", "step_done instruction")
	assertContains(t, msg, "`work_needs_input` with ID task-1", "needs-input instruction")

	if strings.Contains(msg, "COORDINATOR") {
		t.Error("task message should not contain story coordination rules")
	}
	// A task has no children, so the tool it would wait on is not offered to it.
	if strings.Contains(msg, "work_wait") {
		t.Error("task message should not mention work_wait")
	}
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testRoleID,
		Title:       "Big feature",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, "Big feature", "story title")
	assertContains(t, msg, "`work_wait` with ID story-1", "work_wait instruction")
	assertContains(t, msg, "`step_done` with ID story-1", "step_done instruction")
	assertContains(t, msg, "rejects a `step_done` that would close a story with active subtasks",
		"the rule that a story waits for its tasks instead of closing over them")
}

// The coordinator rules are the half of a story prompt that is not in the
// lifecycle section, and they reached no story at all while they were built from
// a package-level var (see storyBehaviorRules). Asserting the text itself is
// what makes that a failure rather than a comparison against "".
func TestBuildKickoffMessage_StoryCarriesTheCoordinatorRules(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S",
	})

	assertContains(t, msg, "You are a COORDINATOR for this story", "coordinator opening")
	assertContains(t, msg, "work_create", "task breakdown instruction")
	assertContains(t, msg, "Do NOT call step_done on child tasks", "child lifecycle rule")
}

// Every number the lifecycle section quotes at the agent is a promise about what
// the server does, so each is read from the constant that governs it.
func TestLifecycleRules_QuoteTheLimitsTheServerActuallyKeeps(t *testing.T) {
	msg := BuildKickoffMessage(Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"})

	assertContains(t, msg, "after "+strconv.Itoa(DefaultMaxNudges)+" of those in a row", "the nudge allowance")
	assertContains(t, msg, "("+humanDuration(session.DefaultAnswerBudget)+" by default)", "the answer budget")
}

func TestHumanDuration(t *testing.T) {
	for _, tc := range []struct {
		in   time.Duration
		want string
	}{
		{time.Hour, "an hour"},
		{3 * time.Hour, "3 hours"},
		{time.Minute, "a minute"},
		{90 * time.Second, "1m30s"},
		{30 * time.Minute, "30 minutes"},
	} {
		if got := humanDuration(tc.in); got != tc.want {
			t.Errorf("humanDuration(%s) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// The chat-versus-work guidance is the one piece of the redesign an agent can
// only learn from the prompt: nothing about AskUserQuestion tells it that the
// question holds a process open.
func TestLifecycleRules_SendLongWaitsToWorkNeedsInput(t *testing.T) {
	msg := BuildKickoffMessage(Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"})

	assertContains(t, msg, "AskUserQuestion", "the tool the guidance is about")
	assertContains(t, msg, "a turn ended that way stops the work", "the cost of an unanswered question")
	assertContains(t, msg, "call `work_needs_input` and end the turn", "what to do instead")
}

func TestBuildKickoffMessage_RoleRefComesFirst(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T",
	})

	roleIdx := strings.Index(msg, testRoleID)
	workIdx := strings.Index(msg, "You are working on")
	if roleIdx < 0 || workIdx < 0 || roleIdx >= workIdx {
		t.Error("role reference should appear before work context")
	}
}

func TestBuildAutoContinuationMessage_ContainsBaseAndNudge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		w     Work
		nudge string
	}{
		{
			"task",
			Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"},
			"Your last turn ended without moving this task along",
		},
		{
			"story",
			Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"},
			"Your last turn ended without moving this story along",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := BuildKickoffMessage(tc.w)
			cont := BuildAutoContinuationMessage(tc.w)

			if !strings.Contains(cont, base) {
				t.Error("auto-continuation should contain the full kickoff base")
			}
			assertContains(t, cont, tc.nudge, "nudge")
		})
	}
}

func TestBuildKickoffMessage_TaskWithParent_ReportViaComment(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		ParentID:    "story-1",
		AgentRoleID: testRoleID,
		Title:       "Fix bug",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, "work_comment_list", "work_comment_list instruction for parent comments")
	assertContains(t, msg, "work_comment_add", "work_comment_add instruction")
	assertContains(t, msg, "story-1", "parent work ID")
	assertContains(t, msg, "`step_done` with ID task-1", "step_done instruction")
}

func TestBuildKickoffMessage_TaskWithoutParent_NoCommentInstruction(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		AgentRoleID: testRoleID,
		Title:       "Fix bug",
	}

	msg := BuildKickoffMessage(w)

	if strings.Contains(msg, "work_comment_add") {
		t.Error("task without parent should not mention work_comment_add")
	}
	if strings.Contains(msg, "work_comment_list") {
		t.Error("task without parent should not mention work_comment_list")
	}
}

func TestBuildRestartMessage_ContainsBaseAndNudge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		w     Work
		nudge string
	}{
		{
			"task",
			Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"},
			"Your task was stopped and is now being restarted",
		},
		{
			"story",
			Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"},
			"Your story was stopped and is now being restarted",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := BuildKickoffMessage(tc.w)
			restart := BuildRestartMessage(tc.w)

			if !strings.Contains(restart, base) {
				t.Error("restart message should contain the full kickoff base")
			}
			assertContains(t, restart, tc.nudge, "nudge")
		})
	}
}

func TestFormatStepSection(t *testing.T) {
	tests := []struct {
		name     string
		steps    []string
		index    int
		wantNil  bool
		contains []string
	}{
		{
			name:    "empty steps",
			steps:   []string{},
			index:   0,
			wantNil: true,
		},
		{
			name:    "negative index",
			steps:   []string{"Step 1"},
			index:   -1,
			wantNil: true,
		},
		{
			name:    "index out of bounds",
			steps:   []string{"Step 1"},
			index:   1,
			wantNil: true,
		},
		{
			name:     "first step of three",
			steps:    []string{"Do A", "Do B", "Do C"},
			index:    0,
			contains: []string{"## Current Step", "Step 1 of 3", "Do A"},
		},
		{
			name:     "second step of three",
			steps:    []string{"Do A", "Do B", "Do C"},
			index:    1,
			contains: []string{"Step 2 of 3", "Do B"},
		},
		{
			name:     "last step of three",
			steps:    []string{"Do A", "Do B", "Do C"},
			index:    2,
			contains: []string{"Step 3 of 3", "Do C"},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			result := formatStepSection("test-work-id", tc.steps, tc.index)
			if tc.wantNil {
				if result != "" {
					t.Errorf("expected empty string, got %q", result)
				}
				return
			}
			for _, s := range tc.contains {
				assertContains(t, result, s, s)
			}
		})
	}
}

func TestBuildKickoffMessageWithSteps_NoSteps(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"}

	msgWithoutSteps := BuildKickoffMessage(w)
	msgWithEmptySteps := BuildKickoffMessageWithSteps(w, []string{}, 0)

	if msgWithoutSteps != msgWithEmptySteps {
		t.Error("empty steps should produce same message as no steps")
	}
}

func TestBuildKickoffMessageWithSteps_WithSteps(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"}
	steps := []string{"Implement feature", "Write tests", "Update docs"}

	msg := BuildKickoffMessageWithSteps(w, steps, 0)

	// Should contain base message
	base := BuildKickoffMessage(w)
	if !strings.Contains(msg, base) {
		t.Error("message should contain base kickoff")
	}

	// Should contain step info
	assertContains(t, msg, "## Current Step", "step header")
	assertContains(t, msg, "Step 1 of 3", "step number")
	assertContains(t, msg, "Implement feature", "step content")
}

func TestBuildStepAdvanceMessage_Format(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"}

	msg := BuildStepAdvanceMessage(w, "Write tests", 2, 3)

	// Should contain base message
	base := BuildKickoffMessage(w)
	if !strings.Contains(msg, base) {
		t.Error("message should contain base kickoff")
	}

	// Should contain completion notice and new step
	assertContains(t, msg, "Step 1 of 3 completed", "completion notice")
	assertContains(t, msg, "## Current Step", "step header")
	assertContains(t, msg, "Step 2 of 3", "new step number")
	assertContains(t, msg, "Write tests", "step content")
}

func TestBuildAutoContinuationMessageWithSteps_NoSteps(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"}

	msgWithoutSteps := BuildAutoContinuationMessage(w)
	msgWithEmptySteps := BuildAutoContinuationMessageWithSteps(w, []string{}, 0)

	if msgWithoutSteps != msgWithEmptySteps {
		t.Error("empty steps should produce same message as no steps")
	}
}

func TestBuildAutoContinuationMessageWithSteps_WithSteps(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T", CurrentStep: 1}
	steps := []string{"Implement feature", "Write tests", "Update docs"}

	msg := BuildAutoContinuationMessageWithSteps(w, steps, w.CurrentStep)

	// Should contain base message
	base := BuildKickoffMessage(w)
	if !strings.Contains(msg, base) {
		t.Error("message should contain base kickoff")
	}

	// Should contain step info and step completion check prompt
	assertContains(t, msg, "## Current Step", "step header")
	assertContains(t, msg, "Step 2 of 3", "step number")
	assertContains(t, msg, "Write tests", "step content")
	assertContains(t, msg, "ended on step 2 of 3", "step context")
	assertContains(t, msg, "If YES and this is NOT the last step: Call step_done", "step_done instruction")
	assertContains(t, msg, "If YES and this IS the last step: Call step_done", "step_done instruction")
	assertContains(t, msg, "If NO: Continue working", "no instruction")
}

func TestBuildAutoContinuationMessageWithSteps_Story(t *testing.T) {
	w := Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"}
	steps := []string{"Step 1", "Step 2"}

	msg := BuildAutoContinuationMessageWithSteps(w, steps, 0)

	assertContains(t, msg, "## Current Step", "step header")
	assertContains(t, msg, "Step 1 of 2", "step number")
	assertContains(t, msg, "ended on step 1 of 2", "step context")
}

func TestBuildAutoContinuationMessageWithSteps_InvalidIndex(t *testing.T) {
	w := Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"}
	steps := []string{"Step 1", "Step 2"}

	// Invalid index should fall back to standard message
	for _, idx := range []int{-1, 2, 100} {
		msg := BuildAutoContinuationMessageWithSteps(w, steps, idx)
		expected := BuildAutoContinuationMessage(w)
		if msg != expected {
			t.Errorf("index %d should fall back to standard message", idx)
		}
	}
}

func TestBuildReopenMessage_ContainsBaseAndNudge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		w     Work
		nudge string
	}{
		{
			"task",
			Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testRoleID, Title: "T"},
			"This task has been reopened",
		},
		{
			"story",
			Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"},
			"This story has been reopened",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			base := BuildKickoffMessage(tc.w)
			reopen := BuildReopenMessage(tc.w)

			if !strings.Contains(reopen, base) {
				t.Error("reopen message should contain the full kickoff base")
			}
			assertContains(t, reopen, tc.nudge, "nudge")
		})
	}
}

// Every message the engine sends carries the lifecycle section, and none of them
// may carry the vocabulary it replaced: an agent told its work is "in_progress"
// will go looking for a status the store cannot produce. Checked over every
// send site rather than over prompts.yaml, because a stale word can just as
// easily be appended in Go.
func TestEverySystemMessage_SpeaksTheCurrentVocabulary(t *testing.T) {
	story := Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"}
	task := Work{ID: "t1", Type: WorkTypeTask, ParentID: "s1", AgentRoleID: testRoleID, Title: "T"}
	steps := []string{"Do A", "Do B"}

	messages := map[string]string{}
	for _, w := range []Work{story, task} {
		prefix := string(w.Type)
		messages[prefix+" kickoff"] = BuildKickoffMessageWithSteps(w, steps, 0)
		messages[prefix+" restart"] = BuildRestartMessage(w)
		messages[prefix+" auto_continue"] = BuildAutoContinuationMessage(w)
		messages[prefix+" auto_continue with steps"] = BuildAutoContinuationMessageWithSteps(w, steps, 0)
		messages[prefix+" step_advance"] = BuildStepAdvanceMessage(w, "Do B", 2, 2)
		messages[prefix+" reopen"] = BuildReopenMessage(w)
	}
	messages["child_done"] = BuildChildCompletionMessage(story, "Child", "c1", true)
	messages["child_done, wait standing"] = BuildChildCompletionMessage(story, "Child", "c1", false)
	for _, exit := range []childExit{childDeleted, childStopped, childNotStarted} {
		messages["wait_stranded, "+string(exit)] = BuildStrandedWaitMessage(story, "Child", "c1", exit)
	}

	for name, msg := range messages {
		for _, retired := range []string{"in_progress", "needs_input state", "still in_progress"} {
			if strings.Contains(msg, retired) {
				t.Errorf("%s message still says %q", name, retired)
			}
		}
		// The rules are what makes a message survive an agent that has lost all
		// memory of this work, so every send site has to carry them.
		assertContains(t, msg, "How Pockode drives this work", name+" lifecycle section")
	}
}

// A parent's wait is cleared by the very message telling it a child closed, so
// a story with two running tasks has to ask again or be nudged for going quiet.
func TestBuildChildCompletionMessage_TellsTheParentItsWaitIsGone(t *testing.T) {
	story := Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"}

	msg := BuildChildCompletionMessage(story, "Write the parser", "c1", true)

	assertContains(t, msg, "Write the parser", "child title")
	assertContains(t, msg, "This message cleared your wait", "the cleared wait")
	assertContains(t, msg, "call work_wait with ID s1 again", "how to wait again")

	// A parent waiting on the *user* keeps its wait (Engine.notifyParentOfChild),
	// and must not be told to replace it with a wait on its subtasks: the user
	// would stop being shown as the one being waited for.
	standing := BuildChildCompletionMessage(story, "Write the parser", "c1", false)
	if strings.Contains(standing, "cleared your wait") {
		t.Error("a parent whose wait still stands is told it was cleared")
	}
	if strings.Contains(standing, "call work_wait with ID s1 again") {
		t.Error("a parent whose wait still stands is told to wait again")
	}
	if strings.HasSuffix(standing, "\n") {
		t.Error("the omitted paragraph left a trailing blank line")
	}
}

// A stopped story is told nothing while it is stopped — child closures included —
// so the restart message is the only thing that can send it to look.
func TestBuildRestartMessage_SendsAStoryToRereadItsTasks(t *testing.T) {
	msg := BuildRestartMessage(Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"})

	assertContains(t, msg, "While a story is stopped Pockode sends it nothing", "why re-reading is needed")
	assertContains(t, msg, "work_list", "how to re-read the tasks")
	assertContains(t, msg, "work_comment_list", "how to read the reports")
}
