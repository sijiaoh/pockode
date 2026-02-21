package ws

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/pockode/server/rpc"
	"github.com/pockode/server/work"
)

// --- work.create ---

func TestHandler_WorkCreate_Story(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Build login page",
	})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result work.Work
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty ID")
	}
	if result.Type != work.WorkTypeStory {
		t.Errorf("expected type story, got %s", result.Type)
	}
	if result.Title != "Build login page" {
		t.Errorf("expected title 'Build login page', got %q", result.Title)
	}
	if result.Status != work.StatusOpen {
		t.Errorf("expected status open, got %s", result.Status)
	}
	if result.AgentRoleID != env.testRoleID {
		t.Errorf("expected agent_role_id %q, got %q", env.testRoleID, result.AgentRoleID)
	}
}

func TestHandler_WorkCreate_TaskWithParent(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create parent story
	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Parent story",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	// Create task under story (inherits agent_role_id)
	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:     work.WorkTypeTask,
		ParentID: story.ID,
		Title:    "Implement auth",
	})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result work.Work
	json.Unmarshal(resp.Result, &result)

	if result.ParentID != story.ID {
		t.Errorf("expected parent_id %s, got %s", story.ID, result.ParentID)
	}
	if result.Type != work.WorkTypeTask {
		t.Errorf("expected type task, got %s", result.Type)
	}
	if result.AgentRoleID != env.testRoleID {
		t.Errorf("expected inherited agent_role_id %q, got %q", env.testRoleID, result.AgentRoleID)
	}
}

func TestHandler_WorkCreate_InvalidType(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:        "invalid",
		AgentRoleID: env.testRoleID,
		Title:       "Bad type",
	})

	if resp.Error == nil {
		t.Fatal("expected error for invalid type")
	}
}

func TestHandler_WorkCreate_EmptyTitle(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "",
	})

	if resp.Error == nil {
		t.Fatal("expected error for empty title")
	}
}

func TestHandler_WorkCreate_TaskWithoutParent(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeTask,
		AgentRoleID: env.testRoleID,
		Title:       "Orphan task",
	})

	if resp.Error == nil {
		t.Fatal("expected error for task without parent")
	}
}

func TestHandler_WorkCreate_InvalidAgentRoleID(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: "nonexistent-role-id",
		Title:       "Story with bad role",
	})

	if resp.Error == nil {
		t.Fatal("expected error for nonexistent agent role")
	}
	if !strings.Contains(resp.Error.Message, "agent role not found") {
		t.Errorf("expected 'agent role not found' error, got %q", resp.Error.Message)
	}
}

// --- work.update ---

func TestHandler_WorkUpdate_Title(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create a story
	createResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Original title",
	})
	var created work.Work
	json.Unmarshal(createResp.Result, &created)

	// Update title
	newTitle := "Updated title"
	resp := env.call("work.update", rpc.WorkUpdateParams{
		ID:    created.ID,
		Title: &newTitle,
	})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
}

func TestHandler_WorkUpdate_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	newTitle := "title"
	resp := env.call("work.update", rpc.WorkUpdateParams{
		ID:    "non-existent-id",
		Title: &newTitle,
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "work not found") {
		t.Errorf("expected 'work not found' error, got %+v", resp)
	}
}

func TestHandler_WorkUpdate_InvalidTransition(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create a story (status=open)
	createResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Story",
	})
	var created work.Work
	json.Unmarshal(createResp.Result, &created)

	// Try to transition open → done (invalid, must go through in_progress)
	doneStatus := work.StatusDone
	resp := env.call("work.update", rpc.WorkUpdateParams{
		ID:     created.ID,
		Status: &doneStatus,
	})

	if resp.Error == nil {
		t.Fatal("expected error for invalid status transition")
	}
}

// --- work.delete ---

func TestHandler_WorkDelete(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create a story
	createResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "To be deleted",
	})
	var created work.Work
	json.Unmarshal(createResp.Result, &created)

	// Delete it
	resp := env.call("work.delete", rpc.WorkDeleteParams{ID: created.ID})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
}

func TestHandler_WorkDelete_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.delete", rpc.WorkDeleteParams{ID: "non-existent-id"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "work not found") {
		t.Errorf("expected 'work not found' error, got %+v", resp)
	}
}

func TestHandler_WorkDelete_WithChildren(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create story with a child task
	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Parent",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	env.call("work.create", rpc.WorkCreateParams{
		Type:     work.WorkTypeTask,
		ParentID: story.ID,
		Title:    "Child task",
	})

	// Try to delete parent — should fail
	resp := env.call("work.delete", rpc.WorkDeleteParams{ID: story.ID})

	if resp.Error == nil {
		t.Fatal("expected error when deleting work with children")
	}
}

// --- work.start ---

func TestHandler_WorkStart(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)

	// Create a story, then a task under it
	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Feature X",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	taskResp := env.call("work.create", rpc.WorkCreateParams{
		Type:     work.WorkTypeTask,
		ParentID: story.ID,
		Title:    "Implement backend",
	})
	var task work.Work
	json.Unmarshal(taskResp.Result, &task)

	// Start the task
	resp := env.call("work.start", rpc.WorkStartParams{ID: task.ID})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result work.Work
	json.Unmarshal(resp.Result, &result)

	if result.Status != work.StatusInProgress {
		t.Errorf("expected status in_progress, got %s", result.Status)
	}
	if result.SessionID == "" {
		t.Error("expected non-empty session_id after start")
	}

	// Verify kickoff message includes role prompt
	mock.mu.Lock()
	msgs := mock.messages
	mock.mu.Unlock()
	if len(msgs) == 0 {
		t.Fatal("expected at least one message sent to agent")
	}
	kickoff := msgs[0]
	if !strings.Contains(kickoff, "You are a test engineer.") {
		t.Errorf("expected role prompt in kickoff message, got %q", kickoff)
	}
}

func TestHandler_WorkStart_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.start", rpc.WorkStartParams{ID: "non-existent-id"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "work not found") {
		t.Errorf("expected 'work not found' error, got %+v", resp)
	}
}

func TestHandler_WorkStart_AlreadyInProgress(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create and start a story
	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Story",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	// First start should succeed
	resp := env.call("work.start", rpc.WorkStartParams{ID: story.ID})
	if resp.Error != nil {
		t.Fatalf("first start failed: %s", resp.Error.Message)
	}

	// Second start should fail (already in_progress)
	resp = env.call("work.start", rpc.WorkStartParams{ID: story.ID})
	if resp.Error == nil {
		t.Fatal("expected error for starting already in_progress work")
	}
}

func TestHandler_WorkStart_RollbackOnKickoffFailure(t *testing.T) {
	mock := &mockAgent{startErr: fmt.Errorf("agent unavailable")}
	env := newTestEnv(t, mock)

	// Create a task under a story
	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Feature X",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	taskResp := env.call("work.create", rpc.WorkCreateParams{
		Type:     work.WorkTypeTask,
		ParentID: story.ID,
		Title:    "Implement backend",
	})
	var task work.Work
	json.Unmarshal(taskResp.Result, &task)

	// Start should fail (agent start error propagates through ChatClient.SendMessage)
	resp := env.call("work.start", rpc.WorkStartParams{ID: task.ID})
	if resp.Error == nil {
		t.Fatal("expected error when agent start fails")
	}
	if !strings.Contains(resp.Error.Message, "send kickoff message") {
		t.Errorf("expected kickoff failure message, got %q", resp.Error.Message)
	}

	// Verify rollback: work should be back to open with no session
	w, found, err := env.workStore.Get(task.ID)
	if err != nil || !found {
		t.Fatalf("failed to get work after rollback: err=%v, found=%v", err, found)
	}
	if w.Status != work.StatusOpen {
		t.Errorf("expected status open after rollback, got %s", w.Status)
	}
	if w.SessionID != "" {
		t.Errorf("expected empty session_id after rollback, got %q", w.SessionID)
	}
}

func TestHandler_WorkStart_RollbackAllowsRetry(t *testing.T) {
	mock := &mockAgent{startErr: fmt.Errorf("temporary error")}
	env := newTestEnv(t, mock)

	storyResp := env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Retry story",
	})
	var story work.Work
	json.Unmarshal(storyResp.Result, &story)

	// First attempt fails
	resp := env.call("work.start", rpc.WorkStartParams{ID: story.ID})
	if resp.Error == nil {
		t.Fatal("expected error")
	}

	// Fix the agent and retry
	mock.startErr = nil
	resp = env.call("work.start", rpc.WorkStartParams{ID: story.ID})
	if resp.Error != nil {
		t.Fatalf("retry should succeed after rollback, got: %s", resp.Error.Message)
	}

	var result work.Work
	json.Unmarshal(resp.Result, &result)
	if result.Status != work.StatusInProgress {
		t.Errorf("expected status in_progress after retry, got %s", result.Status)
	}
}

// --- work.list.subscribe ---

func TestHandler_WorkListSubscribe_Empty(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("work.list.subscribe", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.WorkListSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty subscription ID")
	}
	if len(result.Items) != 0 {
		t.Errorf("expected 0 items, got %d", len(result.Items))
	}
}

func TestHandler_WorkListSubscribe_WithItems(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Create some work items
	env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Story A",
	})
	env.call("work.create", rpc.WorkCreateParams{
		Type:        work.WorkTypeStory,
		AgentRoleID: env.testRoleID,
		Title:       "Story B",
	})

	resp := env.call("work.list.subscribe", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.WorkListSubscribeResult
	json.Unmarshal(resp.Result, &result)

	if len(result.Items) != 2 {
		t.Errorf("expected 2 items, got %d", len(result.Items))
	}
}
