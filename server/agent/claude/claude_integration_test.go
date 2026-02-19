//go:build integration

package claude

import (
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

// requireFields validates that expected fields are non-empty for each event type.
// This ensures Claude CLI's JSON schema matches our parsing expectations.
// Also serves as documentation for AgentEvent's required fields per type.
func requireFields(t *testing.T, event agent.AgentEvent) {
	t.Helper()
	switch e := event.(type) {
	case agent.TextEvent:
		requireNonEmpty(t, "Content", e.Content)
	case agent.ToolCallEvent:
		requireNonEmpty(t, "ToolName", e.ToolName)
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case agent.ToolResultEvent:
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case agent.PermissionRequestEvent:
		requireNonEmpty(t, "RequestID", e.RequestID)
		requireNonEmpty(t, "ToolName", e.ToolName)
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case agent.AskUserQuestionEvent:
		requireNonEmpty(t, "RequestID", e.RequestID)
		if len(e.Questions) == 0 {
			t.Error("missing required field: Questions")
		}
		for i, q := range e.Questions {
			if q.Question == "" {
				t.Errorf("Questions[%d]: missing required field: Question", i)
			}
			if len(q.Options) == 0 {
				t.Errorf("Questions[%d]: missing required field: Options", i)
			}
		}
	case agent.ErrorEvent:
		requireNonEmpty(t, "Error", e.Error)
	}
}

func requireNonEmpty(t *testing.T, field, value string) {
	t.Helper()
	if value == "" {
		t.Errorf("missing required field: %s", field)
	}
}

// Integration tests for Claude CLI.
// These tests call real Claude CLI and consume API tokens.
//
// Run manually with: go test -tags=integration ./agent/claude -v -run Integration
//
// Prerequisites:
//   - claude CLI installed and in PATH
//   - Valid API credentials configured

const chatTimeout = 60 * time.Second

func TestIntegration_ClaudeCliAvailable(t *testing.T) {
	_, err := exec.LookPath(Binary)
	if err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}
}

type chatCase struct {
	name       string
	prompt     string
	expectType agent.EventType
}

func TestIntegration_Chat(t *testing.T) {
	cases := []chatCase{
		{
			name:       "TextEvent",
			prompt:     "Hi",
			expectType: agent.EventTypeText,
		},
		{
			name:       "ToolCallEvent",
			prompt:     "Run this exact bash command: echo hi",
			expectType: agent.EventTypeToolCall,
		},
		{
			name:       "ToolResultEvent",
			prompt:     "Run this exact bash command: echo hi",
			expectType: agent.EventTypeToolResult,
		},
		{
			name:       "PermissionRequestEvent",
			prompt:     "Run this exact bash command: ruby --version",
			expectType: agent.EventTypePermissionRequest,
		},
		{
			name:       "AskUserQuestionEvent",
			prompt:     "Use AskUserQuestion to ask if I like bread. Two options: Yes and No.",
			expectType: agent.EventTypeAskUserQuestion,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			runChatScenario(t, tc)
		})
	}
}

func runChatScenario(t *testing.T, tc chatCase) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), chatTimeout)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	if err := session.SendMessage(tc.prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	found := false

	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				if !found {
					t.Fatalf("channel closed before %s event received", tc.expectType)
				}
				return
			}

			requireFields(t, event)
			t.Logf("event: %s", event.EventType())

			// Check for expected event type
			if event.EventType() == tc.expectType {
				found = true
			}

			// Handle interactive events and terminal conditions
			switch e := event.(type) {
			case agent.PermissionRequestEvent:
				data := agent.PermissionRequestData{
					RequestID:             e.RequestID,
					ToolInput:             e.ToolInput,
					ToolUseID:             e.ToolUseID,
					PermissionSuggestions: e.PermissionSuggestions,
				}
				if err := session.SendPermissionResponse(data, agent.PermissionAllow); err != nil {
					t.Fatalf("failed to send permission response: %v", err)
				}
			case agent.AskUserQuestionEvent:
				if len(e.Questions) > 0 && len(e.Questions[0].Options) > 0 {
					answers := map[string]string{
						e.Questions[0].Question: e.Questions[0].Options[0].Label,
					}
					data := agent.QuestionRequestData{
						RequestID: e.RequestID,
						ToolUseID: e.ToolUseID,
					}
					if err := session.SendQuestionResponse(data, answers); err != nil {
						t.Fatalf("failed to send question response: %v", err)
					}
				}
			case agent.ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case agent.DoneEvent:
				if !found {
					t.Fatalf("DoneEvent reached but %s event never received", tc.expectType)
				}
				return
			}

		case <-ctx.Done():
			t.Fatalf("timeout waiting for %s event", tc.expectType)
		}
	}
}

func TestIntegration_PermissionFlow(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Use a command that will definitely require permission (not pre-approved)
	// Ruby version check is a good candidate as it's not a common pre-approved command
	if err := session.SendMessage("Run this exact command and show output: ruby --version"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var toolCalls, toolResults, errorEvents, permissionRequests int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case agent.ToolCallEvent:
				toolCalls++
				t.Logf("tool_call: %s (id=%s)", e.ToolName, e.ToolUseID)
			case agent.ToolResultEvent:
				toolResults++
				t.Logf("tool_result: id=%s, content=%s", e.ToolUseID, e.ToolResult[:min(100, len(e.ToolResult))])
			case agent.PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: %s (request_id=%s)", e.ToolName, e.RequestID)
				// Auto-approve for integration test (without persistent permission)
				data := agent.PermissionRequestData{
					RequestID:             e.RequestID,
					ToolInput:             e.ToolInput,
					ToolUseID:             e.ToolUseID,
					PermissionSuggestions: e.PermissionSuggestions,
				}
				if err := session.SendPermissionResponse(data, agent.PermissionAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.ErrorEvent:
				errorEvents++
				t.Logf("error: %s", e.Error)
			case agent.TextEvent:
				t.Logf("text: %s", e.Content[:min(100, len(e.Content))])
			case agent.DoneEvent:
				break eventLoop // Message complete
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, tool_calls=%d, tool_results=%d, errors=%d",
		permissionRequests, toolCalls, toolResults, errorEvents)

	// With --permission-prompt-tool stdio, we MUST get permission requests
	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event - permission flow not triggered")
	}

	// After approval, tool should execute
	if permissionRequests > 0 && toolResults == 0 {
		t.Error("permission was approved but no tool_result received")
	}
}

func TestIntegration_Interrupt(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Send a task that takes time
	if err := session.SendMessage("Count from 1 to 100, one number per line"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Wait for some output, then interrupt
	time.Sleep(2 * time.Second)

	if err := session.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt failed: %v", err)
	}

	var interruptedEvents int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			switch event.(type) {
			case agent.InterruptedEvent:
				interruptedEvents++
				break eventLoop
			default:
				t.Logf("event: %T", event)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for interrupted event")
		}
	}

	if interruptedEvents != 1 {
		t.Errorf("expected 1 interrupted event, got %d", interruptedEvents)
	}
}

func TestIntegration_PermissionDeny(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Use a harmless command that will trigger permission request
	// We'll deny it to test the denial flow
	if err := session.SendMessage("Run this bash command: cat /etc/shells"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var permissionRequests, interruptedEvents, doneEvents int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case agent.PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", e.ToolName, e.RequestID)
				// Deny the permission request
				data := agent.PermissionRequestData{
					RequestID:             e.RequestID,
					ToolInput:             e.ToolInput,
					ToolUseID:             e.ToolUseID,
					PermissionSuggestions: e.PermissionSuggestions,
				}
				if err := session.SendPermissionResponse(data, agent.PermissionDeny); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.InterruptedEvent:
				interruptedEvents++
				t.Log("interrupted event received after denial")
				break eventLoop
			case agent.DoneEvent:
				doneEvents++
				t.Log("done event received")
				break eventLoop
			case agent.TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case agent.ErrorEvent:
				t.Logf("error: %s", e.Error)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, interrupted=%d, done=%d",
		permissionRequests, interruptedEvents, doneEvents)

	// We should have received at least one permission request
	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event")
	}

	// After denial with interrupt=true, we expect either interrupted or done event
	if interruptedEvents == 0 && doneEvents == 0 {
		t.Error("expected either interrupted or done event after denial")
	}
}

func TestIntegration_PermissionAlwaysAllow(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Use a command that will definitely trigger permission request
	// Reading system files typically requires explicit approval
	if err := session.SendMessage("Run this bash command: head -3 /etc/shells"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var permissionRequests, toolResults int
	var hasPermissionSuggestions bool

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case agent.PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", e.ToolName, e.RequestID)
				if len(e.PermissionSuggestions) > 0 {
					hasPermissionSuggestions = true
					t.Logf("permission_suggestions: %d items", len(e.PermissionSuggestions))
				}
				// Use AlwaysAllow to test the updatedPermissions flow
				data := agent.PermissionRequestData{
					RequestID:             e.RequestID,
					ToolInput:             e.ToolInput,
					ToolUseID:             e.ToolUseID,
					PermissionSuggestions: e.PermissionSuggestions,
				}
				if err := session.SendPermissionResponse(data, agent.PermissionAlwaysAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.ToolResultEvent:
				toolResults++
				t.Logf("tool_result: id=%s", e.ToolUseID)
			case agent.DoneEvent:
				t.Log("done event received")
				break eventLoop
			case agent.TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case agent.ErrorEvent:
				t.Logf("error: %s", e.Error)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, tool_results=%d, has_suggestions=%v",
		permissionRequests, toolResults, hasPermissionSuggestions)

	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event")
	}

	if toolResults == 0 {
		t.Error("expected at least one tool_result after approval")
	}

	// Log whether permission_suggestions were present (informational)
	if !hasPermissionSuggestions {
		t.Log("note: no permission_suggestions in request - AlwaysAllow will work but won't persist")
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}

// TestIntegration_AskUserQuestionFlow tests the AskUserQuestion event handling.
// This test explicitly instructs Claude to use the AskUserQuestion tool and
// validates the complete question-response flow.
func TestIntegration_AskUserQuestionFlow(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, agent.StartOptions{WorkDir: t.TempDir()})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Instruct Claude to use the AskUserQuestion tool
	prompt := `Use the AskUserQuestion tool to ask me what programming language I prefer: Python or Go. Provide exactly two options.`

	if err := session.SendMessage(prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var questionEvents, doneEvents, errorEvents int
	var selectedAnswer string
	var responseText strings.Builder

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case agent.AskUserQuestionEvent:
				questionEvents++
				t.Logf("ask_user_question: request_id=%s, questions=%d", e.RequestID, len(e.Questions))

				// Validate question structure
				if len(e.Questions) != 1 {
					t.Errorf("expected 1 question, got %d", len(e.Questions))
				}

				q := e.Questions[0]
				t.Logf("  question: %s (options=%d, multiSelect=%v)", q.Question, len(q.Options), q.MultiSelect)

				// Validate options
				if len(q.Options) != 2 {
					t.Errorf("expected 2 options, got %d", len(q.Options))
				}

				// Validate options contain Python and Go
				optionLabels := make(map[string]bool)
				for _, opt := range q.Options {
					optionLabels[opt.Label] = true
					t.Logf("    option: %s - %s", opt.Label, truncate(opt.Description, 50))
				}
				if !optionLabels["Python"] {
					t.Error("expected option 'Python' not found")
				}
				if !optionLabels["Go"] {
					t.Error("expected option 'Go' not found")
				}

				// Select first option (Python)
				selectedAnswer = q.Options[0].Label
				answers := map[string]string{q.Question: selectedAnswer}

				data := agent.QuestionRequestData{
					RequestID: e.RequestID,
					ToolUseID: e.ToolUseID,
				}
				if err := session.SendQuestionResponse(data, answers); err != nil {
					t.Errorf("failed to send question response: %v", err)
				}

			case agent.TextEvent:
				responseText.WriteString(e.Content)
				t.Logf("text: %s", truncate(e.Content, 100))

			case agent.DoneEvent:
				doneEvents++
				break eventLoop

			case agent.ErrorEvent:
				errorEvents++
				t.Errorf("error event: %s", e.Error)

			case agent.PermissionRequestEvent:
				t.Errorf("unexpected permission_request for tool: %s", e.ToolName)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: question_events=%d, done_events=%d, error_events=%d", questionEvents, doneEvents, errorEvents)

	// Strict validations
	if questionEvents != 1 {
		t.Errorf("expected exactly 1 ask_user_question event, got %d (retries indicate response format error)", questionEvents)
	}

	if doneEvents != 1 {
		t.Errorf("expected 1 done event, got %d", doneEvents)
	}

	if errorEvents > 0 {
		t.Errorf("expected 0 error events, got %d", errorEvents)
	}

	// Validate Claude acknowledged the selection
	response := responseText.String()
	if !strings.Contains(strings.ToLower(response), strings.ToLower(selectedAnswer)) {
		t.Errorf("expected Claude's response to mention selected answer %q, got: %s", selectedAnswer, truncate(response, 200))
	}
}
