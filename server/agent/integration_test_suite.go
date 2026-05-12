//go:build integration

package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

const integrationTimeout = 60 * time.Second

// IntegrationTestOptions configures which tests to skip.
type IntegrationTestOptions struct {
	SkipEvents []EventType
}

func shouldSkip(opts IntegrationTestOptions, eventType EventType) bool {
	for _, skip := range opts.SkipEvents {
		if skip == eventType {
			return true
		}
	}
	return false
}

// RunIntegrationTests runs the full integration test suite for any Agent implementation.
// Tests run sequentially to avoid overloading the system with too many Claude CLI processes.
func RunIntegrationTests(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	t.Run("Chat", func(t *testing.T) {
		runChatTests(t, newAgent, opts)
	})
	t.Run("PermissionAllow", func(t *testing.T) {
		testPermissionAllow(t, newAgent())
	})
	t.Run("PermissionDeny", func(t *testing.T) {
		testPermissionDeny(t, newAgent())
	})
	t.Run("PermissionAlwaysAllow", func(t *testing.T) {
		testPermissionAlwaysAllow(t, newAgent())
	})
	t.Run("AskUserQuestionFlow", func(t *testing.T) {
		if shouldSkip(opts, EventTypeAskUserQuestion) {
			t.Skip("skipped by IntegrationTestOptions")
		}
		testAskUserQuestionFlow(t, newAgent())
	})
	t.Run("YoloNoPermission", func(t *testing.T) {
		testYoloNoPermission(t, newAgent())
	})
	t.Run("Interrupt", func(t *testing.T) {
		testInterrupt(t, newAgent())
	})
}

type chatCase struct {
	name       string
	prompt     string
	expectType EventType
	mode       session.Mode
}

func runChatTests(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	cases := []chatCase{
		{
			name:       "TextEvent",
			prompt:     "Hi",
			expectType: EventTypeText,
		},
		{
			name:       "ToolCallEvent",
			prompt:     "Run this exact bash command: echo hi",
			expectType: EventTypeToolCall,
		},
		{
			name:       "ToolResultEvent",
			prompt:     "Run this exact bash command: echo hi",
			expectType: EventTypeToolResult,
		},
		{
			name:       "PermissionRequestEvent",
			prompt:     "Run this exact bash command: ruby --version",
			expectType: EventTypePermissionRequest,
		},
		{
			name:       "AskUserQuestionEvent",
			prompt:     "Use AskUserQuestion to ask if I like bread. Two options: Yes and No.",
			expectType: EventTypeAskUserQuestion,
		},
		{
			name:       "ToolCallEvent/yolo",
			prompt:     "Run this exact bash command: echo hi",
			expectType: EventTypeToolCall,
			mode:       session.ModeYolo,
		},
		{
			name:       "ToolResultEvent/yolo",
			prompt:     "Run this exact bash command: echo hi",
			expectType: EventTypeToolResult,
			mode:       session.ModeYolo,
		},
		{
			name:       "AskUserQuestionEvent/yolo",
			prompt:     "Use AskUserQuestion to ask if I like bread. Two options: Yes and No.",
			expectType: EventTypeAskUserQuestion,
			mode:       session.ModeYolo,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if shouldSkip(opts, tc.expectType) {
				t.Skip("skipped by IntegrationTestOptions")
			}
			runChatScenario(t, newAgent(), tc)
		})
	}
}

func runChatScenario(t *testing.T, a Agent, tc chatCase) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), Mode: tc.mode, DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(tc.prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	found := false

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				if !found {
					t.Fatalf("channel closed before %s event received", tc.expectType)
				}
				return
			}

			requireFields(t, event)
			t.Logf("event: %s", event.EventType())

			if event.EventType() == tc.expectType {
				found = true
			}

			switch e := event.(type) {
			case PermissionRequestEvent:
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionAllow); err != nil {
					t.Fatalf("failed to send permission response: %v", err)
				}
			case AskUserQuestionEvent:
				if len(e.Questions) > 0 && len(e.Questions[0].Options) > 0 {
					answers := map[string]string{
						e.Questions[0].Question: e.Questions[0].Options[0].Label,
					}
					data := QuestionRequestData{
						RequestID: e.RequestID,
						ToolUseID: e.ToolUseID,
					}
					if err := sess.SendQuestionResponse(data, answers); err != nil {
						t.Fatalf("failed to send question response: %v", err)
					}
				}
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
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

// testPermissionAllow verifies the full permission allow flow:
// PermissionRequest → Allow → ToolResult → Done
func testPermissionAllow(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Run this exact command and show output: ruby --version"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var toolCalls, toolResults, permissionRequests int

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case ToolCallEvent:
				toolCalls++
				t.Logf("tool_call: %s (id=%s)", e.ToolName, e.ToolUseID)
			case ToolResultEvent:
				toolResults++
				t.Logf("tool_result: id=%s, content=%s", e.ToolUseID, truncate(e.ToolResult, 100))
			case PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: %s (request_id=%s)", e.ToolName, e.RequestID)
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case ErrorEvent:
				t.Logf("error: %s", e.Error)
			case TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case DoneEvent:
				break eventLoop
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, tool_calls=%d, tool_results=%d",
		permissionRequests, toolCalls, toolResults)

	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event")
	}
	if permissionRequests > 0 && toolResults == 0 {
		t.Error("permission was approved but no tool_result received")
	}
}

// testPermissionDeny verifies the permission deny flow:
// PermissionRequest → Deny → Done/Interrupted
func testPermissionDeny(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Run this bash command: cat /etc/shells"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var permissionRequests, interruptedEvents, doneEvents int

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", e.ToolName, e.RequestID)
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionDeny); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case InterruptedEvent:
				interruptedEvents++
				t.Log("interrupted event received after denial")
				break eventLoop
			case DoneEvent:
				doneEvents++
				t.Log("done event received")
				break eventLoop
			case TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case ErrorEvent:
				t.Logf("error: %s", e.Error)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: permission_requests=%d, interrupted=%d, done=%d",
		permissionRequests, interruptedEvents, doneEvents)

	if permissionRequests == 0 {
		t.Error("expected at least one permission_request event")
	}
	if interruptedEvents == 0 && doneEvents == 0 {
		t.Error("expected either interrupted or done event after denial")
	}
}

// testPermissionAlwaysAllow verifies the always-allow flow with permission suggestions.
func testPermissionAlwaysAllow(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Run this bash command: head -3 /etc/shells"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var permissionRequests, toolResults int
	var hasPermissionSuggestions bool

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case PermissionRequestEvent:
				permissionRequests++
				t.Logf("permission_request: tool=%s, request_id=%s", e.ToolName, e.RequestID)
				if len(e.PermissionSuggestions) > 0 {
					hasPermissionSuggestions = true
					t.Logf("permission_suggestions: %d items", len(e.PermissionSuggestions))
				}
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionAlwaysAllow); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case ToolResultEvent:
				toolResults++
				t.Logf("tool_result: id=%s", e.ToolUseID)
			case DoneEvent:
				t.Log("done event received")
				break eventLoop
			case TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case ErrorEvent:
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
	if !hasPermissionSuggestions {
		t.Log("note: no permission_suggestions in request - AlwaysAllow will work but won't persist")
	}
}

// testAskUserQuestionFlow verifies the complete AskUserQuestion flow:
// Question → Answer → Text response mentioning the answer → Done
func testAskUserQuestionFlow(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	prompt := `Use the AskUserQuestion tool to ask me what programming language I prefer: Python or Go. Provide exactly two options.`
	if err := sess.SendMessage(prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var questionEvents, doneEvents, errorEvents int
	var selectedAnswer string
	var responseText strings.Builder

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			switch e := event.(type) {
			case AskUserQuestionEvent:
				questionEvents++
				t.Logf("ask_user_question: request_id=%s, questions=%d", e.RequestID, len(e.Questions))

				if len(e.Questions) == 0 {
					t.Fatalf("expected at least 1 question, got 0")
				}
				if len(e.Questions) != 1 {
					t.Errorf("expected 1 question, got %d", len(e.Questions))
				}

				q := e.Questions[0]
				t.Logf("  question: %s (options=%d, multiSelect=%v)", q.Question, len(q.Options), q.MultiSelect)

				if len(q.Options) != 2 {
					t.Errorf("expected 2 options, got %d", len(q.Options))
				}

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

				selectedAnswer = q.Options[0].Label
				answers := map[string]string{q.Question: selectedAnswer}

				data := QuestionRequestData{
					RequestID: e.RequestID,
					ToolUseID: e.ToolUseID,
				}
				if err := sess.SendQuestionResponse(data, answers); err != nil {
					t.Errorf("failed to send question response: %v", err)
				}

			case TextEvent:
				responseText.WriteString(e.Content)
				t.Logf("text: %s", truncate(e.Content, 100))

			case DoneEvent:
				doneEvents++
				break eventLoop

			case ErrorEvent:
				errorEvents++
				t.Errorf("error event: %s", e.Error)

			case PermissionRequestEvent:
				t.Errorf("unexpected permission_request for tool: %s", e.ToolName)
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	t.Logf("summary: question_events=%d, done_events=%d, error_events=%d", questionEvents, doneEvents, errorEvents)

	if questionEvents != 1 {
		t.Errorf("expected exactly 1 ask_user_question event, got %d (retries indicate response format error)", questionEvents)
	}
	if doneEvents != 1 {
		t.Errorf("expected 1 done event, got %d", doneEvents)
	}
	if errorEvents > 0 {
		t.Errorf("expected 0 error events, got %d", errorEvents)
	}
	response := responseText.String()
	if !strings.Contains(strings.ToLower(response), strings.ToLower(selectedAnswer)) {
		t.Errorf("expected response to mention selected answer %q, got: %s", selectedAnswer, truncate(response, 200))
	}
}

// testYoloNoPermission verifies that yolo mode skips permission prompts.
func testYoloNoPermission(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), Mode: session.ModeYolo, DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Run this exact bash command: ruby --version"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				return
			}
			requireFields(t, event)
			t.Logf("event: %s", event.EventType())

			switch e := event.(type) {
			case PermissionRequestEvent:
				t.Fatalf("unexpected permission_request in yolo mode: tool=%s", e.ToolName)
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				return
			}
		case <-ctx.Done():
			t.Fatal("timeout")
		}
	}
}

// testInterrupt verifies that SendInterrupt stops the current task.
func testInterrupt(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Count from 1 to 100, one number per line"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Wait for some output, then interrupt
	time.Sleep(2 * time.Second)

	if err := sess.SendInterrupt(); err != nil {
		t.Fatalf("SendInterrupt failed: %v", err)
	}

	var interruptedEvents int

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			switch event.(type) {
			case InterruptedEvent:
				interruptedEvents++
				break eventLoop
			case DoneEvent:
				t.Log("done event received before interrupted - task may have completed before interrupt was sent")
				return
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

// --- helpers ---

func permissionDataFromEvent(e PermissionRequestEvent) PermissionRequestData {
	return PermissionRequestData{
		RequestID:             e.RequestID,
		ToolInput:             e.ToolInput,
		ToolUseID:             e.ToolUseID,
		PermissionSuggestions: e.PermissionSuggestions,
	}
}

// requireFields validates that expected fields are non-empty for each event type.
// This ensures the agent implementation's JSON schema matches our parsing expectations.
func requireFields(t *testing.T, event AgentEvent) {
	t.Helper()
	switch e := event.(type) {
	case TextEvent:
		requireNonEmpty(t, "Content", e.Content)
	case ToolCallEvent:
		requireNonEmpty(t, "ToolName", e.ToolName)
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case ToolResultEvent:
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case PermissionRequestEvent:
		requireNonEmpty(t, "RequestID", e.RequestID)
		requireNonEmpty(t, "ToolName", e.ToolName)
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
	case AskUserQuestionEvent:
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
	case ErrorEvent:
		requireNonEmpty(t, "Error", e.Error)
	}
}

func requireNonEmpty(t *testing.T, field, value string) {
	t.Helper()
	if value == "" {
		t.Errorf("missing required field: %s", field)
	}
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
