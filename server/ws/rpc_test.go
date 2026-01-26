package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/pockode/server/agent"
	"github.com/pockode/server/command"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

var bgCtx = context.Background()

type testEnv struct {
	t               *testing.T
	mock            *mockAgent
	worktreeManager *worktree.Manager
	server          *httptest.Server
	conn            *websocket.Conn
	ctx             context.Context
	cancel          context.CancelFunc
	reqID           int
}

func newTestEnv(t *testing.T, mock *mockAgent) *testEnv {
	return newTestEnvWithWorkDir(t, mock, t.TempDir())
}

func newTestEnvWithWorkDir(t *testing.T, mock *mockAgent, workDir string) *testEnv {
	dataDir := t.TempDir()
	cmdStore, err := command.NewStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create command store: %v", err)
	}
	settingsStore, err := settings.NewStore(dataDir)
	if err != nil {
		t.Fatalf("failed to create settings store: %v", err)
	}

	registry := worktree.NewRegistry(workDir)
	worktreeManager := worktree.NewManager(registry, mock, dataDir, 10*time.Minute)

	h := NewRPCHandler("test-token", "test", true, cmdStore, worktreeManager, settingsStore)
	server := httptest.NewServer(h)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		server.Close()
		t.Fatalf("failed to connect: %v", err)
	}

	env := &testEnv{
		t:               t,
		mock:            mock,
		worktreeManager: worktreeManager,
		server:          server,
		conn:            conn,
		ctx:             ctx,
		cancel:          cancel,
		reqID:           0,
	}

	// Authenticate
	resp := env.call("auth", rpc.AuthParams{Token: "test-token"})
	if resp.Error != nil {
		t.Fatalf("auth failed: %s", resp.Error.Message)
	}

	t.Cleanup(func() {
		conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		server.Close()
		worktreeManager.Shutdown()
	})

	return env
}

// getMainWorktree returns the main worktree for tests that need direct access to store/manager.
func (e *testEnv) getMainWorktree() *worktree.Worktree {
	wt, err := e.worktreeManager.Get("")
	if err != nil {
		e.t.Fatalf("failed to get main worktree: %v", err)
	}
	return wt
}

type rpcRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int         `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      int             `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonrpc2.Error `json:"error,omitempty"`
}

type rpcNotification struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

func (e *testEnv) nextID() int {
	e.reqID++
	return e.reqID
}

func (e *testEnv) call(method string, params interface{}) rpcResponse {
	req := rpcRequest{
		JSONRPC: "2.0",
		ID:      e.nextID(),
		Method:  method,
		Params:  params,
	}
	data, _ := json.Marshal(req)
	if err := e.conn.Write(e.ctx, websocket.MessageText, data); err != nil {
		e.t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		e.t.Fatalf("failed to unmarshal response: %v", err)
	}
	return resp
}

func (e *testEnv) readNotification() rpcNotification {
	_, data, err := e.conn.Read(e.ctx)
	if err != nil {
		e.t.Fatalf("failed to read: %v", err)
	}

	var notif rpcNotification
	if err := json.Unmarshal(data, &notif); err != nil {
		e.t.Fatalf("failed to unmarshal notification: %v", err)
	}
	return notif
}

func (e *testEnv) subscribeChatMessages(sessionID string) rpc.ChatMessagesSubscribeResult {
	resp := e.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{SessionID: sessionID})
	if resp.Error != nil {
		e.t.Fatalf("subscribe failed: %s", resp.Error.Message)
	}
	var result rpc.ChatMessagesSubscribeResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		e.t.Fatalf("failed to unmarshal result: %v", err)
	}
	return result
}

func (e *testEnv) sendMessage(sessionID, content string) {
	resp := e.call("chat.message", rpc.MessageParams{SessionID: sessionID, Content: content})
	if resp.Error != nil {
		e.t.Fatalf("message failed: %s", resp.Error.Message)
	}
}

func (e *testEnv) skipN(n int) {
	for i := 0; i < n; i++ {
		if _, _, err := e.conn.Read(e.ctx); err != nil {
			e.t.Fatalf("failed to skip response %d: %v", i, err)
		}
	}
}

func TestHandler_Auth_InvalidToken(t *testing.T) {
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	registry := worktree.NewRegistry(workDir)
	worktreeManager := worktree.NewManager(registry, &mockAgent{}, dataDir, 10*time.Minute)
	defer worktreeManager.Shutdown()

	h := NewRPCHandler("secret-token", "test", true, cmdStore, worktreeManager, settingsStore)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	req := rpcRequest{JSONRPC: "2.0", ID: 1, Method: "auth", Params: rpc.AuthParams{Token: "wrong-token"}}
	data, _ := json.Marshal(req)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Error == nil {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error.Message, "invalid token") {
		t.Errorf("expected 'invalid token' error, got %q", resp.Error.Message)
	}
}

func TestHandler_Auth_FirstMessageMustBeAuth(t *testing.T) {
	dataDir := t.TempDir()
	workDir := t.TempDir()
	cmdStore, _ := command.NewStore(dataDir)
	settingsStore, _ := settings.NewStore(dataDir)
	registry := worktree.NewRegistry(workDir)
	worktreeManager := worktree.NewManager(registry, &mockAgent{}, dataDir, 10*time.Minute)
	defer worktreeManager.Shutdown()

	h := NewRPCHandler("test-token", "test", true, cmdStore, worktreeManager, settingsStore)
	server := httptest.NewServer(h)
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	req := rpcRequest{JSONRPC: "2.0", ID: 1, Method: "chat.messages.subscribe", Params: rpc.ChatMessagesSubscribeParams{SessionID: "sess"}}
	data, _ := json.Marshal(req)
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		t.Fatalf("failed to send: %v", err)
	}

	_, respData, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var resp rpcResponse
	if err := json.Unmarshal(respData, &resp); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if resp.Error == nil {
		t.Error("expected auth to fail")
	}
	if !strings.Contains(resp.Error.Message, "first request must be auth") {
		t.Errorf("expected 'first request must be auth' error, got %q", resp.Error.Message)
	}
}

func TestHandler_ChatMessagesSubscribe(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	result := env.subscribeChatMessages("sess")

	if result.ProcessRunning {
		t.Error("expected process_running=false before message")
	}
	if result.ID == "" {
		t.Error("expected subscription ID")
	}
}

func TestHandler_ChatMessagesSubscribe_ProcessRunning(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	wt := env.getMainWorktree()
	wt.SessionStore.Create(bgCtx, "sess")

	// Start process by sending message
	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "hello")
	env.skipN(2) // Text + Done notifications

	// Verify process is still running
	if !wt.ProcessManager.HasProcess("sess") {
		t.Fatal("expected process to be running")
	}

	// New subscribe should show process_running=true
	result := env.subscribeChatMessages("sess")
	if !result.ProcessRunning {
		t.Error("expected process_running=true after message")
	}
}

func TestHandler_ChatMessagesSubscribe_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("chat.messages.subscribe", rpc.ChatMessagesSubscribeParams{SessionID: "non-existent"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_WebSocketConnection(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Hello"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "Hello AI")

	// Read notifications
	notif1 := env.readNotification()
	notif2 := env.readNotification()

	if notif1.Method != "chat.text" {
		t.Errorf("expected method 'chat.text', got %q", notif1.Method)
	}
	if notif2.Method != "chat.done" {
		t.Errorf("expected method 'chat.done', got %q", notif2.Method)
	}
}

func TestHandler_MultipleSessions(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "session-A")
	store.Create(bgCtx, "session-B")

	env.subscribeChatMessages("session-A")
	env.subscribeChatMessages("session-B")
	env.sendMessage("session-A", "Hello from A")
	env.skipN(2)
	env.sendMessage("session-B", "Hello from B")
	env.skipN(2)
	env.sendMessage("session-A", "Second from A")
	env.skipN(2)

	if len(mock.messagesBySession["session-A"]) != 2 {
		t.Errorf("expected 2 messages for session A, got %d", len(mock.messagesBySession["session-A"]))
	}
	if len(mock.messagesBySession["session-B"]) != 1 {
		t.Errorf("expected 1 message for session B, got %d", len(mock.messagesBySession["session-B"]))
	}
}

func TestHandler_PermissionRequest(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.PermissionRequestEvent{
				RequestID: "req-123",
				ToolName:  "Bash",
				ToolInput: []byte(`{"command":"ls"}`),
				ToolUseID: "toolu_perm",
			},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "run ls")
	notif := env.readNotification()

	if notif.Method != "chat.permission_request" {
		t.Errorf("expected method 'chat.permission_request', got %q", notif.Method)
	}

	var params rpc.PermissionRequestParams
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		t.Fatalf("failed to unmarshal params: %v", err)
	}

	if params.RequestID != "req-123" {
		t.Errorf("expected request_id 'req-123', got %q", params.RequestID)
	}
	if params.ToolName != "Bash" {
		t.Errorf("expected tool_name 'Bash', got %q", params.ToolName)
	}
}

func TestHandler_AgentStartError(t *testing.T) {
	mock := &mockAgent{
		startErr: fmt.Errorf("failed to start agent"),
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	env.subscribeChatMessages("sess")
	resp := env.call("chat.message", rpc.MessageParams{SessionID: "sess", Content: "hello"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "failed to start agent") {
		t.Errorf("expected agent start error, got %+v", resp)
	}
}

func TestHandler_Interrupt(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "hello")
	env.skipN(2)

	sess := mock.sessions["sess"]
	if sess == nil {
		t.Fatal("session should exist")
	}

	resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: "sess"})
	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	select {
	case <-sess.interruptCh:
	case <-env.ctx.Done():
		t.Fatal("timeout waiting for interrupt")
	}
}

func TestHandler_Interrupt_InvalidSession(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("chat.interrupt", rpc.InterruptParams{SessionID: "non-existent"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_NewSession_ResumeFalse(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "new-session")

	env.subscribeChatMessages("new-session")
	env.sendMessage("new-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || mock.startCalls[0].resume {
		t.Errorf("expected resume=false, got %+v", mock.startCalls)
	}

	sess, _, _ := store.Get("new-session")
	if !sess.Activated {
		t.Error("expected session to be activated")
	}
}

func TestHandler_ActivatedSession_ResumeTrue(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.TextEvent{Content: "Response"},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "activated-session")
	store.Activate(bgCtx, "activated-session")

	env.subscribeChatMessages("activated-session")
	env.sendMessage("activated-session", "hello")
	env.skipN(2)

	if len(mock.startCalls) != 1 || !mock.startCalls[0].resume {
		t.Errorf("expected resume=true, got %+v", mock.startCalls)
	}
}

func TestHandler_AskUserQuestion(t *testing.T) {
	mock := &mockAgent{
		events: []agent.AgentEvent{
			agent.AskUserQuestionEvent{
				RequestID: "req-q-123",
				ToolUseID: "toolu_q_123",
				Questions: []agent.AskUserQuestion{
					{
						Question:    "Which library?",
						Header:      "Library",
						Options:     []agent.QuestionOption{{Label: "A", Description: "Option A"}},
						MultiSelect: false,
					},
				},
			},
			agent.DoneEvent{},
		},
	}
	env := newTestEnv(t, mock)
	env.getMainWorktree().SessionStore.Create(bgCtx, "sess")

	env.subscribeChatMessages("sess")
	env.sendMessage("sess", "ask me")
	notif := env.readNotification()

	if notif.Method != "chat.ask_user_question" {
		t.Errorf("expected method 'chat.ask_user_question', got %q", notif.Method)
	}

	var params rpc.AskUserQuestionParams
	if err := json.Unmarshal(notif.Params, &params); err != nil {
		t.Fatalf("failed to unmarshal params: %v", err)
	}

	if params.RequestID != "req-q-123" {
		t.Errorf("expected request_id 'req-q-123', got %q", params.RequestID)
	}
	if len(params.Questions) != 1 {
		t.Errorf("expected 1 question, got %d", len(params.Questions))
	}
	if params.Questions[0].Question != "Which library?" {
		t.Errorf("expected question 'Which library?', got %q", params.Questions[0].Question)
	}
}

func TestHandler_UnknownMethod(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("unknown_method", nil)

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "method not found") {
		t.Errorf("expected method not found error, got %+v", resp)
	}
}

func TestHandler_Message_SessionNotInStore(t *testing.T) {
	mock := &mockAgent{}
	env := newTestEnv(t, mock)

	// Try to send message to non-existent session
	resp := env.call("chat.message", rpc.MessageParams{SessionID: "non-existent-session", Content: "hello"})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

// Session management tests

func TestHandler_SessionListSubscribe(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	store.Create(bgCtx, "session-1")
	store.Create(bgCtx, "session-2")

	resp := env.call("session.list.subscribe", nil)

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	var result struct {
		ID       string                `json:"id"`
		Sessions []session.SessionMeta `json:"sessions"`
	}
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty subscription ID")
	}

	if len(result.Sessions) != 2 {
		t.Errorf("expected 2 sessions, got %d", len(result.Sessions))
	}
}

func TestHandler_SessionCreate(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.create", nil)

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	var result session.SessionMeta
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.ID == "" {
		t.Error("expected non-empty session ID")
	}
	if result.Title != "New Chat" {
		t.Errorf("expected title 'New Chat', got %q", result.Title)
	}
	if result.Activated {
		t.Error("expected activated=false for new session")
	}
}

func TestHandler_SessionDelete(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "to-delete")

	resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sess.ID})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	sessions, _ := store.List()
	if len(sessions) != 0 {
		t.Errorf("expected 0 sessions after delete, got %d", len(sessions))
	}
}

func TestHandler_SessionDelete_ClosesProcess(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	wt := env.getMainWorktree()
	sess, _ := wt.SessionStore.Create(bgCtx, "to-delete-with-process")
	env.sendMessage(sess.ID, "hello")

	if !wt.ProcessManager.HasProcess(sess.ID) {
		t.Fatal("expected process to be running after message")
	}

	resp := env.call("session.delete", rpc.SessionDeleteParams{SessionID: sess.ID})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}
	if wt.ProcessManager.HasProcess(sess.ID) {
		t.Error("expected process to be closed after session delete")
	}
}

func TestHandler_SessionUpdateTitle(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "to-update")

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: sess.ID,
		Title:     "New Title",
	})

	if resp.Error != nil {
		t.Errorf("unexpected error: %s", resp.Error.Message)
	}

	updated, _, _ := store.Get(sess.ID)
	if updated.Title != "New Title" {
		t.Errorf("expected title 'New Title', got %q", updated.Title)
	}
}

func TestHandler_SessionUpdateTitle_EmptyTitle(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	sess, _ := env.getMainWorktree().SessionStore.Create(bgCtx, "to-update")

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: sess.ID,
		Title:     "",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "title required") {
		t.Errorf("expected title required error, got %+v", resp)
	}
}

func TestHandler_SessionUpdateTitle_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("session.update_title", rpc.SessionUpdateTitleParams{
		SessionID: "non-existent",
		Title:     "Title",
	})

	if resp.Error == nil || !strings.Contains(resp.Error.Message, "session not found") {
		t.Errorf("expected session not found error, got %+v", resp)
	}
}

func TestHandler_ChatMessagesSubscribe_History(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	store := env.getMainWorktree().SessionStore
	sess, _ := store.Create(bgCtx, "with-history")
	store.AppendToHistory(bgCtx, sess.ID, map[string]string{"type": "message", "content": "hello"})

	result := env.subscribeChatMessages(sess.ID)

	if len(result.History) != 1 {
		t.Errorf("expected 1 history record, got %d", len(result.History))
	}
}

// File/Git RPC tests

// newWorkDirTestEnv is a convenience wrapper for tests that need a specific workDir.
func newWorkDirTestEnv(t *testing.T, workDir string) *testEnv {
	return newTestEnvWithWorkDir(t, &mockAgent{}, workDir)
}

func TestHandler_FileGet_ListRootDir(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "file.txt"), []byte("hello"), 0644)
	os.Mkdir(filepath.Join(workDir, "subdir"), 0755)

	resp := env.call("file.get", rpc.FileGetParams{Path: ""})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}

	if result.Type != "directory" {
		t.Errorf("expected type 'directory', got %q", result.Type)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(result.Entries))
	}
	if result.Entries[0].Name != "subdir" {
		t.Errorf("expected first entry 'subdir', got %q", result.Entries[0].Name)
	}
	if result.Entries[1].Name != "file.txt" {
		t.Errorf("expected second entry 'file.txt', got %q", result.Entries[1].Name)
	}
}

func TestHandler_FileGet_ListSubDir(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.MkdirAll(filepath.Join(workDir, "src"), 0755)
	os.WriteFile(filepath.Join(workDir, "src", "main.go"), []byte("package main"), 0644)

	resp := env.call("file.get", rpc.FileGetParams{Path: "src"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	json.Unmarshal(resp.Result, &result)

	if result.Type != "directory" {
		t.Errorf("expected type 'directory', got %q", result.Type)
	}
	if len(result.Entries) != 1 || result.Entries[0].Name != "main.go" {
		t.Errorf("expected main.go, got %+v", result.Entries)
	}
}

func TestHandler_FileGet_ReadFile(t *testing.T) {
	workDir := t.TempDir()
	env := newWorkDirTestEnv(t, workDir)
	os.WriteFile(filepath.Join(workDir, "hello.txt"), []byte("world"), 0644)

	resp := env.call("file.get", rpc.FileGetParams{Path: "hello.txt"})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.FileGetResult
	json.Unmarshal(resp.Result, &result)

	if result.Type != "file" {
		t.Errorf("expected type 'file', got %q", result.Type)
	}
	if result.File == nil {
		t.Fatal("expected file content")
	}
	if result.File.Content != "world" {
		t.Errorf("expected content 'world', got %q", result.File.Content)
	}
}

func TestHandler_FileGet_NotFound(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.get", rpc.FileGetParams{Path: "nonexistent.txt"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "not found") {
		t.Errorf("expected 'not found' error, got %q", resp.Error.Message)
	}
}

func TestHandler_FileGet_InvalidPath(t *testing.T) {
	env := newWorkDirTestEnv(t, t.TempDir())

	resp := env.call("file.get", rpc.FileGetParams{Path: "../etc/passwd"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

// Git RPC tests

func setupGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGitIn(t, dir, "init")
	runGitIn(t, dir, "config", "user.email", "test@test.com")
	runGitIn(t, dir, "config", "user.name", "Test")
	runGitIn(t, dir, "config", "commit.gpgsign", "false")
	return dir
}

func runGitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func TestHandler_GitStatus_Empty(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.status", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitStatusResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if len(result.Staged) != 0 || len(result.Unstaged) != 0 {
		t.Errorf("expected empty status, got staged=%d unstaged=%d", len(result.Staged), len(result.Unstaged))
	}
}

func TestHandler_GitStatus_UntrackedFile(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "test.txt"), []byte("hello"), 0644)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.status", nil)

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitStatusResult
	json.Unmarshal(resp.Result, &result)

	if len(result.Unstaged) != 1 {
		t.Fatalf("expected 1 unstaged file, got %d", len(result.Unstaged))
	}
	if result.Unstaged[0].Path != "test.txt" {
		t.Errorf("expected 'test.txt', got %q", result.Unstaged[0].Path)
	}
}

func TestHandler_GitDiffSubscribe_Unstaged(t *testing.T) {
	dir := setupGitRepo(t)

	// Create and commit a file
	testFile := filepath.Join(dir, "test.txt")
	os.WriteFile(testFile, []byte("original"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")

	// Modify the file (unstaged change)
	os.WriteFile(testFile, []byte("modified"), 0644)

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "test.txt", Staged: false})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitDiffSubscribeResult
	json.Unmarshal(resp.Result, &result)

	if result.ID == "" {
		t.Error("expected subscription ID")
	}
	if result.OldContent != "original" {
		t.Errorf("expected old content 'original', got %q", result.OldContent)
	}
	if result.NewContent != "modified" {
		t.Errorf("expected new content 'modified', got %q", result.NewContent)
	}
}

func TestHandler_GitDiffSubscribe_Staged(t *testing.T) {
	dir := setupGitRepo(t)

	// Create and commit a file
	testFile := filepath.Join(dir, "test.txt")
	os.WriteFile(testFile, []byte("original"), 0644)
	runGitIn(t, dir, "add", "test.txt")
	runGitIn(t, dir, "commit", "-m", "initial")

	// Stage a change
	os.WriteFile(testFile, []byte("staged change"), 0644)
	runGitIn(t, dir, "add", "test.txt")

	env := newWorkDirTestEnv(t, dir)
	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "test.txt", Staged: true})

	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.GitDiffSubscribeResult
	json.Unmarshal(resp.Result, &result)

	if result.ID == "" {
		t.Error("expected subscription ID")
	}
	if result.OldContent != "original" {
		t.Errorf("expected old content 'original', got %q", result.OldContent)
	}
	if result.NewContent != "staged change" {
		t.Errorf("expected new content 'staged change', got %q", result.NewContent)
	}
}

func TestHandler_GitDiffSubscribe_PathRequired(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "", Staged: false})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "path required") {
		t.Errorf("expected 'path required' error, got %q", resp.Error.Message)
	}
}

func TestHandler_GitDiffSubscribe_InvalidPath(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("git.diff.subscribe", rpc.GitDiffSubscribeParams{Path: "../etc/passwd", Staged: false})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "invalid path") {
		t.Errorf("expected 'invalid path' error, got %q", resp.Error.Message)
	}
}

// Worktree RPC tests
// Unit tests for worktree logic are in worktree/registry_test.go.
// These integration tests verify RPC layer behavior only.

func TestHandler_WorktreeList(t *testing.T) {
	t.Run("non-git repo returns main only", func(t *testing.T) {
		env := newTestEnv(t, &mockAgent{})

		resp := env.call("worktree.list", nil)
		if resp.Error != nil {
			t.Fatalf("unexpected error: %s", resp.Error.Message)
		}

		var result rpc.WorktreeListResult
		json.Unmarshal(resp.Result, &result)

		if len(result.Worktrees) != 1 || !result.Worktrees[0].IsMain {
			t.Errorf("expected single main worktree, got %+v", result.Worktrees)
		}
	})

	t.Run("git repo includes main", func(t *testing.T) {
		dir := setupGitRepo(t)
		env := newWorkDirTestEnv(t, dir)

		resp := env.call("worktree.list", nil)
		if resp.Error != nil {
			t.Fatalf("unexpected error: %s", resp.Error.Message)
		}

		var result rpc.WorktreeListResult
		json.Unmarshal(resp.Result, &result)

		var hasMain bool
		for _, wt := range result.Worktrees {
			if wt.IsMain {
				hasMain = true
				break
			}
		}
		if !hasMain {
			t.Error("expected main worktree in list")
		}
	})
}

func TestHandler_WorktreeCreate_Validation(t *testing.T) {
	dir := setupGitRepo(t)
	env := newWorkDirTestEnv(t, dir)

	resp := env.call("worktree.create", rpc.WorktreeCreateParams{Name: "", Branch: "branch"})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "name required") {
		t.Errorf("expected 'name required' error, got %+v", resp)
	}

	resp = env.call("worktree.create", rpc.WorktreeCreateParams{Name: "test", Branch: ""})
	if resp.Error == nil || !strings.Contains(resp.Error.Message, "branch required") {
		t.Errorf("expected 'branch required' error, got %+v", resp)
	}
}

func TestHandler_WorktreeCreateAndDelete_E2E(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	// Create
	createResp := env.call("worktree.create", rpc.WorktreeCreateParams{
		Name:   "feature",
		Branch: "feature-branch",
	})
	if createResp.Error != nil {
		t.Fatalf("create failed: %s", createResp.Error.Message)
	}

	var createResult rpc.WorktreeCreateResult
	json.Unmarshal(createResp.Result, &createResult)
	if createResult.Worktree.Name != "feature" {
		t.Errorf("expected name 'feature', got %q", createResult.Worktree.Name)
	}

	// Verify in list
	listResp := env.call("worktree.list", nil)
	var listResult rpc.WorktreeListResult
	json.Unmarshal(listResp.Result, &listResult)

	var found bool
	for _, wt := range listResult.Worktrees {
		if wt.Name == "feature" {
			found = true
			break
		}
	}
	if !found {
		t.Error("created worktree not found in list")
	}

	// Delete
	deleteResp := env.call("worktree.delete", rpc.WorktreeDeleteParams{Name: "feature"})
	if deleteResp.Error != nil {
		t.Fatalf("delete failed: %s", deleteResp.Error.Message)
	}

	// Verify removed from list
	listResp = env.call("worktree.list", nil)
	json.Unmarshal(listResp.Result, &listResult)
	for _, wt := range listResult.Worktrees {
		if wt.Name == "feature" {
			t.Error("deleted worktree still in list")
		}
	}
}

func TestHandler_WorktreeSwitch(t *testing.T) {
	dir := setupGitRepo(t)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# Test"), 0644)
	runGitIn(t, dir, "add", ".")
	runGitIn(t, dir, "commit", "-m", "initial")

	env := newWorkDirTestEnv(t, dir)

	// Create a worktree to switch to
	createResp := env.call("worktree.create", rpc.WorktreeCreateParams{
		Name:   "feature",
		Branch: "feature-branch",
	})
	if createResp.Error != nil {
		t.Fatalf("create failed: %s", createResp.Error.Message)
	}

	// Switch to the new worktree
	switchResp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "feature"})
	if switchResp.Error != nil {
		t.Fatalf("switch failed: %s", switchResp.Error.Message)
	}

	var switchResult rpc.WorktreeSwitchResult
	json.Unmarshal(switchResp.Result, &switchResult)

	if switchResult.WorktreeName != "feature" {
		t.Errorf("expected worktree_name 'feature', got %q", switchResult.WorktreeName)
	}
	if !strings.Contains(switchResult.WorkDir, "feature") {
		t.Errorf("expected work_dir to contain 'feature', got %q", switchResult.WorkDir)
	}

	// Switch back to main (empty name)
	switchResp = env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: ""})
	if switchResp.Error != nil {
		t.Fatalf("switch to main failed: %s", switchResp.Error.Message)
	}

	json.Unmarshal(switchResp.Result, &switchResult)
	if switchResult.WorktreeName != "" {
		t.Errorf("expected empty worktree_name for main, got %q", switchResult.WorktreeName)
	}
}

func TestHandler_WorktreeSwitch_SameWorktree(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	// Switch to main (already on main) - should be no-op
	resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: ""})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}

	var result rpc.WorktreeSwitchResult
	json.Unmarshal(resp.Result, &result)

	// Should return current worktree info without error
	if result.WorkDir == "" {
		t.Error("expected non-empty work_dir")
	}
}

func TestHandler_WorktreeSwitch_NotFound(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})

	resp := env.call("worktree.switch", rpc.WorktreeSwitchParams{Name: "nonexistent"})

	if resp.Error == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(resp.Error.Message, "worktree not found") {
		t.Errorf("expected 'worktree not found' error, got %q", resp.Error.Message)
	}
}
