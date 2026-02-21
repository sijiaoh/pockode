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
		ParentID:    "story-1",
		AgentRoleID: testAgentRoleID,
		Title:       "Fix the bug",
	}

	msg := BuildKickoffMessage(w, "Epic story")

	if !strings.Contains(msg, "Fix the bug") {
		t.Errorf("expected task title in message, got %q", msg)
	}
	if !strings.Contains(msg, "Epic story") {
		t.Errorf("expected parent title in message, got %q", msg)
	}
	if !strings.Contains(msg, "task-1") {
		t.Errorf("expected work ID in message, got %q", msg)
	}
	if !strings.Contains(msg, "work_done") {
		t.Errorf("expected work_done instruction in message, got %q", msg)
	}
	if !strings.Contains(msg, testAgentRoleID) {
		t.Errorf("expected agent role ID in message, got %q", msg)
	}
	if !strings.Contains(msg, "agent_role_get") {
		t.Errorf("expected agent_role_get instruction in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_TaskWithBody(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		ParentID:    "story-1",
		AgentRoleID: testAgentRoleID,
		Title:       "Fix the bug",
		Body:        "Check the auth module for null pointer errors",
	}

	msg := BuildKickoffMessage(w, "Epic story")

	if !strings.Contains(msg, "Check the auth module") {
		t.Errorf("expected body in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
	}

	msg := BuildKickoffMessage(w, "")

	if !strings.Contains(msg, "Big feature") {
		t.Errorf("expected story title in message, got %q", msg)
	}
	if !strings.Contains(msg, "coordinate tasks") {
		t.Errorf("expected coordination instruction in message, got %q", msg)
	}
	if !strings.Contains(msg, "story-1") {
		t.Errorf("expected work ID in message, got %q", msg)
	}
	if !strings.Contains(msg, testAgentRoleID) {
		t.Errorf("expected agent role ID in message, got %q", msg)
	}
	if !strings.Contains(msg, "agent_role_get") {
		t.Errorf("expected agent_role_get instruction in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_StoryWithBody(t *testing.T) {
	w := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
		Body:        "Implement OAuth2 login with Google and GitHub providers",
	}

	msg := BuildKickoffMessage(w, "")

	if !strings.Contains(msg, "Implement OAuth2") {
		t.Errorf("expected body in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_EmptyBodyOmitted(t *testing.T) {
	withBody := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, ParentID: "s1", AgentRoleID: testAgentRoleID, Title: "T", Body: "details",
	}, "S")
	without := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, ParentID: "s1", AgentRoleID: testAgentRoleID, Title: "T",
	}, "S")

	if !strings.Contains(withBody, "details") {
		t.Fatal("body should appear when set")
	}
	if strings.Contains(without, "\n\n\n\n") {
		t.Error("empty body should not produce extra blank lines")
	}
}

func TestBuildKickoffMessage_RoleRefComesFirst(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		ParentID:    "story-1",
		AgentRoleID: testAgentRoleID,
		Title:       "Fix the bug",
	}

	msg := BuildKickoffMessage(w, "Epic story")

	roleIdx := strings.Index(msg, testAgentRoleID)
	workIdx := strings.Index(msg, "You are working on task")
	if roleIdx < 0 || workIdx < 0 || roleIdx >= workIdx {
		t.Error("role reference should appear before work instruction")
	}
}

func TestBuildAutoContinuationMessage_Story(t *testing.T) {
	w := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
	}

	msg := BuildAutoContinuationMessage(w, "")

	assertContains(t, msg, testAgentRoleID, "agent role ID")
	assertContains(t, msg, "agent_role_get", "agent_role_get instruction")
	assertContains(t, msg, "Big feature", "story title")
	assertContains(t, msg, "story-1", "work ID")
	assertContains(t, msg, "story", "'story'")
	assertContains(t, msg, storyBehaviorRules, "storyBehaviorRules")
}

func TestBuildAutoContinuationMessage_Task(t *testing.T) {
	w := Work{
		ID:          "task-1",
		Type:        WorkTypeTask,
		ParentID:    "story-1",
		AgentRoleID: testAgentRoleID,
		Title:       "Fix the bug",
		Body:        "Check null pointers",
	}

	msg := BuildAutoContinuationMessage(w, "Epic story")

	assertContains(t, msg, testAgentRoleID, "agent role ID")
	assertContains(t, msg, "agent_role_get", "agent_role_get instruction")
	assertContains(t, msg, "Fix the bug", "task title")
	assertContains(t, msg, "task-1", "work ID")
	assertContains(t, msg, "Epic story", "parent title")
	assertContains(t, msg, "Check null pointers", "body")
	assertContains(t, msg, "work_done", "work_done instruction")
}

func TestBuildParentReactivationMessage(t *testing.T) {
	parent := Work{
		ID:          "story-1",
		Type:        WorkTypeStory,
		AgentRoleID: testAgentRoleID,
		Title:       "Big feature",
	}

	msg := BuildParentReactivationMessage(parent, "Implement login")

	assertContains(t, msg, testAgentRoleID, "agent role ID")
	assertContains(t, msg, "agent_role_get", "agent_role_get instruction")
	assertContains(t, msg, "Big feature", "parent title")
	assertContains(t, msg, "story-1", "work ID")
	assertContains(t, msg, "Implement login", "child title")
	assertContains(t, msg, "work_done", "work_done instruction")
	assertContains(t, msg, storyBehaviorRules, "storyBehaviorRules")
}

func TestStoryBehaviorRulesConsistency(t *testing.T) {
	storyWork := Work{
		ID: "s1", Type: WorkTypeStory, AgentRoleID: "role-1", Title: "S",
	}
	kickoff := BuildKickoffMessage(storyWork, "")
	continuation := BuildAutoContinuationMessage(storyWork, "")
	reactivation := BuildParentReactivationMessage(storyWork, "child task")

	for _, tc := range []struct {
		name string
		msg  string
	}{
		{"kickoff", kickoff},
		{"continuation", continuation},
		{"reactivation", reactivation},
	} {
		if !strings.Contains(tc.msg, storyBehaviorRules) {
			t.Errorf("%s: expected storyBehaviorRules in message", tc.name)
		}
	}
}

func TestAllPromptsContainRoleReference(t *testing.T) {
	story := Work{
		ID: "s1", Type: WorkTypeStory, AgentRoleID: "role-1", Title: "S",
	}
	task := Work{
		ID: "t1", Type: WorkTypeTask, ParentID: "s1", AgentRoleID: "role-2", Title: "T",
	}

	for _, tc := range []struct {
		name   string
		msg    string
		roleID string
	}{
		{"kickoff-story", BuildKickoffMessage(story, ""), "role-1"},
		{"kickoff-task", BuildKickoffMessage(task, "S"), "role-2"},
		{"continuation-story", BuildAutoContinuationMessage(story, ""), "role-1"},
		{"continuation-task", BuildAutoContinuationMessage(task, "S"), "role-2"},
		{"reactivation", BuildParentReactivationMessage(story, "child"), "role-1"},
	} {
		assertContains(t, tc.msg, tc.roleID, tc.name+": agent role ID")
		assertContains(t, tc.msg, "agent_role_get", tc.name+": agent_role_get")
	}
}
