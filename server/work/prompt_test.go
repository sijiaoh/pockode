package work

import (
	"strings"
	"testing"
)

func assertContains(t *testing.T, msg, substr, label string) {
	t.Helper()
	if !strings.Contains(msg, substr) {
		t.Errorf("expected %s in message, got %q", label, msg)
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
	assertContains(t, msg, "work_done", "work_done instruction")

	if strings.Contains(msg, "coordinate") {
		t.Error("task message should not contain story coordination rules")
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
	assertContains(t, msg, storyBehaviorRules, "story behavior rules")
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
			"Your task is still in_progress",
		},
		{
			"story",
			Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"},
			"Your story is still in_progress",
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
	assertContains(t, msg, "work_done", "work_done instruction")
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
	assertContains(t, msg, "interrupted while working on step 2 of 3", "interrupt context")
	assertContains(t, msg, "If YES and this is NOT the last step: Call step_done", "step_done instruction")
	assertContains(t, msg, "If YES and this IS the last step: Call work_done", "work_done instruction")
	assertContains(t, msg, "If NO: Continue working", "no instruction")
}

func TestBuildAutoContinuationMessageWithSteps_Story(t *testing.T) {
	w := Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testRoleID, Title: "S"}
	steps := []string{"Step 1", "Step 2"}

	// Stories should fall back to standard message (steps don't apply)
	msgWithSteps := BuildAutoContinuationMessageWithSteps(w, steps, 0)
	msgWithoutSteps := BuildAutoContinuationMessage(w)

	if msgWithSteps != msgWithoutSteps {
		t.Error("story should fall back to standard message regardless of steps")
	}
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
