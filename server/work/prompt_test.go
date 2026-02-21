package work

import (
	"strings"
	"testing"
)

const testAgentRoleID = "role-abc-123"

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
		AgentRoleID: testAgentRoleID,
		Title:       "Fix the bug",
		Body:        "Check the auth module for null pointer errors",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, testAgentRoleID, "agent role ID")
	assertContains(t, msg, "agent_role_get", "agent_role_get instruction")
	assertContains(t, msg, "Fix the bug", "task title")
	assertContains(t, msg, "task-1", "work ID")
	assertContains(t, msg, "Check the auth module", "body")
	assertContains(t, msg, "work_done", "work_done instruction")

	if strings.Contains(msg, "coordinate") {
		t.Error("task message should not contain story coordination rules")
	}
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
		Body:        "Implement OAuth2 login with Google and GitHub providers",
	}

	msg := BuildKickoffMessage(w)

	assertContains(t, msg, "Big feature", "story title")
	assertContains(t, msg, "Implement OAuth2", "body")
	assertContains(t, msg, storyBehaviorRules, "story behavior rules")
}

func TestBuildKickoffMessage_EmptyBodyOmitted(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, AgentRoleID: testAgentRoleID, Title: "T",
	})

	if strings.Contains(msg, "\n\n\n\n") {
		t.Error("empty body should not produce extra blank lines")
	}
}

func TestBuildKickoffMessage_RoleRefComesFirst(t *testing.T) {
	msg := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, AgentRoleID: testAgentRoleID, Title: "T",
	})

	roleIdx := strings.Index(msg, testAgentRoleID)
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
			Work{ID: "t1", Type: WorkTypeTask, AgentRoleID: testAgentRoleID, Title: "T"},
			"Your task is still in_progress",
		},
		{
			"story",
			Work{ID: "s1", Type: WorkTypeStory, AgentRoleID: testAgentRoleID, Title: "S"},
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

func TestBuildParentReactivationMessage_ContainsBaseAndNudge(t *testing.T) {
	parent := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
	}

	base := BuildKickoffMessage(parent)
	msg := BuildParentReactivationMessage(parent, "Implement login", "task-42")

	if !strings.Contains(msg, base) {
		t.Error("parent reactivation should contain the full kickoff base")
	}
	assertContains(t, msg, "Implement login", "child title")
	assertContains(t, msg, "task-42", "child ID")
	assertContains(t, msg, "has been completed", "reactivation nudge")
}
