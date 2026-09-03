//go:build integration

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// A single real turn that calls a tool routinely takes 45-55s, so a 60s budget
// fails on latency rather than on behaviour.
const integrationTimeout = 120 * time.Second

// IntegrationTestOptions configures which tests to skip.
type IntegrationTestOptions struct {
	SkipEvents []EventType

	// DenyEndsInterrupted requires a denied permission to end the turn with an
	// interrupted event rather than a plain done. Opt-in because only some CLIs
	// report the denial as an abort.
	DenyEndsInterrupted bool
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
		testPermissionDeny(t, newAgent(), opts)
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
	t.Run("MultiTurn", func(t *testing.T) {
		testMultiTurn(t, newAgent())
	})
	t.Run("YoloNoPermission", func(t *testing.T) {
		testYoloNoPermission(t, newAgent())
	})
	t.Run("Interrupt", func(t *testing.T) {
		testInterrupt(t, newAgent())
	})
}

type chatCase struct {
	name string
	// prompt is built per run because the approval cases need a fresh
	// out-of-sandbox path that only that run may write to.
	prompt     func(t *testing.T) string
	expectType EventType
	mode       session.Mode
}

func staticPrompt(prompt string) func(*testing.T) string {
	return func(*testing.T) string { return prompt }
}

func runChatTests(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	cases := []chatCase{
		{
			name:       "TextEvent",
			prompt:     staticPrompt("Hi"),
			expectType: EventTypeText,
		},
		{
			name:       "ToolCallEvent",
			prompt:     staticPrompt("Run this exact bash command: echo hi"),
			expectType: EventTypeToolCall,
		},
		{
			name:       "ToolResultEvent",
			prompt:     staticPrompt("Run this exact bash command: echo hi"),
			expectType: EventTypeToolResult,
		},
		{
			name: "PermissionRequestEvent",
			prompt: func(t *testing.T) string {
				return escapeSandboxPrompt(newApprovalTarget(t))
			},
			expectType: EventTypePermissionRequest,
		},
		{
			name:       "AskUserQuestionEvent",
			prompt:     staticPrompt("Use AskUserQuestion to ask if I like bread. Two options: Yes and No."),
			expectType: EventTypeAskUserQuestion,
		},
		{
			name:       "ToolCallEvent/yolo",
			prompt:     staticPrompt("Run this exact bash command: echo hi"),
			expectType: EventTypeToolCall,
			mode:       session.ModeYolo,
		},
		{
			name:       "ToolResultEvent/yolo",
			prompt:     staticPrompt("Run this exact bash command: echo hi"),
			expectType: EventTypeToolResult,
			mode:       session.ModeYolo,
		},
		{
			name:       "AskUserQuestionEvent/yolo",
			prompt:     staticPrompt("Use AskUserQuestion to ask if I like bread. Two options: Yes and No."),
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
	prompt := tc.prompt(t)

	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), Mode: tc.mode, DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(prompt); err != nil {
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

// approvalTargetRoot sits outside every root Codex's workspace-write sandbox
// grants — the working directory, $TMPDIR and /tmp — so writing there is a real
// sandbox escape rather than a command that merely looks risky. A t.TempDir()
// path would sit inside /tmp and need no approval at all, which is how prompts
// that only looked dangerous ended up depending on a broken sandbox to produce
// an approval. Checked against codex-cli 0.153.0 on Linux.
const approvalTargetRoot = "/var/tmp"

// newApprovalTarget returns a path the agent can only create by escaping its
// sandbox. Whether it exists afterwards is what tells an approval apart from a
// denial, independently of what the CLI reported.
func newApprovalTarget(t *testing.T) string {
	t.Helper()
	// $TMPDIR is a writable root, so a $TMPDIR covering approvalTargetRoot would
	// hand the target to the sandbox and no CLI would ask for anything. Name that
	// cause here rather than leave a bare "expected at least one
	// permission_request" for someone to chase.
	if rel, err := filepath.Rel(os.TempDir(), approvalTargetRoot); err == nil && !strings.HasPrefix(rel, "..") {
		t.Fatalf("TMPDIR (%s) contains %s, so the sandbox would make the approval target writable; unset TMPDIR to run the approval tests",
			os.TempDir(), approvalTargetRoot)
	}

	dir, err := os.MkdirTemp(approvalTargetRoot, "pockode-approval-")
	if err != nil {
		t.Fatalf("create out-of-sandbox dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return filepath.Join(dir, "approved.txt")
}

// escapeSandboxPrompt asks for a single command that cannot run without an
// approval. The escape has to be inherent to the command: a command the sandbox
// would have allowed only draws an approval on a machine whose sandbox is
// broken, and even there the CLI asks after the attempt already failed rather
// than before it runs.
func escapeSandboxPrompt(target string) string {
	return fmt.Sprintf("Run this exact command: echo ok > %s\n"+
		"The path is outside your working directory on purpose. Run nothing else.", target)
}

// approvalOutcome is what one turn that blocked on an approval did.
type approvalOutcome struct {
	permissionRequests int
	toolCalls          int
	toolResults        int
	interruptedEvents  int
	doneEvents         int
	suggestions        int
	// targetWritten reports whether the out-of-sandbox file exists once the turn
	// is over.
	targetWritten bool
}

// runApprovalScenario drives one turn that must block on an approval, answering
// every request with choice, and reports what happened.
func runApprovalScenario(t *testing.T, a Agent, choice PermissionChoice) approvalOutcome {
	t.Helper()

	target := newApprovalTarget(t)

	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(escapeSandboxPrompt(target)); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var out approvalOutcome
	askedAfterFailure := false

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
				out.toolCalls++
				t.Logf("tool_call: %s (id=%s)", e.ToolName, e.ToolUseID)
			case ToolResultEvent:
				out.toolResults++
				t.Logf("tool_result: id=%s, content=%s", e.ToolUseID, truncate(e.ToolResult, 100))
			case PermissionRequestEvent:
				out.permissionRequests++
				if out.permissionRequests == 1 && out.toolResults > 0 {
					askedAfterFailure = true
				}
				out.suggestions += len(e.PermissionSuggestions)
				t.Logf("permission_request: tool=%s, request_id=%s, suggestions=%d",
					e.ToolName, e.RequestID, len(e.PermissionSuggestions))
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), choice); err != nil {
					t.Errorf("failed to send permission response: %v", err)
				}
			case TextEvent:
				t.Logf("text: %s", truncate(e.Content, 100))
			case ErrorEvent:
				t.Logf("error: %s", e.Error)
			case InterruptedEvent:
				out.interruptedEvents++
				t.Log("interrupted event received")
				break eventLoop
			case DoneEvent:
				out.doneEvents++
				t.Log("done event received")
				break eventLoop
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for events")
		}
	}

	out.targetWritten = approvalTargetExists(t, target)

	t.Logf("summary: permission_requests=%d, tool_calls=%d, tool_results=%d, interrupted=%d, done=%d, target_written=%v",
		out.permissionRequests, out.toolCalls, out.toolResults,
		out.interruptedEvents, out.doneEvents, out.targetWritten)

	if out.permissionRequests == 0 {
		t.Error("expected at least one permission_request event")
	}
	if askedAfterFailure {
		// The observation is only that something ran first; the prompt asks for a
		// single command, so read the logged events before picking a cause. Either
		// the CLI attempted the escape, failed, and escalated afterwards — the
		// by-product of a broken sandbox this case exists to reject — or the model
		// ran an extra tool the prompt told it not to.
		t.Error("a tool result arrived before the first permission_request, so the approval did not gate the command")
	}
	return out
}

func approvalTargetExists(t *testing.T, target string) bool {
	t.Helper()
	_, err := os.Stat(target)
	if err == nil {
		return true
	}
	if !os.IsNotExist(err) {
		t.Fatalf("stat approval target: %v", err)
	}
	return false
}

// testPermissionAllow verifies the full permission allow flow:
// PermissionRequest → Allow → ToolResult → Done
func testPermissionAllow(t *testing.T, a Agent) {
	out := runApprovalScenario(t, a, PermissionAllow)

	if out.toolResults == 0 {
		t.Error("permission was approved but no tool_result received")
	}
	if !out.targetWritten {
		t.Error("permission was approved but the out-of-sandbox file was never written")
	}
}

// testPermissionDeny verifies the permission deny flow:
// PermissionRequest → Deny → Done/Interrupted, with the command never running.
func testPermissionDeny(t *testing.T, a Agent, opts IntegrationTestOptions) {
	out := runApprovalScenario(t, a, PermissionDeny)

	if out.targetWritten {
		t.Error("permission was denied but the out-of-sandbox file was written anyway")
	}
	if out.interruptedEvents == 0 && out.doneEvents == 0 {
		t.Error("expected either interrupted or done event after denial")
	}
	if opts.DenyEndsInterrupted && out.interruptedEvents == 0 {
		t.Error("expected the denied turn to end as interrupted, not done")
	}
}

// testPermissionAlwaysAllow verifies the always-allow flow with permission suggestions.
func testPermissionAlwaysAllow(t *testing.T, a Agent) {
	out := runApprovalScenario(t, a, PermissionAlwaysAllow)

	if out.toolResults == 0 {
		t.Error("expected at least one tool_result after approval")
	}
	if !out.targetWritten {
		t.Error("permission was always-allowed but the out-of-sandbox file was never written")
	}
	if out.suggestions == 0 {
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

// testMultiTurn verifies that a second message continues the same conversation.
//
// Every other test sends a single message, which is why a CLI renaming the
// identifier that routes follow-up turns can break every conversation without a
// single test failing: the reply is rejected inside a successful response, so
// the turn still ends in a plain done event.
func testMultiTurn(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Remember this number: 31415. Reply with just OK."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	const secondTurn = "What number did I ask you to remember? Reply with the number only."
	turn := 1
	var response strings.Builder

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed during turn %d", turn)
			}
			requireFields(t, event)

			switch e := event.(type) {
			case TextEvent:
				t.Logf("turn %d text: %s", turn, truncate(e.Content, 100))
				if turn == 2 {
					response.WriteString(e.Content)
				}
			case ErrorEvent:
				t.Fatalf("turn %d error event: %s", turn, e.Error)
			case InterruptedEvent:
				t.Fatalf("turn %d ended as interrupted", turn)
			case DoneEvent:
				if turn == 2 {
					if !strings.Contains(response.String(), "31415") {
						t.Errorf("second turn lost the conversation: expected the number back, got %q",
							truncate(response.String(), 200))
					}
					return
				}
				turn = 2
				if err := sess.SendMessage(secondTurn); err != nil {
					t.Fatalf("SendMessage failed for the second turn: %v", err)
				}
			}

		case <-ctx.Done():
			t.Fatalf("timeout during turn %d", turn)
		}
	}
}

// testYoloNoPermission verifies that yolo mode skips permission prompts. It asks
// for the same sandbox escape the approval tests use, so passing means yolo
// really lifted the sandbox — a command the sandbox would have allowed anyway
// would prove nothing about the mode.
func testYoloNoPermission(t *testing.T, a Agent) {
	target := newApprovalTarget(t)

	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), Mode: session.ModeYolo, DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(escapeSandboxPrompt(target)); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			requireFields(t, event)
			t.Logf("event: %s", event.EventType())

			switch e := event.(type) {
			case PermissionRequestEvent:
				t.Fatalf("unexpected permission_request in yolo mode: tool=%s", e.ToolName)
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				break eventLoop
			}
		case <-ctx.Done():
			t.Fatal("timeout")
		}
	}

	if !approvalTargetExists(t, target) {
		t.Error("yolo mode asked for nothing but the out-of-sandbox file was never written")
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
