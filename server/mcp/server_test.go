package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/work"
)

type testServer struct {
	*Server
	roleID string
}

func newTestServer(t *testing.T) testServer {
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

	role, err := arStore.Create(context.Background(), agentrole.AgentRole{
		Name:       "Test Engineer",
		RolePrompt: "You are a test engineer.",
	})
	if err != nil {
		t.Fatal(err)
	}

	return testServer{
		Server: NewServer(store, arStore),
		roleID: role.ID,
	}
}

// callMethod sends a JSON-RPC request and returns the parsed response.
func callMethod(t *testing.T, s *Server, method string, params interface{}) jsonRPCResponse {
	t.Helper()
	var rawParams json.RawMessage
	if params != nil {
		b, err := json.Marshal(params)
		if err != nil {
			t.Fatal(err)
		}
		rawParams = b
	}

	req := &jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      json.RawMessage(`1`),
		Method:  method,
		Params:  rawParams,
	}

	var buf bytes.Buffer
	s.handleRequest(context.Background(), &buf, req)

	var resp jsonRPCResponse
	if err := json.Unmarshal(buf.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal response: %v\nraw: %s", err, buf.String())
	}
	return resp
}

// callTool sends a tools/call request and returns the parsed tool result.
func callTool(t *testing.T, s *Server, name string, args interface{}) toolCallResult {
	t.Helper()
	rawArgs, _ := json.Marshal(args)
	resp := callMethod(t, s, "tools/call", toolCallParams{
		Name:      name,
		Arguments: rawArgs,
	})
	if resp.Error != nil {
		t.Fatalf("unexpected RPC error: %+v", resp.Error)
	}
	b, _ := json.Marshal(resp.Result)
	var result toolCallResult
	if err := json.Unmarshal(b, &result); err != nil {
		t.Fatalf("unmarshal tool result: %v", err)
	}
	return result
}

func toolText(r toolCallResult) string {
	if len(r.Content) == 0 {
		return ""
	}
	return r.Content[0].Text
}

// --- Protocol tests ---

func TestInitialize(t *testing.T) {
	ts := newTestServer(t)
	resp := callMethod(t, ts.Server, "initialize", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %+v", resp.Error)
	}

	b, _ := json.Marshal(resp.Result)
	var result initializeResult
	json.Unmarshal(b, &result)

	if result.ProtocolVersion != "2024-11-05" {
		t.Errorf("protocol = %q, want 2024-11-05", result.ProtocolVersion)
	}
	if result.ServerInfo.Name != "pockode" {
		t.Errorf("name = %q, want pockode", result.ServerInfo.Name)
	}
}

func TestToolsList(t *testing.T) {
	ts := newTestServer(t)
	resp := callMethod(t, ts.Server, "tools/list", nil)

	b, _ := json.Marshal(resp.Result)
	var result toolsListResult
	json.Unmarshal(b, &result)

	names := make(map[string]bool)
	for _, td := range result.Tools {
		names[td.Name] = true
	}

	for _, want := range []string{"work_list", "work_create", "work_update", "work_get", "work_delete", "work_done", "work_start", "work_needs_input", "work_comment_add", "work_comment_list", "agent_role_list", "agent_role_get", "agent_role_reset_defaults"} {
		if !names[want] {
			t.Errorf("missing tool %q", want)
		}
	}
}

func TestUnknownMethod(t *testing.T) {
	ts := newTestServer(t)
	resp := callMethod(t, ts.Server, "nonexistent", nil)

	if resp.Error == nil {
		t.Fatal("expected error for unknown method")
	}
	if resp.Error.Code != -32601 {
		t.Errorf("code = %d, want -32601", resp.Error.Code)
	}
}

func TestUnknownTool(t *testing.T) {
	ts := newTestServer(t)
	rawArgs, _ := json.Marshal(map[string]string{})
	resp := callMethod(t, ts.Server, "tools/call", toolCallParams{
		Name:      "nonexistent_tool",
		Arguments: rawArgs,
	})

	if resp.Error == nil {
		t.Fatal("expected RPC error for unknown tool")
	}
	if resp.Error.Code != -32602 {
		t.Errorf("code = %d, want -32602", resp.Error.Code)
	}
}

// --- Tool: work_create ---

func TestWorkCreate(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_create", map[string]string{
		"type":          "story",
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

func TestWorkCreate_InvalidType(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_create", map[string]string{
		"type":          "epic",
		"title":         "X",
		"agent_role_id": ts.roleID,
	})

	if !result.IsError {
		t.Error("expected error for invalid type")
	}
}

// --- Tool: work_list ---

func TestWorkList_Empty(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_list", map[string]string{})

	text := toolText(result)
	if text != "[]" {
		t.Errorf("expected empty JSON array, got %q", text)
	}
}

func TestWorkList_WithItems(t *testing.T) {
	ts := newTestServer(t)

	callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story A", "agent_role_id": ts.roleID,
	})
	callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story B", "agent_role_id": ts.roleID,
	})

	result := callTool(t, ts.Server, "work_list", map[string]string{})
	text := toolText(result)

	if !strings.Contains(text, "Story A") || !strings.Contains(text, "Story B") {
		t.Errorf("expected both stories in list, got %q", text)
	}
}

func TestWorkList_FilterByParentID(t *testing.T) {
	ts := newTestServer(t)

	// Create story, extract ID
	storyResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Parent Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(storyResult))

	// Create task under story with explicit agent_role_id
	callTool(t, ts.Server, "work_create", map[string]string{
		"type": "task", "parent_id": storyID, "title": "Child Task", "agent_role_id": ts.roleID,
	})

	// Create another top-level story
	callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Other Story", "agent_role_id": ts.roleID,
	})

	// Filter by parent
	result := callTool(t, ts.Server, "work_list", map[string]string{"parent_id": storyID})
	text := toolText(result)

	if !strings.Contains(text, "Child Task") {
		t.Errorf("expected child task, got %q", text)
	}
	if strings.Contains(text, "Parent Story") || strings.Contains(text, "Other Story") {
		t.Errorf("should not contain non-child items, got %q", text)
	}
}

// --- Tool: work_update ---

func TestWorkUpdate(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Old Title", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_update", map[string]string{
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
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_update", map[string]string{
		"id": "nonexistent", "title": "X",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_get ---

func TestWorkGet(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "My Story", "body": "Details here", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_get", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	text := toolText(result)
	if !strings.Contains(text, "My Story") {
		t.Errorf("result = %q, want to contain title", text)
	}
	if !strings.Contains(text, "Details here") {
		t.Errorf("result = %q, want to contain body", text)
	}
}

func TestWorkGet_NotFound(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_get", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_delete ---

func TestWorkDelete(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Delete Me", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_delete", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "Deleted") {
		t.Errorf("result = %q, want to contain 'Deleted'", toolText(result))
	}

	// Verify it's gone
	getResult := callTool(t, ts.Server, "work_get", map[string]string{"id": id})
	if !getResult.IsError {
		t.Error("expected error when getting deleted work")
	}
}

func TestWorkDelete_NotFound(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_delete", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_done ---

func TestWorkDone(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "My Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	// Pre-transition to in_progress to test the in_progress → done path specifically
	// (the auto open → done path is tested in TestWorkDone_FromOpen_AutoTransitions)
	ts.store.Start(context.Background(), id, "")

	result := callTool(t, ts.Server, "work_done", map[string]string{"id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "done") {
		t.Errorf("result = %q, want to contain 'done'", toolText(result))
	}
}

func TestWorkDone_FromOpen_AutoTransitions(t *testing.T) {
	ts := newTestServer(t)

	// Create story (status=open) → work_done auto-transitions open → in_progress → done
	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_done", map[string]string{"id": id})
	if result.IsError {
		t.Errorf("expected success for open → done (auto-transition), got error: %s", toolText(result))
	}
}

func TestWorkDone_AlreadyClosed(t *testing.T) {
	ts := newTestServer(t)

	// Create and complete a story (will auto-close since no children)
	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	ts.store.Start(context.Background(), id, "")

	callTool(t, ts.Server, "work_done", map[string]string{"id": id})

	// Try to done again — already closed, should fail
	result := callTool(t, ts.Server, "work_done", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for closed → done (invalid transition)")
	}
}

// --- Tool: work_start ---

func TestWorkStart(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Start Me", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_start", map[string]string{"id": id})

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

	// Verify work is now in_progress
	w, found, err := ts.store.Get(id)
	if err != nil || !found {
		t.Fatal("work not found after start")
	}
	if w.Status != work.StatusInProgress {
		t.Errorf("status = %q, want in_progress", w.Status)
	}
	if w.SessionID == "" {
		t.Error("session_id should be set after start")
	}
}

func TestWorkStart_NotFound(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "work_start", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

func TestWorkStart_AlreadyInProgress(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	// Start once
	callTool(t, ts.Server, "work_start", map[string]string{"id": id})

	// Start again — should fail (already in_progress)
	result := callTool(t, ts.Server, "work_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for already in_progress work")
	}
}

// --- Tool: work_needs_input ---

func TestWorkNeedsInput(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	// Transition to in_progress first
	callTool(t, ts.Server, "work_start", map[string]string{"id": id})

	result := callTool(t, ts.Server, "work_needs_input", map[string]string{
		"id": id, "reason": "Need clarification on requirements",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	text := toolText(result)
	if !strings.Contains(text, "waiting for user input") {
		t.Errorf("result = %q, want to contain 'waiting for user input'", text)
	}
	if !strings.Contains(text, "Need clarification on requirements") {
		t.Errorf("result = %q, want to contain reason", text)
	}

	// Verify status changed
	w, found, err := ts.store.Get(id)
	if err != nil || !found {
		t.Fatal("work not found after needs_input")
	}
	if w.Status != work.StatusNeedsInput {
		t.Errorf("status = %q, want needs_input", w.Status)
	}
}

func TestWorkNeedsInput_NotInProgress(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	// Try needs_input from open status (invalid)
	result := callTool(t, ts.Server, "work_needs_input", map[string]string{
		"id": id, "reason": "some reason",
	})
	if !result.IsError {
		t.Error("expected error for needs_input from open status")
	}
}

func TestWorkStart_NoAgentRole(t *testing.T) {
	ts := newTestServer(t)

	// Create story, then clear its agent_role_id
	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))
	empty := ""
	ts.store.Update(context.Background(), id, work.UpdateFields{AgentRoleID: &empty})

	result := callTool(t, ts.Server, "work_start", map[string]string{"id": id})
	if !result.IsError {
		t.Error("expected error for work without agent_role_id")
	}
}

// --- Tool: agent_role_list ---

func TestAgentRoleList(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "agent_role_list", map[string]string{})

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
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "agent_role_get", map[string]string{"id": ts.roleID})

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

// --- Tool: agent_role_reset_defaults ---

func TestAgentRoleResetDefaults(t *testing.T) {
	ts := newTestServer(t)

	result := callTool(t, ts.Server, "agent_role_reset_defaults", map[string]string{})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "reset to defaults") {
		t.Errorf("result = %q, want to contain 'reset to defaults'", toolText(result))
	}
}

func TestAgentRoleGet_NotFound(t *testing.T) {
	ts := newTestServer(t)
	result := callTool(t, ts.Server, "agent_role_get", map[string]string{"id": "nonexistent"})

	if !result.IsError {
		t.Error("expected error for nonexistent ID")
	}
}

// --- Tool: work_comment_add ---

func TestWorkCommentAdd(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_comment_add", map[string]string{
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
	ts := newTestServer(t)

	result := callTool(t, ts.Server, "work_comment_add", map[string]string{
		"work_id": "nonexistent", "body": "hello",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent work ID")
	}
}

// --- Tool: work_comment_list ---

func TestWorkCommentList_Empty(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	result := callTool(t, ts.Server, "work_comment_list", map[string]string{"work_id": id})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if toolText(result) != "[]" {
		t.Errorf("expected empty JSON array, got %q", toolText(result))
	}
}

func TestWorkCommentList_WithComments(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	id := extractID(t, toolText(createResult))

	callTool(t, ts.Server, "work_comment_add", map[string]string{
		"work_id": id, "body": "first comment",
	})
	callTool(t, ts.Server, "work_comment_add", map[string]string{
		"work_id": id, "body": "second comment",
	})

	result := callTool(t, ts.Server, "work_comment_list", map[string]string{"work_id": id})

	text := toolText(result)
	if !strings.Contains(text, "first comment") || !strings.Contains(text, "second comment") {
		t.Errorf("expected both comments in list, got %q", text)
	}
}

// --- Tool: work_comment_update ---

func TestWorkCommentUpdate(t *testing.T) {
	ts := newTestServer(t)

	createResult := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Story", "agent_role_id": ts.roleID,
	})
	workID := extractID(t, toolText(createResult))

	addResult := callTool(t, ts.Server, "work_comment_add", map[string]string{
		"work_id": workID, "body": "original",
	})
	commentID := extractCommentID(t, toolText(addResult))

	result := callTool(t, ts.Server, "work_comment_update", map[string]string{
		"id": commentID, "body": "edited",
	})

	if result.IsError {
		t.Fatalf("unexpected error: %s", toolText(result))
	}
	if !strings.Contains(toolText(result), "edited") {
		t.Errorf("result = %q, want to contain 'edited'", toolText(result))
	}

	listResult := callTool(t, ts.Server, "work_comment_list", map[string]string{"work_id": workID})
	if !strings.Contains(toolText(listResult), "edited") {
		t.Errorf("list should show edited comment, got %q", toolText(listResult))
	}
}

func TestWorkCommentUpdate_NotFound(t *testing.T) {
	ts := newTestServer(t)

	result := callTool(t, ts.Server, "work_comment_update", map[string]string{
		"id": "nonexistent", "body": "text",
	})

	if !result.IsError {
		t.Error("expected error for nonexistent comment ID")
	}
}

// extractCommentID parses "Comment added (ID: xxx)" to get xxx
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

// --- step_done tests ---

func TestStepDone_AdvancesStep(t *testing.T) {
	dataDir := t.TempDir()
	store, err := work.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	arStore, err := agentrole.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}

	// Create a role with steps
	role, err := arStore.Create(context.Background(), agentrole.AgentRole{
		Name:       "Multi-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Implement", "Step 3: Test"},
	})
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(store, arStore)

	// Create a story first (tasks require a parent)
	result := callTool(t, s, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": role.ID,
	})
	storyID := extractID(t, toolText(result))

	// Create and start a task under the story
	result = callTool(t, s, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": role.ID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, s, "work_start", map[string]string{"id": id})

	// Now call step_done
	result = callTool(t, s, "step_done", map[string]string{"id": id})
	text := toolText(result)

	if !strings.Contains(text, "Step 1 completed") {
		t.Errorf("expected step 1 completed message, got %q", text)
	}
	if !strings.Contains(text, "advancing to step 2") {
		t.Errorf("expected advancing to step 2 message, got %q", text)
	}

	// Verify the step was advanced
	w, _, _ := store.Get(id)
	if w.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1", w.CurrentStep)
	}
	if w.Status != work.StatusInProgress {
		t.Errorf("Status = %s, want in_progress", w.Status)
	}
}

func TestStepDone_LastStep(t *testing.T) {
	dataDir := t.TempDir()
	store, err := work.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	arStore, err := agentrole.NewFileStore(dataDir)
	if err != nil {
		t.Fatal(err)
	}

	// Create a role with 2 steps
	role, err := arStore.Create(context.Background(), agentrole.AgentRole{
		Name:       "Two-Step Engineer",
		RolePrompt: "You are an engineer.",
		Steps:      []string{"Step 1: Plan", "Step 2: Execute"},
	})
	if err != nil {
		t.Fatal(err)
	}

	s := NewServer(store, arStore)

	// Create a story first
	result := callTool(t, s, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": role.ID,
	})
	storyID := extractID(t, toolText(result))

	// Create and start a task
	result = callTool(t, s, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": role.ID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, s, "work_start", map[string]string{"id": id})

	// Advance to step 2 (index 1)
	callTool(t, s, "step_done", map[string]string{"id": id})

	// Now at last step, step_done should indicate to use work_done
	result = callTool(t, s, "step_done", map[string]string{"id": id})
	text := toolText(result)

	if !strings.Contains(text, "final step") {
		t.Errorf("expected final step message, got %q", text)
	}
	if !strings.Contains(text, "work_done") {
		t.Errorf("expected work_done suggestion, got %q", text)
	}

	// Step should not have advanced beyond the last step
	w, _, _ := store.Get(id)
	if w.CurrentStep != 1 {
		t.Errorf("CurrentStep = %d, want 1 (should not advance past last step)", w.CurrentStep)
	}
}

func TestStepDone_NoSteps(t *testing.T) {
	ts := newTestServer(t)

	// Create a story first
	result := callTool(t, ts.Server, "work_create", map[string]string{
		"type": "story", "title": "Test Story", "agent_role_id": ts.roleID,
	})
	storyID := extractID(t, toolText(result))

	// Create and start a task (role has no steps)
	result = callTool(t, ts.Server, "work_create", map[string]string{
		"type": "task", "title": "Test Task", "agent_role_id": ts.roleID, "parent_id": storyID,
	})
	id := extractID(t, toolText(result))

	callTool(t, ts.Server, "work_start", map[string]string{"id": id})

	// step_done should fail because the role has no steps
	resp := callMethod(t, ts.Server, "tools/call", toolCallParams{
		Name:      "step_done",
		Arguments: json.RawMessage(`{"id":"` + id + `"}`),
	})

	// Should return an error result
	if resp.Error == nil {
		b, _ := json.Marshal(resp.Result)
		var result toolCallResult
		json.Unmarshal(b, &result)
		if !result.IsError {
			t.Errorf("expected error for step_done on work with no steps")
		}
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
