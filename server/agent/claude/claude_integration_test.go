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
	switch event.Type {
	case agent.EventTypeText:
		requireNonEmpty(t, "Content", event.Content)
	case agent.EventTypeToolCall:
		requireNonEmpty(t, "ToolName", event.ToolName)
		requireNonEmpty(t, "ToolUseID", event.ToolUseID)
	case agent.EventTypeToolResult:
		requireNonEmpty(t, "ToolUseID", event.ToolUseID)
	case agent.EventTypePermissionRequest:
		requireNonEmpty(t, "RequestID", event.RequestID)
		requireNonEmpty(t, "ToolName", event.ToolName)
		requireNonEmpty(t, "ToolUseID", event.ToolUseID)
	case agent.EventTypeAskUserQuestion:
		requireNonEmpty(t, "RequestID", event.RequestID)
		if len(event.Questions) == 0 {
			t.Error("missing required field: Questions")
		}
		for i, q := range event.Questions {
			if q.Question == "" {
				t.Errorf("Questions[%d]: missing required field: Question", i)
			}
			if len(q.Options) == 0 {
				t.Errorf("Questions[%d]: missing required field: Options", i)
			}
		}
	case agent.EventTypeError:
		requireNonEmpty(t, "Error", event.Error)
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

func TestIntegration_ClaudeCliAvailable(t *testing.T) {
	_, err := exec.LookPath(Binary)
	if err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}
}

func TestIntegration_SimplePrompt(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	session, err := a.Start(ctx, t.TempDir(), "", false)
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer session.Close()

	// Send the first message
	if err := session.SendMessage("Reply with exactly: OK"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var textEvents, doneEvents int

eventLoop:
	for {
		select {
		case event, ok := <-session.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch event.Type {
			case agent.EventTypeText:
				textEvents++
				t.Logf("text: %s", event.Content)
			case agent.EventTypeDone:
				doneEvents++
				break eventLoop // Message complete, exit loop
			case agent.EventTypeError:
				t.Errorf("error event: %s", event.Error)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	if textEvents == 0 {
		t.Error("expected at least one text event")
	}
	if doneEvents != 1 {
		t.Errorf("expected exactly 1 done event, got %d", doneEvents)
	}
}

func TestIntegration_PermissionFlow(t *testing.T) {
	a := New()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	session, err := a.Start(ctx, t.TempDir(), "", false)
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
			switch event.Type {
			case agent.EventTypeToolCall:
				toolCalls++
				t.Logf("tool_call: %s (id=%s)", event.ToolName, event.ToolUseID)
			case agent.EventTypeToolResult:
				toolResults++
				t.Logf("tool_result: id=%s, content=%s", event.ToolUseID, event.ToolResult[:min(100, len(event.ToolResult))])
			case agent.EventTypePermissionRequest:
				permissionRequests++
				t.Logf("permission_request: %s (request_id=%s)", event.ToolName, event.RequestID)
				// Auto-approve for integration test (without persistent permission)
				if err := session.SendPermissionResponse(event.RequestID, agent.PermissionAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.EventTypeError:
				errorEvents++
				t.Logf("error: %s", event.Error)
			case agent.EventTypeText:
				t.Logf("text: %s", event.Content[:min(100, len(event.Content))])
			case agent.EventTypeDone:
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

	session, err := a.Start(ctx, t.TempDir(), "", false)
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
			t.Logf("event: %s", event.Type)
			if event.Type == agent.EventTypeInterrupted {
				interruptedEvents++
				break eventLoop
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

	session, err := a.Start(ctx, t.TempDir(), "", false)
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
			switch event.Type {
			case agent.EventTypePermissionRequest:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", event.ToolName, event.RequestID)
				// Deny the permission request
				if err := session.SendPermissionResponse(event.RequestID, agent.PermissionDeny); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.EventTypeInterrupted:
				interruptedEvents++
				t.Log("interrupted event received after denial")
				break eventLoop
			case agent.EventTypeDone:
				doneEvents++
				t.Log("done event received")
				break eventLoop
			case agent.EventTypeText:
				t.Logf("text: %s", truncate(event.Content, 100))
			case agent.EventTypeError:
				t.Logf("error: %s", event.Error)
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

	session, err := a.Start(ctx, t.TempDir(), "", false)
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
			switch event.Type {
			case agent.EventTypePermissionRequest:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", event.ToolName, event.RequestID)
				if len(event.PermissionSuggestions) > 0 {
					hasPermissionSuggestions = true
					t.Logf("permission_suggestions: %d items", len(event.PermissionSuggestions))
				}
				// Use AlwaysAllow to test the updatedPermissions flow
				if err := session.SendPermissionResponse(event.RequestID, agent.PermissionAlwaysAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case agent.EventTypeToolResult:
				toolResults++
				t.Logf("tool_result: id=%s", event.ToolUseID)
			case agent.EventTypeDone:
				t.Log("done event received")
				break eventLoop
			case agent.EventTypeText:
				t.Logf("text: %s", truncate(event.Content, 100))
			case agent.EventTypeError:
				t.Logf("error: %s", event.Error)
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

	session, err := a.Start(ctx, t.TempDir(), "", false)
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
			switch event.Type {
			case agent.EventTypeAskUserQuestion:
				questionEvents++
				t.Logf("ask_user_question: request_id=%s, questions=%d", event.RequestID, len(event.Questions))

				// Validate question structure
				if len(event.Questions) != 1 {
					t.Errorf("expected 1 question, got %d", len(event.Questions))
				}

				q := event.Questions[0]
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

				if err := session.SendQuestionResponse(event.RequestID, answers); err != nil {
					t.Errorf("failed to send question response: %v", err)
				}

			case agent.EventTypeText:
				responseText.WriteString(event.Content)
				t.Logf("text: %s", truncate(event.Content, 100))

			case agent.EventTypeDone:
				doneEvents++
				break eventLoop

			case agent.EventTypeError:
				errorEvents++
				t.Errorf("error event: %s", event.Error)

			case agent.EventTypePermissionRequest:
				t.Errorf("unexpected permission_request for tool: %s", event.ToolName)
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
