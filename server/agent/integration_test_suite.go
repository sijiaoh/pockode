//go:build integration

package agent

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// A single real turn that calls a tool routinely takes 45-55s, so a 60s budget
// fails on latency rather than on behaviour.
const integrationTimeout = 120 * time.Second

// IntegrationTestOptions carries the few behaviours the suite cannot require of
// every CLI.
type IntegrationTestOptions struct {
	// DenyEndsInterrupted requires a denied permission to end the turn with an
	// interrupted event rather than a plain done. Opt-in because only some CLIs
	// report the denial as an abort.
	DenyEndsInterrupted bool
}

// RunIntegrationTests runs the full integration test suite for any Agent implementation.
// Tests run sequentially to avoid overloading the system with too many Claude CLI processes.
func RunIntegrationTests(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	t.Run("Chat", func(t *testing.T) {
		runChatTests(t, newAgent)
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
	t.Run("CLIQuestionNeverReachesTheUser", func(t *testing.T) {
		testCLIQuestionNeverReachesTheUser(t, newAgent())
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
	t.Run("MidTurnMessage", func(t *testing.T) {
		testMidTurnMessage(t, newAgent())
	})
	t.Run("MidTurnMessageWhileBlocked", func(t *testing.T) {
		testMidTurnMessageWhileBlocked(t, newAgent())
	})
	t.Run("InterruptWhileBlocked", func(t *testing.T) {
		testInterruptWhileBlocked(t, newAgent())
	})
	t.Run("Usage", func(t *testing.T) {
		testUsage(t, newAgent())
	})
}

// usageCollector folds a CLI's reports into a real session store, so that what
// this test reads back is what a user would see rather than a second
// implementation of the same accumulation. It is also what makes the whole chain
// — CLI frame, parser, accumulator, store — covered by one assertion.
//
// OnUsage is called from the goroutine reading the CLI's output while the test
// reads from its own, so the report count needs the lock. The store has its own.
type usageCollector struct {
	store     session.Store
	sessionID string

	mu      sync.Mutex
	reports int
}

func newUsageCollector(t *testing.T) *usageCollector {
	t.Helper()

	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	const sessionID = "usage-under-test"
	if _, err := store.Create(context.Background(), sessionID, session.CreateSpec{}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	return &usageCollector{store: store, sessionID: sessionID}
}

func (c *usageCollector) collect(report session.UsageReport) {
	c.mu.Lock()
	c.reports++
	c.mu.Unlock()

	if err := c.store.AddUsage(context.Background(), c.sessionID, report); err != nil {
		// Not t.Fatalf: this runs on the CLI's goroutine, where Fatalf would stop
		// the wrong one. The assertions on the stored total catch it.
		panic("AddUsage failed: " + err.Error())
	}
}

func (c *usageCollector) snapshot(t *testing.T) (session.Usage, int) {
	t.Helper()

	c.mu.Lock()
	reports := c.reports
	c.mu.Unlock()

	meta, found, err := c.store.Get(c.sessionID)
	if err != nil || !found {
		t.Fatalf("Get: found=%v err=%v", found, err)
	}
	return meta.Usage, reports
}

// testUsage verifies that a real CLI's own accounting reaches the session store:
// that something is reported at all, that a second turn adds to the stored total
// instead of replacing it, and that the context window is reported.
//
// The figures are read back out of a real session store rather than summed by the
// test, so the accumulation rules are the ones that actually run.
//
// Two turns rather than one, because the failure this guards against is silent
// with one: both CLIs report cumulative totals, so a second turn storing the
// reported figure instead of the increment looks perfectly plausible until the
// numbers are compared across turns.
//
// The assertions are all "more than nothing" and "more than before" — the exact
// figures belong to the model and the prompt, and pinning them would make this
// test fail on a price change or a system prompt edit.
func testUsage(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*integrationTimeout)
	defer cancel()

	collector := newUsageCollector(t)
	sess, err := a.Start(ctx, StartOptions{
		WorkDir:    t.TempDir(),
		DataDir:    t.TempDir(),
		DisableMCP: true,
		OnUsage:    collector.collect,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	var afterFirstTurn session.Usage
	turn := 1

	if err := sess.SendMessage("Reply with just the word one."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed during turn %d", turn)
			}
			switch e := event.(type) {
			case ErrorEvent:
				t.Fatalf("turn %d error event: %s", turn, e.Error)
			case DoneEvent:
				usage, reports := collector.snapshot(t)
				t.Logf("turn %d: %d reports, usage %+v", turn, reports, usage)

				if reports == 0 {
					t.Fatalf("turn %d reported no usage at all", turn)
				}
				if usage.Total() == 0 {
					t.Fatalf("turn %d counted no tokens: %+v", turn, usage)
				}
				if usage.OutputTokens == 0 {
					t.Errorf("turn %d counted no output tokens: %+v", turn, usage)
				}
				if usage.ContextWindow == 0 {
					t.Error("no context window reported")
				}
				if usage.ContextTokens == 0 {
					t.Error("no context size reported")
				}
				if usage.ContextTokens > usage.ContextWindow {
					t.Errorf("context %d exceeds the window %d", usage.ContextTokens, usage.ContextWindow)
				}

				if turn == 2 {
					if usage.Total() <= afterFirstTurn.Total() {
						t.Errorf("second turn added nothing: %d tokens after turn 1, %d after turn 2 — "+
							"the CLI's cumulative total is being stored instead of its increment",
							afterFirstTurn.Total(), usage.Total())
					}
					return
				}

				afterFirstTurn = usage
				turn = 2
				if err := sess.SendMessage("Now reply with just the word two."); err != nil {
					t.Fatalf("SendMessage failed for the second turn: %v", err)
				}
			}

		case <-ctx.Done():
			t.Fatalf("timeout during turn %d", turn)
		}
	}
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

func runChatTests(t *testing.T, newAgent func() Agent) {
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
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
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

// testCLIQuestionNeverReachesTheUser is the contract every CLI Pockode drives
// has to keep: its own ask-the-user tool does not put a question in front of a
// Pockode user, and the turn does not hang waiting for one.
//
// It lives in the shared suite rather than per-CLI because the two halves are
// reached differently and the guarantee is the same. Claude's tool is disabled
// at launch, so the model never calls it; Codex has no such switch, so its
// request_user_input is answered with the refusal. Either way the session must
// come out the same: no question event, and a turn that ends on its own.
//
// It is also the drift check. A CLI upgrade that re-enables the tool, renames
// the flag, or changes the request's shape fails here — rather than in a user's
// session, where the failure is a turn stuck forever on an answer nobody can
// give.
func testCLIQuestionNeverReachesTheUser(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	// Named tools rather than "ask me": the point is to push the model at the
	// built-in one, and each CLI only has the name of its own.
	prompt := "Ask me whether I prefer Python or Go, with exactly those two options. " +
		"Use your built-in AskUserQuestion or request_user_input tool to ask. Then stop."
	if err := sess.SendMessage(prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var refusalWarnings, dones int

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
			case WarningEvent:
				if e.Code == CLIQuestionRefusedCode {
					refusalWarnings++
					t.Logf("refused a CLI question: %s", e.Message)
				}
			case ErrorEvent:
				t.Errorf("error event: %s", e.Error)
			case DoneEvent:
				dones++
				break eventLoop
			case PermissionRequestEvent:
				// Nothing here needs a tool, but a model that reaches for one
				// must not leave the turn blocked on an unanswered prompt.
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionAllow); err != nil {
					t.Fatalf("failed to send permission response: %v", err)
				}
			}
		case <-ctx.Done():
			// The failure this whole test exists to catch: a question was asked,
			// nobody could answer it, and the turn never ended.
			t.Fatal("the turn never ended; a CLI question is waiting for an answer that cannot come")
		}
	}

	if dones != 1 {
		t.Errorf("expected the turn to end once, got %d done events", dones)
	}
	// "No question reached the user" is no longer asserted here because it is no
	// longer possible to assert: there is no event a CLI question could arrive
	// as. That half of the guarantee is the compiler's now, and this test keeps
	// the half a type cannot hold — that the turn ends by itself when the model
	// is pushed straight at the tool.
	//
	// The refusal count is not asserted as >0 either: the tool being invisible to
	// the model is the better outcome and produces no warning at all. What
	// matters is that a refusal, when it happens, is not silent.
	t.Logf("summary: refusal warnings=%d, done=%d", refusalWarnings, dones)
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
	case ToolActivityEvent:
		// The join is the whole of what makes a progress line worth sending: one
		// that names no call says something is happening without saying what
		// asked for it, and the adapters are meant to drop those rather than
		// forward them.
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
		if e.Activity == "" && e.OutputDelta == "" {
			t.Error("tool activity carries neither a status nor output")
		}
	case PermissionRequestEvent:
		requireNonEmpty(t, "RequestID", e.RequestID)
		requireNonEmpty(t, "ToolName", e.ToolName)
		requireNonEmpty(t, "ToolUseID", e.ToolUseID)
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

// midTurnMarker is the word the mid-turn message asks for. Distinctive so that
// its presence in the transcript can only come from the second message having
// been read.
const midTurnMarker = "BANANA"

// midTurnQuietWindow is how long "the CLI is not listening" is asserted over.
//
// Long enough to be a real claim rather than a race — both CLIs answer an
// ordinary message in two to three seconds — and it is an upper bound on
// nothing: the measured silence is unbounded (four minutes on claude-code
// 2.1.263 and codex-cli 0.153.0, which is where the send path's refusal comes
// from).
const midTurnQuietWindow = 20 * time.Second

// testMidTurnMessage is the contract the composer stays unlocked against: a
// message sent while a turn is being worked on reaches the agent, and it lands
// in the turn already running rather than starting a second one.
//
// One ending is the assertion that matters to the rest of the server. Turn state
// is what everything downstream reads (session.ReduceTurn), and an agent that
// answered a mid-turn message in a turn of its own would end twice — which the
// work engine reads as two turns finishing, and nudges twice for.
func testMidTurnMessage(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{
		WorkDir:    t.TempDir(),
		DataDir:    t.TempDir(),
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	// A turn long enough to still be running when the second message arrives,
	// made of tool calls rather than text so that there is a moment to aim at.
	if err := sess.SendMessage("Run this exact bash command three times in a row, one tool call each: sleep 8. " +
		"After each one, say which round you just finished."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	sent := false
	dones := 0
	sawMarker := false

	for {
		var quiet <-chan time.Time
		if dones == 1 {
			// The turn has ended once. Anything further would be a second
			// ending, so the wait for one is what closes this test.
			quiet = time.After(midTurnQuietWindow)
		}

		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed after %d endings, marker seen: %v", dones, sawMarker)
			}
			requireFields(t, event)

			switch e := event.(type) {
			case ToolResultEvent:
				if sent {
					continue
				}
				sent = true
				if err := sess.SendMessage(
					"Change of plan: stop what you are doing and reply with just the word " + midTurnMarker + "."); err != nil {
					t.Fatalf("mid-turn SendMessage failed: %v", err)
				}
			case TextEvent:
				if strings.Contains(e.Content, midTurnMarker) {
					sawMarker = true
				}
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				dones++
				if dones > 1 {
					t.Fatalf("the mid-turn message was answered in a turn of its own: %d endings, want one", dones)
				}
				if !sent {
					t.Fatal("the turn ended before the mid-turn message could be sent; the prompt is not long enough to test anything")
				}
				if !sawMarker {
					t.Errorf("the turn ended without acting on the mid-turn message (no %q in the transcript)", midTurnMarker)
				}
			}

		case <-quiet:
			return

		case <-ctx.Done():
			t.Fatalf("timeout after %d endings, marker seen: %v", dones, sawMarker)
		}
	}
}

// testMidTurnMessageWhileBlocked is the one state a message cannot be delivered
// in, and the reason chat.ErrTurnAwaitingAnswer refuses one rather than letting
// it through.
//
// A CLI holding a permission request open is inside the tool call waiting for
// that answer: it reads nothing else, so a message sent instead of an answer
// produces no event at all. The request itself survives — answering it after the
// ignored message still finishes the turn — which is what makes refusing the
// message the right answer instead of a session nobody can talk to.
func testMidTurnMessageWhileBlocked(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*integrationTimeout)
	defer cancel()

	target := newApprovalTarget(t)
	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(escapeSandboxPrompt(target)); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var pending PermissionRequestData
	blocked := false
	answered := false

	for {
		var quiet <-chan time.Time
		if blocked && !answered {
			quiet = time.After(midTurnQuietWindow)
		}

		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed before the turn finished (blocked=%v answered=%v)", blocked, answered)
			}
			requireFields(t, event)

			// Read before the switch below, so that the request being raised is
			// not itself counted as something that arrived after it.
			if blocked && !answered {
				t.Fatalf("a %s event arrived while the request was open, and nothing arrived when this was measured. "+
					"Either the CLI now reads a message sent instead of an answer — in which case "+
					"chat.ErrTurnAwaitingAnswer refuses one for a reason that no longer holds — or it re-sent the request "+
					"it is still waiting on. Find out which before changing either side", event.EventType())
			}

			switch e := event.(type) {
			case PermissionRequestEvent:
				blocked = true
				pending = permissionDataFromEvent(e)
				if err := sess.SendMessage(
					"Never mind that, forget it. Reply with just the word " + midTurnMarker + "."); err != nil {
					t.Fatalf("mid-turn SendMessage failed: %v", err)
				}
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				if !answered {
					t.Fatal("the turn ended while the request was still unanswered")
				}
				return
			}

		case <-quiet:
			// Nothing came, which is the finding. The request is still the only
			// way forward, so answering it is what ends the turn.
			answered = true
			if err := sess.SendPermissionResponse(pending, PermissionAllow); err != nil {
				t.Fatalf("failed to answer the request the message could not overtake: %v", err)
			}

		case <-ctx.Done():
			t.Fatalf("timeout (blocked=%v answered=%v)", blocked, answered)
		}
	}
}

// testInterruptWhileBlocked is the other half of the refusal: a message cannot
// overtake a request on screen, so the user is told to answer it or stop the
// turn (chat.ErrTurnAwaitingAnswer) — and this is what makes the second half of
// that sentence true.
//
// A CLI blocked on a request is not looking at an interrupt either, so it is not
// obvious that a stop lands at all. Both handle it, for different reasons:
// Codex's adapter answers the outstanding approval with `cancel` before asking
// the turn to stop (see SendInterrupt), and Claude's CLI acts on the control
// request itself — measured on claude-code 2.1.263, which withdrew the request
// and ended the turn in about a tenth of a second.
func testInterruptWhileBlocked(t *testing.T, a Agent) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	target := newApprovalTarget(t)
	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(escapeSandboxPrompt(target)); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	stopped := false

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed before the turn ended (stop sent: %v)", stopped)
			}
			requireFields(t, event)

			switch e := event.(type) {
			case PermissionRequestEvent:
				if stopped {
					continue
				}
				stopped = true
				if err := sess.SendInterrupt(); err != nil {
					t.Fatalf("SendInterrupt failed: %v", err)
				}
			case InterruptedEvent:
				if !stopped {
					t.Fatal("interrupted before the stop was sent")
				}
				return
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				// Not an ending this test accepts: a stop that is answered by
				// the turn finishing normally means the tool ran after all, and
				// the whole point is that it did not.
				t.Fatalf("the turn ended with done rather than interrupted (stop sent: %v)", stopped)
			}

		case <-ctx.Done():
			if !stopped {
				t.Fatal("no permission request ever arrived, so nothing was blocked to stop; the sandbox let the write through")
			}
			t.Fatal("the stop never landed on a turn blocked on a request")
		}
	}
}
