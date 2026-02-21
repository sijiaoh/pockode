package work

import (
	"strings"
	"testing"
)

const testRolePrompt = "You are a senior Go engineer."

func TestBuildKickoffMessage_Task(t *testing.T) {
	w := Work{
		ID:       "task-1",
		Type:     WorkTypeTask,
		ParentID: "story-1",
		Title:    "Fix the bug",
	}

	msg := BuildKickoffMessage(w, "Epic story", testRolePrompt)

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
	if !strings.Contains(msg, testRolePrompt) {
		t.Errorf("expected role prompt in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_TaskWithBody(t *testing.T) {
	w := Work{
		ID:       "task-1",
		Type:     WorkTypeTask,
		ParentID: "story-1",
		Title:    "Fix the bug",
		Body:     "Check the auth module for null pointer errors",
	}

	msg := BuildKickoffMessage(w, "Epic story", testRolePrompt)

	if !strings.Contains(msg, "Check the auth module") {
		t.Errorf("expected body in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:    "story-1",
		Type:  WorkTypeStory,
		Title: "Big feature",
	}

	msg := BuildKickoffMessage(w, "", testRolePrompt)

	if !strings.Contains(msg, "Big feature") {
		t.Errorf("expected story title in message, got %q", msg)
	}
	if !strings.Contains(msg, "coordinate tasks") {
		t.Errorf("expected coordination instruction in message, got %q", msg)
	}
	if !strings.Contains(msg, "story-1") {
		t.Errorf("expected work ID in message, got %q", msg)
	}
	if !strings.Contains(msg, testRolePrompt) {
		t.Errorf("expected role prompt in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_StoryWithBody(t *testing.T) {
	w := Work{
		ID:    "story-1",
		Type:  WorkTypeStory,
		Title: "Big feature",
		Body:  "Implement OAuth2 login with Google and GitHub providers",
	}

	msg := BuildKickoffMessage(w, "", testRolePrompt)

	if !strings.Contains(msg, "Implement OAuth2") {
		t.Errorf("expected body in message, got %q", msg)
	}
}

func TestBuildKickoffMessage_EmptyBodyOmitted(t *testing.T) {
	withBody := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, ParentID: "s1", Title: "T", Body: "details",
	}, "S", testRolePrompt)
	without := BuildKickoffMessage(Work{
		ID: "t1", Type: WorkTypeTask, ParentID: "s1", Title: "T",
	}, "S", testRolePrompt)

	if !strings.Contains(withBody, "details") {
		t.Fatal("body should appear when set")
	}
	if strings.Contains(without, "\n\n\n\n") {
		t.Error("empty body should not produce extra blank lines")
	}
}

func TestBuildKickoffMessage_RolePromptComesFirst(t *testing.T) {
	w := Work{
		ID:       "task-1",
		Type:     WorkTypeTask,
		ParentID: "story-1",
		Title:    "Fix the bug",
	}

	msg := BuildKickoffMessage(w, "Epic story", testRolePrompt)

	roleIdx := strings.Index(msg, testRolePrompt)
	workIdx := strings.Index(msg, "You are working on task")
	if roleIdx < 0 || workIdx < 0 || roleIdx >= workIdx {
		t.Error("role prompt should appear before work instruction")
	}
}

func TestBuildAutoContinuationMessage(t *testing.T) {
	storyMsg := BuildAutoContinuationMessage(WorkTypeStory)
	if !strings.Contains(storyMsg, "story") {
		t.Errorf("expected 'story' in message, got %q", storyMsg)
	}

	taskMsg := BuildAutoContinuationMessage(WorkTypeTask)
	if !strings.Contains(taskMsg, "task") {
		t.Errorf("expected 'task' in message, got %q", taskMsg)
	}
}

func TestBuildParentReactivationMessage(t *testing.T) {
	msg := BuildParentReactivationMessage("Implement login")
	if !strings.Contains(msg, "Implement login") {
		t.Errorf("expected child title in message, got %q", msg)
	}
	if !strings.Contains(msg, "work_done") {
		t.Errorf("expected work_done instruction in message, got %q", msg)
	}
}
