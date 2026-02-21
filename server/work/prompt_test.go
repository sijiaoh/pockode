package work

import (
	"strings"
	"testing"
)

func TestBuildKickoffMessage_Task(t *testing.T) {
	w := Work{
		ID:       "task-1",
		Type:     WorkTypeTask,
		ParentID: "story-1",
		Title:    "Fix the bug",
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
}

func TestBuildKickoffMessage_Story(t *testing.T) {
	w := Work{
		ID:    "story-1",
		Type:  WorkTypeStory,
		Title: "Big feature",
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
