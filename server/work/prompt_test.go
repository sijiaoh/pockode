package work

import (
	"strconv"
	"strings"
	"testing"

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
		StoryID:     "story-1",
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
	assertContains(t, msg, "`question_post` is how you ask", "how to reach the user")

	if strings.Contains(msg, "COORDINATOR") {
		t.Error("task message should not contain story coordination rules")
	}
	// A task has no tasks, so the tool it would wait on is not offered to it.
	if strings.Contains(msg, "story_wait") {
		t.Error("task message should not mention story_wait")
	}
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:          "story-1",
		AgentRoleID: testRoleID,
		Title:       "Big feature",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, "Big feature", "story title")
	assertContains(t, msg, "`story_wait` with ID story-1", "story_wait instruction")
	assertContains(t, msg, "`step_done` with ID story-1", "step_done instruction")
	assertContains(t, msg, "rejects a `step_done` that would close a story with active subtasks",
		"the rule that a story waits for its tasks instead of closing over them")
}

// The lifecycle section is the *other* place a rule can be read before it is
// hit, and unlike a tool description it rides on every message, including the
// ones that land in a conversation with no memory of this work. The two
// subtask refusals are complementary, so naming one without the other is worse
// than naming neither: it tells a story to wait for its tasks a line above the
// only sentence that would have said when it may not.
func TestLifecycleRules_AnnounceBothSubtaskRefusals(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "s1", AgentRoleID: testRoleID, Title: "S",
	})

	assertContains(t, msg, "rejects a `step_done` that would close a story with active subtasks",
		"the step_done refusal")
	assertContains(t, msg, "rejects a `story_wait` when none of them is running",
		"the story_wait refusal")
}

// The coordinator rules are the half of a story prompt that is not in the
// lifecycle section, and they reached no story at all while they were built from
// a package-level var (see storyBehaviorRules). Asserting the text itself is
// what makes that a failure rather than a comparison against "".
func TestBuildKickoffMessage_StoryCarriesTheCoordinatorRules(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "s1", AgentRoleID: testRoleID, Title: "S",
	})

	assertContains(t, msg, "You are a COORDINATOR for this story", "coordinator opening")
	assertContains(t, msg, "using task_create, with story_id set to this story's ID", "task breakdown instruction")
	assertContains(t, msg, "Start the tasks you created with task_start, then wait for them with story_wait",
		"how the tasks are run")
	assertContains(t, msg, "Do NOT call step_done on your tasks", "task lifecycle rule")
}

// Every number the lifecycle section quotes at the agent is a promise about what
// the server does, so each is read from the constant that governs it.
func TestLifecycleRules_QuoteTheLimitsTheServerActuallyKeeps(t *testing.T) {
	msg := BuildKickoffMessage(Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"})

	assertContains(t, msg, "after "+strconv.Itoa(DefaultMaxNudges)+" of those in a row", "the nudge allowance")
}

// The two things an agent can only learn from the prompt, because nothing in
// either tool's own description says them: that its CLI's own ask-the-user tool
// is refused here, and that ending a turn with a posted question outstanding is
// not the accident an ordinary quiet ending is.
//
// The first is worth saying even though the model cannot see that tool in a
// Claude session — buildArgs takes it off the list — because the refusal is what
// happens if a CLI ever stops honouring the flag, and because Codex's
// counterpart is refused at the protocol rather than hidden.
func TestLifecycleRules_SendLongWaitsToQuestionPost(t *testing.T) {
	msg := BuildKickoffMessage(Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"})

	assertContains(t, msg, "does not reach the user here", "that the CLI's own ask tool goes nowhere")
	assertContains(t, msg, "question_post", "what to do instead")
	assertContains(t, msg, "does not nudge you and does not spend your allowance",
		"that a posted question makes an ending unsurprising")
}

func TestBuildKickoffMessage_RoleRefComesFirst(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T",
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
			Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"},
			"Your last turn ended without moving this task along",
		},
		{
			"story",
			Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"},
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

func TestBuildKickoffMessage_TaskReportsViaComment(t *testing.T) {
	w := Work{
		ID:          "task-1",
		StoryID:     "story-1",
		AgentRoleID: testRoleID,
		Title:       "Fix bug",
	}

	msg := BuildKickoffMessage(w)

	// The story's ID is spelled out in both calls: a template variable that no
	// longer matches the name Go passes renders as "<no value>", not as an error.
	assertContains(t, msg, "work_comment_list with work_id story-1", "where to read the story's instructions")
	assertContains(t, msg, "work_comment_add with work_id story-1", "where to report")
	assertContains(t, msg, "`step_done` with ID task-1", "step_done instruction")
}

func TestBuildRestartMessage_ContainsBaseAndNudge(t *testing.T) {
	for _, tc := range []struct {
		name  string
		w     Work
		nudge string
	}{
		{
			"task",
			Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"},
			"Your task was stopped and is now being restarted",
		},
		{
			"story",
			Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"},
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
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}

	msgWithoutSteps := BuildKickoffMessage(w)
	msgWithEmptySteps := BuildKickoffMessageWithSteps(w, []string{}, 0)

	if msgWithoutSteps != msgWithEmptySteps {
		t.Error("empty steps should produce same message as no steps")
	}
}

func TestBuildKickoffMessageWithSteps_WithSteps(t *testing.T) {
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}
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
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}

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
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}

	msgWithoutSteps := BuildAutoContinuationMessage(w)
	msgWithEmptySteps := BuildAutoContinuationMessageWithSteps(w, []string{}, 0)

	if msgWithoutSteps != msgWithEmptySteps {
		t.Error("empty steps should produce same message as no steps")
	}
}

func TestBuildAutoContinuationMessageWithSteps_WithSteps(t *testing.T) {
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T", CurrentStep: 1}
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
	w := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}
	steps := []string{"Step 1", "Step 2"}

	msg := BuildAutoContinuationMessageWithSteps(w, steps, 0)

	assertContains(t, msg, "## Current Step", "step header")
	assertContains(t, msg, "Step 1 of 2", "step number")
	assertContains(t, msg, "ended on step 1 of 2", "step context")
	assertContains(t, msg, "Call story_wait with ID s1", "how a story waits for its tasks")
}

func TestBuildAutoContinuationMessageWithSteps_InvalidIndex(t *testing.T) {
	w := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}
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
			Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"},
			"This task has been reopened",
		},
		{
			"story",
			Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"},
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
// will go looking for a status the store cannot produce, and one told to call
// work_create is answered by a retired stub instead of doing the work. Checked
// over every send site rather than over prompts.yaml, because a stale word can
// just as easily be appended in Go.
func TestEverySystemMessage_SpeaksTheCurrentVocabulary(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}
	task := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}
	steps := []string{"Do A", "Do B"}

	messages := map[string]string{}
	for _, w := range []Work{story, task} {
		prefix := string(w.Type())
		messages[prefix+" kickoff"] = BuildKickoffMessageWithSteps(w, steps, 0)
		messages[prefix+" restart"] = BuildRestartMessage(w)
		messages[prefix+" auto_continue"] = BuildAutoContinuationMessage(w)
		messages[prefix+" auto_continue with steps"] = BuildAutoContinuationMessageWithSteps(w, steps, 0)
		messages[prefix+" step_advance"] = BuildStepAdvanceMessage(w, "Do B", 2, 2)
		messages[prefix+" reopen"] = BuildReopenMessage(w)
	}
	messages["child_question"] = BuildChildQuestionMessage(story, "Child", "c1", "sess-c1",
		session.PendingQuestion{RequestID: "req-1", Header: "Database", Question: "Which?"})
	messages["child_question_reminder"] = BuildChildQuestionReminderMessage(story, []childQuestion{
		{ChildID: "c1", ChildTitle: "Child", SessionID: "sess-c1", RequestID: "req-1", Header: "Database", Question: "Which?"},
	})
	messages["child_done"] = BuildChildCompletionMessage(story, "Child", "c1", true)
	messages["child_done, wait standing"] = BuildChildCompletionMessage(story, "Child", "c1", false)
	for _, exit := range []childExit{childDeleted, childStopped, childNotStarted} {
		messages["wait_stranded, "+string(exit)] = BuildStrandedWaitMessage(story, "Child", "c1", exit)
	}

	for name, msg := range messages {
		for _, retired := range []string{
			"in_progress", "needs_input state", "still in_progress",
			// The tools the story/task split retired, and the two-field way of
			// naming a task's story that it made unrepresentable.
			"work_create", "work_list", "work_start", "work_wait", "parent_id", `type="task"`,
			// What text/template renders for a map key the template names and
			// Go no longer passes — a renamed variable fails as this, silently.
			"<no value>",
		} {
			if strings.Contains(msg, retired) {
				t.Errorf("%s message still says %q", name, retired)
			}
		}
		// The rules are what makes a message survive an agent that has lost all
		// memory of this work, so every send site has to carry them.
		assertContains(t, msg, "How Pockode drives this work", name+" lifecycle section")
		// A task has no tasks to wait for, so no message to one may offer the
		// tool — the step nudge offered it to tasks while the lifecycle section
		// was already careful not to — nor speak of its subtasks at all, which
		// the lifecycle section's "ask and wait for your subtasks" did.
		if strings.HasPrefix(name, "task ") {
			for _, storyOnly := range []string{"story_wait", "subtask"} {
				if strings.Contains(msg, storyOnly) {
					t.Errorf("%s message says %q to a task", name, storyOnly)
				}
			}
		}
	}
}

// A parent's wait is cleared by the very message telling it a child closed, so
// a story with two running tasks has to ask again or be nudged for going quiet.
func TestBuildChildCompletionMessage_TellsTheParentItsWaitIsGone(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}

	msg := BuildChildCompletionMessage(story, "Write the parser", "c1", true)

	assertContains(t, msg, "Write the parser", "child title")
	assertContains(t, msg, "This message cleared your wait", "the cleared wait")
	assertContains(t, msg, "call story_wait with ID s1 again", "how to wait again")

	// A parent that never declared a wait has none to be cleared
	// (Engine.notifyParentOfChild), and must not be told to "wait again": it was
	// working, and story_wait is rejected outright once no subtask is running.
	standing := BuildChildCompletionMessage(story, "Write the parser", "c1", false)
	if strings.Contains(standing, "cleared your wait") {
		t.Error("a parent whose wait still stands is told it was cleared")
	}
	if strings.Contains(standing, "call story_wait with ID s1 again") {
		t.Error("a parent whose wait still stands is told to wait again")
	}
	if strings.HasSuffix(standing, "\n") {
		t.Error("the omitted paragraph left a trailing blank line")
	}
}

// A stopped story is told nothing while it is stopped — child closures included —
// so the restart message is the only thing that can send it to look.
func TestBuildRestartMessage_SendsAStoryToRereadItsTasks(t *testing.T) {
	msg := BuildRestartMessage(Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"})

	assertContains(t, msg, "While a story is stopped Pockode sends it nothing", "why re-reading is needed")
	assertContains(t, msg, "task_list (story_id = this story's ID)", "how to re-read the tasks")
	assertContains(t, msg, "work_comment_list", "how to read the reports")
}

// TestBuildChildQuestionMessage_HandsTheStoryTheWholeQuestion: the story cannot
// fetch it — the question is on the subtask's session, not on its work item —
// so everything needed to answer travels in the message.
func TestBuildChildQuestionMessage_HandsTheStoryTheWholeQuestion(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}
	q := session.PendingQuestion{
		RequestID: "req-7", Header: "Database", Question: "Which database?",
		Options:     []session.QuestionOption{{Label: "Postgres"}, {Label: "SQLite"}},
		MultiSelect: true,
	}

	msg := BuildChildQuestionMessage(story, "Write the parser", "c1", "sess-c1", q)

	assertContains(t, msg, "Write the parser", "child title")
	assertContains(t, msg, "Which database?", "the question itself")
	assertContains(t, msg, "req-7", "the request id")
	// The other half of the question's identity. Without it a story answering a
	// question a fork left in two sessions spends a refused call finding out.
	assertContains(t, msg, "sess-c1", "the session the question is waiting in")
	assertContains(t, msg, "Postgres | SQLite", "the options it may pick from")
	assertContains(t, msg, "more than one may be picked", "that it is multi-select")
	assertContains(t, msg, "question_answer", "the way to answer it")
	assertContains(t, msg, "question_post", "the way to ask the user instead")
	// The one thing an agent cannot work out from the tools: this message did
	// not end its wait.
	assertContains(t, msg, "if you were waiting for your subtasks you still are", "that the wait stands")

	// A question with no options must not print an empty "Options:" line, and
	// must not point at `answers`: there is no list for a label to come from,
	// and the server refuses one.
	plain := BuildChildQuestionMessage(story, "Write the parser", "c1", "sess-c1",
		session.PendingQuestion{RequestID: "req-8", Header: "Name", Question: "What name?"})
	if strings.Contains(plain, "Options:") {
		t.Error("a question that offered nothing still printed an options line")
	}
	if strings.Contains(plain, "`answers`") {
		t.Error("a question that offered nothing still offered the labels field")
	}
	assertContains(t, plain, "offered nothing to pick", "where the answer goes instead")
}

// The subtask-question rules are a story's: only a story has subtasks that
// could ask.
func TestLifecycleRules_TellOnlyAStoryAboutItsSubtasksQuestions(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}
	task := Work{ID: "t1", StoryID: "s1", AgentRoleID: testRoleID, Title: "T"}

	assertContains(t, lifecycleRules(story), "question_answer", "a story is told it may answer for its subtasks")
	if strings.Contains(lifecycleRules(task), "question_answer") {
		t.Error("a task is offered a tool it has no subtask to point at")
	}
}

// Leaving a subtask's question alone used to be offered as a third way, and is
// not one: the story is the coordinator, Pockode nudges it for an unanswered
// one, and a story that keeps ignoring it is stopped.
func TestBuildChildQuestionMessage_DoesNotOfferToLeaveIt(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}

	msg := BuildChildQuestionMessage(story, "Write the parser", "c1", "sess-c1",
		session.PendingQuestion{RequestID: "req-7", Header: "Database", Question: "Which database?"})

	if strings.Contains(msg, "or leave it") {
		t.Error("the story is still told it may leave its subtask's question")
	}
	assertContains(t, msg, "do not leave it", "that ignoring it is not offered")
	// The rule itself is stated once, in the lifecycle section every message
	// carries. This is the message's own job: say that this question is not
	// optional, and point at the section that says what it costs.
	assertContains(t, lifecycleRules(story), "Ignoring it is not a third way", "the one place the rule lives")
	// Asking the user is the way out of a decision it cannot make, and it has to
	// read as ordinary — otherwise the only thing left is guessing.
	assertContains(t, lifecycleRules(story), "ordinary thing to do", "that asking the user is not a failure")
}

// The engine stops holding a story responsible for a subtask a person stopped
// (Engine.childrenAwaitingAnswers reads only active children), and these rules
// are the only place a story could learn that answering one anyway would set
// that subtask running again. Both halves have to say the same thing, so the
// bound is pinned here beside the engine's test for it.
func TestLifecycleRules_BoundASubtasksQuestionToARunningSubtask(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}

	rules := lifecycleRules(story)

	assertContains(t, rules, "is not yours", "that a stopped subtask's question is not the story's")
	assertContains(t, rules, "start it again with `task_start`", "the way to make it the story's again")
}

// TestBuildChildQuestionReminderMessage_QuotesEveryQuestion: the story cannot
// fetch them — they live on its subtasks' sessions — and it is being asked to
// settle each, so each arrives whole and with both halves of its identity.
func TestBuildChildQuestionReminderMessage_QuotesEveryQuestion(t *testing.T) {
	story := Work{ID: "s1", AgentRoleID: testRoleID, Title: "S"}

	msg := BuildChildQuestionReminderMessage(story, []childQuestion{
		{ChildID: "c1", ChildTitle: "Write the parser", SessionID: "sess-c1", RequestID: "req-1", Header: "Database", Question: "Which database?"},
		{ChildID: "c2", ChildTitle: "Wire the store", SessionID: "sess-c2", RequestID: "req-2", Header: "Name", Question: "What name?"},
	})

	for _, want := range []string{
		"Write the parser", "c1", "sess-c1", "req-1", "Which database?",
		"Wire the store", "c2", "sess-c2", "req-2", "What name?",
	} {
		assertContains(t, msg, want, "a question the story has to settle")
	}
	assertContains(t, msg, "question_answer", "the way to answer it")
	assertContains(t, msg, "question_post", "the way to ask the user instead")
	// The same thing the first message says, and for the same reason: a nudge is
	// otherwise read as "your wait is over, get on with it".
	assertContains(t, msg, "if you were waiting you still are", "that the wait stands")
}
