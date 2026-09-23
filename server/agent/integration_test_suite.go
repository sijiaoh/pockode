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

	"github.com/google/uuid"

	"github.com/pockode/server/session"
)

// Generous on purpose: this only ever decides how a stuck run is reported, and a
// budget picked close to the measured times (a turn that calls a tool ran 7-8s on
// claude and 18-26s on codex) would turn a loaded machine into a red suite.
const integrationTimeout = 120 * time.Second

// IntegrationTestOptions carries the few behaviours the suite cannot require of
// every CLI.
type IntegrationTestOptions struct {
	// DenyEndsInterrupted requires a denied permission to end the turn with an
	// interrupted event rather than a plain done. Opt-in because only some CLIs
	// report the denial as an abort.
	DenyEndsInterrupted bool

	// ForkedSessions, when set, is called at the end of the fork-from-the-middle
	// scenario. Forking is an Agent contract and the experiment is the same for
	// every CLI, but where each of the two sessions goes on living is recorded in
	// a form only that CLI's own package can read — a provider session id, a
	// thread id — so that half is checked there.
	ForkedSessions func(t *testing.T, check ForkCheck)

	// StreamsCommandOutput requires a foreground command that prints something
	// to report that output as tool activity while it is still running. It also
	// picks which command the chat scenario runs, because a CLI can only stream
	// output it has not already finished producing — see runChatTests for the
	// shape that leaves something to stream.
	//
	// Opt-in because only some CLIs stream a running call at all: Claude reports
	// progress for a subagent and never for a shell command, background or
	// foreground, so requiring it of an ordinary bash call would fail there for
	// a reason that is not a defect — its own package requires the event on a
	// turn that runs a subagent instead. The CLIs that do stream need it
	// required somewhere, because tool activity is the one event Pockode
	// broadcasts without recording: a renamed field stops the UI's
	// long-running row from updating and nothing anywhere reports an error.
	StreamsCommandOutput bool
}

// ForkCheck names what a CLI needs to look up its own record of the fork the
// shared scenario has just taken.
type ForkCheck struct {
	DataDir         string
	SourceSessionID string
	ForkSessionID   string

	// ForkQuestion is the prompt only the forked session was sent, and
	// PostForkTurn the prompt the source alone was sent after the fork was
	// taken. A CLI that can read the source's own transcript can look for both
	// there: the question appearing in it means the fork's turn was written into
	// the source's conversation, and the post-fork prompt missing from it means
	// the source lost the turn it took after being forked from.
	//
	// Whole prompts rather than the words they carry, because the scenario goes
	// on to ask the source to name every word it was given: its answer puts all
	// three of them back into the transcript, so searching for one of the words
	// would find it whether or not the turn that introduced it survived.
	ForkQuestion string
	PostForkTurn string
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
	t.Run("CLIQuestionNeverReachesTheUser", func(t *testing.T) {
		testCLIQuestionNeverReachesTheUser(t, newAgent())
	})
	t.Run("MultiTurn", func(t *testing.T) {
		testMultiTurn(t, newAgent())
	})
	t.Run("ForkFromTheMiddle", func(t *testing.T) {
		testForkFromTheMiddle(t, newAgent, opts)
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

// checkTurnUsage asserts everything one turn's accounting has to satisfy on its
// own and returns the stored total, which the caller compares across turns.
//
// Every failure here is an Errorf, never a Fatalf: this shares its two turns with
// an assertion about the conversation itself, and a fatal would end the scenario
// before that one was ever reached — so broken accounting would leave no verdict
// at all on whether the second message continued the conversation. The two
// claims are independent and each has to be able to fail on its own.
func checkTurnUsage(t *testing.T, collector *usageCollector, turn int) session.Usage {
	t.Helper()

	usage, reports := collector.snapshot(t)
	t.Logf("usage after turn %d: %d reports, %+v", turn, reports, usage)

	if reports == 0 {
		t.Errorf("usage: turn %d reported no usage at all", turn)
	}
	if usage.Total() == 0 {
		t.Errorf("usage: turn %d counted no tokens: %+v", turn, usage)
	}
	if usage.OutputTokens == 0 {
		t.Errorf("usage: turn %d counted no output tokens: %+v", turn, usage)
	}
	if usage.ContextWindow == 0 {
		t.Errorf("usage: turn %d reported no context window", turn)
	}
	if usage.ContextTokens == 0 {
		t.Errorf("usage: turn %d reported no context size", turn)
	}
	if usage.ContextTokens > usage.ContextWindow {
		t.Errorf("usage: turn %d context %d exceeds the window %d", turn, usage.ContextTokens, usage.ContextWindow)
	}
	return usage
}

// chatCase is one session that has to produce a set of events before its turn
// ends. A set rather than one event, because a prompt that draws two of them
// draws both in the same turn: asserting them one session each pays twice for
// the same conversation.
type chatCase struct {
	name        string
	prompt      string
	expectTypes []EventType
}

func runChatTests(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	// A bash call is a tool call and its result, so the turn that runs one is
	// also where a streaming CLI owes a tool activity: the event needs no second
	// conversation to appear.
	//
	// What it does need is a command that is still running after it has printed.
	// `echo hi` never is: measured against codex-cli 0.153.0, a command that
	// finishes at once carries its whole output on the completion frame and
	// sends no delta whatsoever — in every approval mode, and whether or not the
	// sandbox escalated, since none of those change the execution path. What
	// changes it is having output to report while the command still holds the
	// call open, so the prompt below prints a line and then goes on sleeping.
	// Printing everything and *then* sleeping would not do: the last line of a
	// run is folded into the completion frame the same way (three lines a second
	// apart produced two deltas, not three), which is also why five lines rather
	// than the three that were measured — the count is margin, not a threshold.
	//
	// The CLIs that owe no activity keep `echo hi`: the sleeps buy them nothing
	// and every second of them is paid on every run.
	commandPrompt := "Run this exact bash command: echo hi"
	commandEvents := []EventType{EventTypeToolCall, EventTypeToolResult}
	if opts.StreamsCommandOutput {
		commandPrompt = `Run this exact bash command: for i in 1 2 3 4 5; do echo "line $i"; sleep 1; done`
		commandEvents = append(commandEvents, EventTypeToolActivity)
	}

	cases := []chatCase{
		{
			name:        "TextEvent",
			prompt:      "Hi",
			expectTypes: []EventType{EventTypeText},
		},
		{
			name:        "ToolCallAndResultEvents",
			prompt:      commandPrompt,
			expectTypes: commandEvents,
		},
		// PermissionRequestEvent has no case of its own: the prompt and the
		// response would be testPermissionAllow's, which already asserts the
		// event and then checks what answering it did.
		//
		// Nor do the two tool events have a yolo variant here. The mode changes
		// whether a call is asked about, not what a call looks like, and
		// testYoloNoPermission runs a tool call in yolo mode already — so it
		// asserts the two events on the turn it was going to run anyway.
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runChatScenario(t, newAgent(), tc)
		})
	}
}

func runChatScenario(t *testing.T, a Agent, tc chatCase) {
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(Prompt{Text: tc.prompt}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	seen := make(map[EventType]bool, len(tc.expectTypes))
	missing := func() []EventType {
		var out []EventType
		for _, want := range tc.expectTypes {
			if !seen[want] {
				out = append(out, want)
			}
		}
		return out
	}

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				if left := missing(); len(left) > 0 {
					t.Fatalf("channel closed before %v received", left)
				}
				return
			}

			RequireEventFields(t, event)
			t.Logf("event: %s", event.EventType())
			seen[event.EventType()] = true

			switch e := event.(type) {
			case PermissionRequestEvent:
				// Not asserted here, but a tool call in the default mode may be
				// asked about, and an unanswered request never ends the turn.
				if err := sess.SendPermissionResponse(permissionDataFromEvent(e), PermissionAllow); err != nil {
					t.Fatalf("failed to send permission response: %v", err)
				}
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				if left := missing(); len(left) > 0 {
					t.Fatalf("DoneEvent reached but %v never received", left)
				}
				return
			}

		case <-ctx.Done():
			t.Fatalf("timeout waiting for %v", missing())
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

	if err := sess.SendMessage(Prompt{Text: escapeSandboxPrompt(target)}); err != nil {
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
			RequireEventFields(t, event)
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
	if err := sess.SendMessage(Prompt{Text: prompt}); err != nil {
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
			RequireEventFields(t, event)
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

// testMultiTurn verifies that a second message continues the same conversation,
// and on the same two turns that a real CLI's own accounting reaches the session
// store: that something is reported at all, that a second turn adds to the
// stored total instead of replacing it, and that the context window is reported.
//
// Two claims in one scenario because both need exactly the same thing — a tiny
// two-turn conversation — and differ only in what they read off it. The
// conversation half is why a second message is sent at all: every other test
// sends a single message, which is why a CLI renaming the identifier that
// routes follow-up turns can break every conversation without a single test
// failing, since the reply is rejected inside a successful response and the turn
// still ends in a plain done event. The accounting half needs the second turn
// for its own reason: both CLIs report cumulative totals, so a second turn
// storing the reported figure instead of the increment looks perfectly
// plausible until the numbers are compared across turns.
//
// Neither group can hide the other: the usage assertions are all non-fatal (see
// checkTurnUsage) so a broken accounting still lets the conversation reach its
// own verdict, and their messages are prefixed so a red run says which claim
// broke. What does end the scenario early is the turn itself failing — an error
// or an interrupt — and then there is no turn for either group to read. The
// usage figures are read back out of a
// real session store rather than summed here, so the accumulation rules are the
// ones that actually run, and every usage assertion is "more than nothing" or
// "more than before" — the exact figures belong to the model and the prompt, and
// pinning them would make this fail on a price change or a system prompt edit.
func testMultiTurn(t *testing.T, a Agent) {
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

	if err := sess.SendMessage(Prompt{Text: "Remember this number: 31415. Reply with just OK."}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	const secondTurn = "What number did I ask you to remember? Reply with the number only."
	turn := 1
	var response strings.Builder
	var afterFirstTurn session.Usage

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed during turn %d", turn)
			}
			RequireEventFields(t, event)

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
				usage := checkTurnUsage(t, collector, turn)

				if turn == 2 {
					// Only meaningful if turn 1 counted something. Comparing two
					// zeros would report a second failure for the one cause
					// checkTurnUsage has already named.
					if afterFirstTurn.Total() > 0 && usage.Total() <= afterFirstTurn.Total() {
						t.Errorf("usage: second turn added nothing: %d tokens after turn 1, %d after turn 2 — "+
							"the CLI's cumulative total is being stored instead of its increment",
							afterFirstTurn.Total(), usage.Total())
					}
					if !strings.Contains(response.String(), "31415") {
						t.Errorf("second turn lost the conversation: expected the number back, got %q",
							truncate(response.String(), 200))
					}
					return
				}

				afterFirstTurn = usage
				turn = 2
				if err := sess.SendMessage(Prompt{Text: secondTurn}); err != nil {
					t.Fatalf("SendMessage failed for the second turn: %v", err)
				}
			}

		case <-ctx.Done():
			t.Fatalf("timeout during turn %d", turn)
		}
	}
}

// The words the fork experiment turns on. The source is given them in order and
// the fork is taken after the first, so which of the three a session names is
// the whole of what says where its conversation was cut.
const (
	forkKeptWord     = "BANANA"
	forkDroppedWord  = "KIWI"
	forkPostForkWord = "PAPAYA"
)

// forkQuestion is asked only of the fork and sourceQuestion only of the source.
// Two wordings for one question, because forkQuestion is handed to
// IntegrationTestOptions.ForkedSessions as the one text that exists nowhere but
// in the fork's conversation: a single wording asked of both would sit in the
// source's own record legitimately, and a CLI searching for it there could no
// longer tell pollution from the source answering its own question.
const (
	forkQuestion   = "Which words were you told to remember? Name every single one of them."
	sourceQuestion = "What words did I ask you to remember? List every one of them."
)

// postForkPrompt is the turn the source takes after the fork has been taken, and
// the whole of it is what IntegrationTestOptions.ForkedSessions is handed — see
// ForkCheck.PostForkTurn for why the word inside it would not do.
const postForkPrompt = "Now also remember this word: " + forkPostForkWord + ". Reply with exactly: ok"

// testForkFromTheMiddle is the check behind the two claims that make a fork
// worth taking from anywhere in a conversation: the agent really does cut the
// conversation it carries at the point the fork was taken from, and pinning the
// cut to that point really does make a source whose process is still running —
// and still adding to its own conversation — safe to fork from.
//
// It is in the shared suite because ForkSession is an Agent contract, not a
// CLI's: the two halves are reached differently (Claude replays its provider
// session with --resume-session-at, Codex asks for a `thread/fork` at a turn id)
// and the experiment they have to pass is the same one. What only the CLI can
// check — which conversation each session ends up on — is opts.ForkedSessions.
func testForkFromTheMiddle(t *testing.T, newAgent func() Agent, opts IntegrationTestOptions) {
	forker, ok := newAgent().(SessionForker)
	if !ok {
		t.Skip("this agent implements no SessionForker, so there is no fork to take")
	}

	// Four real turns on the source plus one on the fork.
	ctx, cancel := context.WithTimeout(context.Background(), 5*integrationTimeout)
	defer cancel()

	workDir := t.TempDir()
	dataDir := t.TempDir()
	sourceID := uuid.Must(uuid.NewV7()).String()

	source, err := newAgent().Start(ctx, StartOptions{
		WorkDir:    workDir,
		DataDir:    dataDir,
		SessionID:  sourceID,
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start source failed: %v", err)
	}
	defer source.Close()

	kept := TurnOn(t, ctx, source, "Remember this word: "+forkKeptWord+". Reply with exactly: ok")
	anchor := LastProviderMessageID(kept.Records)
	if anchor == "" {
		t.Fatal("no event in the turn carried an id the fork could be cut at")
	}
	dropped := TurnOn(t, ctx, source, "Now also remember this word: "+forkDroppedWord+". Reply with exactly: ok")
	if LastProviderMessageID(dropped.Records) == anchor {
		t.Fatal("the second turn reused the first turn's id, so the cut proves nothing")
	}

	// The history the fork gets, in the form chat.Client.Fork hands it over: the
	// source's records up to the anchor. The source process is still up and has
	// already written past that point.
	forkID := uuid.Must(uuid.NewV7()).String()
	carried, err := forker.ForkSession(ctx, ForkOptions{
		WorkDir:         workDir,
		DataDir:         dataDir,
		SourceSessionID: sourceID,
		SessionID:       forkID,
		History:         kept.Records,
	})
	if err != nil {
		t.Fatalf("ForkSession: %v", err)
	}
	if !carried {
		t.Fatal("a fork with a message to cut at reported no carried context")
	}

	// The source keeps talking after the fork was taken. Nothing it says now may
	// reach the new session either.
	TurnOn(t, ctx, source, postForkPrompt)

	said := RunPrompt(t, newAgent(), workDir, dataDir, forkID, true, forkQuestion)
	if !strings.Contains(said, forkKeptWord) {
		t.Fatalf("the fork did not remember the conversation up to the cut, it said: %s", said)
	}
	for _, past := range []string{forkDroppedWord, forkPostForkWord} {
		if strings.Contains(said, past) {
			t.Fatalf("the fork knows %s, which the source said after the cut; it said: %s", past, said)
		}
	}

	// The source is untouched by any of it, the fork's own turn included — which
	// is why this is asked after that turn and not before it.
	said = TurnOn(t, ctx, source, sourceQuestion).Said
	for _, word := range []string{forkKeptWord, forkDroppedWord, forkPostForkWord} {
		if !strings.Contains(said, word) {
			t.Errorf("the source lost %s from its own conversation, it said: %s", word, said)
		}
	}

	if opts.ForkedSessions != nil {
		opts.ForkedSessions(t, ForkCheck{
			DataDir:         dataDir,
			SourceSessionID: sourceID,
			ForkSessionID:   forkID,
			ForkQuestion:    forkQuestion,
			PostForkTurn:    postForkPrompt,
		})
	}
}

// testYoloNoPermission verifies that yolo mode skips permission prompts. It asks
// for the same sandbox escape the approval tests use, so passing means yolo
// really lifted the sandbox — a command the sandbox would have allowed anyway
// would prove nothing about the mode.
//
// It is also where the two tool events are asserted under yolo, rather than in a
// session of their own: the escape is a tool call, so this turn produces the
// call and its result whether or not anything looks at them.
func testYoloNoPermission(t *testing.T, a Agent) {
	target := newApprovalTarget(t)

	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), Mode: session.ModeYolo, DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(Prompt{Text: escapeSandboxPrompt(target)}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var sawToolCall, sawToolResult bool

eventLoop:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				break eventLoop
			}
			RequireEventFields(t, event)
			t.Logf("event: %s", event.EventType())

			switch e := event.(type) {
			case ToolCallEvent:
				sawToolCall = true
			case ToolResultEvent:
				sawToolResult = true
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
	if !sawToolCall {
		t.Error("no tool_call event in yolo mode, though the turn ran a command")
	}
	if !sawToolResult {
		t.Error("no tool_result event in yolo mode, though the turn ran a command")
	}
}

// testInterrupt verifies that SendInterrupt stops the current task.
//
// The interrupt is aimed at the first event that proves a turn is being worked on
// rather than at a fixed delay: that is the earliest moment there is anything to
// stop, and so the moment with the most turn left to cut short. A sleep long
// enough to be safe on a loaded machine is long enough to miss a fast turn
// entirely — measured, this prompt finishes in under five seconds, which the old
// two-second sleep left almost no margin against.
//
// A turn that ends anyway is not a pass. Nothing was interrupted, so there is no
// evidence either way about SendInterrupt, and reporting that as success is how
// this test used to go green without asserting anything.
func testInterrupt(t *testing.T, a Agent) {
	// The suite's ordinary budget rather than a tighter one of its own: an
	// interrupted turn is short — measured at 4s on claude and 15-30s on codex,
	// most of the latter being startup — so the deadline only ever decides how a
	// failure is reported, and a hand-picked 30s made that report depend on how
	// busy the machine was. Codex has already been seen at 30s: the old budget
	// was not margin at all.
	ctx, cancel := context.WithTimeout(context.Background(), integrationTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{WorkDir: t.TempDir(), DataDir: t.TempDir(), DisableMCP: true})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage(Prompt{Text: "Count from 1 to 100, one number per line"}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	sent := false

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed before the turn ended (stop sent: %v)", sent)
			}

			switch e := event.(type) {
			case InterruptedEvent:
				if !sent {
					t.Fatal("interrupted before the stop was sent")
				}
				return

			case DoneEvent:
				// Skipped, not passed, and not failed either: whether the turn
				// outran the stop or ignored it is not something this test can
				// tell apart, so it reports that it proved nothing.
				if !sent {
					t.Skip("the turn ended before it produced anything to aim a stop at; " +
						"the CLI answered before any output arrived")
				}
				t.Skip("the turn ran to completion after the stop was sent, so nothing was interrupted; " +
					"either it was already finishing or the stop was ignored — rerun, and if it always ends here, " +
					"SendInterrupt is the suspect")

			case ErrorEvent:
				// Terminal, so waiting for an interrupted event after it would
				// only ever time out, and the timeout would name the wrong cause.
				t.Fatalf("error event: %s", e.Error)

			case TextEvent, ToolCallEvent, ToolResultEvent, ToolActivityEvent, PermissionRequestEvent:
				// The turn is provably in flight: these can only come from the
				// CLI working on the message. A request also has to be one of
				// them — nobody here answers it, so a turn blocked on one would
				// otherwise sit there until the deadline.
				if !sent {
					sent = true
					t.Logf("stopping the turn on its first event: %T", event)
					if err := sess.SendInterrupt(); err != nil {
						t.Fatalf("SendInterrupt failed: %v", err)
					}
				}

			case WarningEvent:
				// Measured, not hypothetical: codex-cli emits one of these
				// before the turn produces anything. Logged rather than aimed
				// at, and logged with its message because a warning is the kind
				// of thing worth reading when this test does end up red.
				t.Logf("warning event: %s (%s)", e.Message, e.Code)

			default:
				// A system frame, the process ending, and anything else the CLI
				// can emit before it has read the message. Stopping a turn that
				// has not started is the race this test was changed to stop
				// having, so these are recorded and nothing more.
				t.Logf("event: %T", event)
			}

		case <-ctx.Done():
			if !sent {
				t.Fatal("the turn never produced an event showing it was in flight, so there was never anything to stop " +
					"(any events that did arrive are logged above)")
			}
			t.Fatal("timeout waiting for interrupted event")
		}
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

// RequireEventFields validates that expected fields are non-empty for each event type.
// This ensures the agent implementation's JSON schema matches our parsing expectations.
//
// Exported so that a per-CLI test covering an event the shared suite cannot
// reach — Claude's tool activity, which a subagent's progress produces and a
// shell command never does, background or foreground — checks the same shape
// rather than restating it.
func RequireEventFields(t *testing.T, event AgentEvent) {
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

// midTurnOpenerID and midTurnMessageID are Pockode's own ids for the two
// messages, in the form the send path mints them. An agent that can carry an id
// through echoes the second one back at its read point, which is the only thing
// that says *which* message a boundary belongs to when several are queued.
//
// The opener carries one as well, and that is the point of it: an echo of the
// turn's first message has to be passed over because it is the turn's first,
// not because it happened to carry nothing to identify it. Sending the opener
// without an id would let a broken skip look correct.
const (
	midTurnOpenerID  = "pockode-msg-opener"
	midTurnMessageID = "pockode-msg-midturn"
)

// midTurnReadPoints is what one turn showed about its boundary, gathered as the
// turn runs and judged once it is over. A struct rather than the five loose
// values it used to be: three of them are ints that mean entirely different
// things, and passing them positionally is a transposition away from an
// assertion that reads well and checks something else.
type midTurnReadPoints struct {
	// records counts the events so far that history keeps
	// (EventType.Persisted), so that the two indices below are positions in the
	// stream a client replays rather than in the live one. The two differ by the
	// events nothing records, and a boundary that held in only one of them would
	// give a reloading tab a different transcript from the one that watched the
	// turn happen.
	records int

	// seen counts the read points the session reported, and id is the message
	// the last of them named.
	seen int
	id   string

	// point and marker are the records the boundary and the answer to the
	// mid-turn message landed at, or -1 for one that never arrived — or, for the
	// boundary, arrived as an event history does not keep.
	point  int
	marker int
}

// testMidTurnMessage is the contract the composer stays unlocked against: a
// message sent while a turn is being worked on reaches the agent, it lands in
// the turn already running rather than starting a second one, and the transcript
// shows its answer below it rather than above.
//
// One ending is the assertion that matters to the rest of the server. Turn state
// is what everything downstream reads (session.ReduceTurn), and an agent that
// answered a mid-turn message in a turn of its own would end twice — which the
// work engine reads as two turns finishing, and nudges twice for.
//
// Where that one turn's output is cut in two is the other half, and only a real
// CLI can answer it: the boundary is agent.MessageIngestedEvent, which an agent
// that reports its own read point emits from the CLI's echo of the message.
// Everything about that — that the echo comes at all, that it comes *before* the
// answer rather than after, that the id survives the round trip, and that the
// message which opened the turn does not produce one — is CLI behaviour, and
// there is nothing below this level that can check it. The unit tests hold the
// server's side of it (agent/codex/appserver_test.go, chat/ingest_test.go); this
// holds the CLI's.
//
// An agent that reports nothing has the read point written for it at the moment
// the message is handed over (chat.Client.sendEvent), which is a server-side
// decision with no CLI behaviour in it — so what is checked here is the one
// thing that would make that write wrong: that the session does not also emit a
// read point of its own, which would cut the transcript twice for one message.
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

	// Which of the two shapes this agent is. Asked of the session rather than of
	// the CLI's name, because that is the same question chat.Client asks before
	// deciding to write the read point itself.
	_, reportsIngest := sess.(MessageIngestReporter)

	// A turn long enough to still be running when the second message arrives,
	// made of tool calls rather than text so that there is a moment to aim at.
	if err := sess.SendMessage(Prompt{
		Text: "Run this exact bash command three times in a row, one tool call each: sleep 8. " +
			"After each one, say which round you just finished.",
		ID: midTurnOpenerID,
	}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	sent := false
	dones := 0
	sawMarker := false
	cut := midTurnReadPoints{point: -1, marker: -1}

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
			RequireEventFields(t, event)

			record := -1
			if event.EventType().Persisted() {
				record = cut.records
				cut.records++
			}

			switch e := event.(type) {
			case ToolResultEvent:
				if sent {
					continue
				}
				sent = true
				if err := sess.SendMessage(Prompt{
					Text: "Change of plan: stop what you are doing and reply with just the word " + midTurnMarker + ".",
					ID:   midTurnMessageID,
				}); err != nil {
					t.Fatalf("mid-turn SendMessage failed: %v", err)
				}
			case MessageIngestedEvent:
				cut.seen++
				cut.point = record
				cut.id = e.MessageID
				if !reportsIngest {
					t.Errorf("the session emitted a read point though it does not implement MessageIngestReporter, " +
						"so the send path has written one too and the transcript is cut twice for one message")
				}
				if !sent {
					t.Error("a read point arrived for the message that opened the turn; nothing had been said yet, " +
						"so it marks a boundary where the message record already is (see claimTurnOpener)")
				}
			case TextEvent:
				if strings.Contains(e.Content, midTurnMarker) {
					sawMarker = true
					if cut.marker < 0 {
						cut.marker = record
					}
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
			cut.check(t, reportsIngest)
			return

		case <-ctx.Done():
			t.Fatalf("timeout after %d endings, marker seen: %v", dones, sawMarker)
		}
	}
}

// check holds what the turn as a whole has to show about the boundary, as
// opposed to what each event has to show as it arrives.
func (c midTurnReadPoints) check(t *testing.T, reportsIngest bool) {
	t.Helper()

	if !reportsIngest {
		// Already reported per event if it happened; this is the count, for a
		// run where several arrived.
		if c.seen != 0 {
			t.Errorf("got %d read points from an agent that reports none", c.seen)
		}
		return
	}

	if c.seen != 1 {
		t.Fatalf("got %d read points, want exactly one: the turn was sent one mid-turn message, "+
			"and a client cuts the transcript once per read point", c.seen)
	}
	if c.id != midTurnMessageID {
		t.Errorf("the read point names message %q, want %q: the id Pockode sent the message with did not survive "+
			"the round trip, so nothing says which of several queued messages was read", c.id, midTurnMessageID)
	}
	if c.point < 0 {
		// Asserted rather than assumed, because every comparison below passes
		// when it is not: a boundary history does not keep is a boundary a
		// reloading client never sees, and -1 sorts before every real record.
		t.Fatalf("the read point arrived as an event history does not keep, so the split exists only for the tab "+
			"that watched the turn (EventType.Persisted for %s)", EventTypeMessageIngested)
	}
	if c.marker < 0 {
		// The turn-level miss is already reported at the ending; nothing to add.
		return
	}
	if c.marker < c.point {
		t.Errorf("the answer to the mid-turn message is record %d and the read point is record %d, so a client "+
			"replaying the session draws the answer above the question it answers", c.marker, c.point)
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

	if err := sess.SendMessage(Prompt{Text: escapeSandboxPrompt(target)}); err != nil {
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
			RequireEventFields(t, event)

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
				if err := sess.SendMessage(Prompt{Text: "Never mind that, forget it. Reply with just the word " + midTurnMarker + "."}); err != nil {
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

	if err := sess.SendMessage(Prompt{Text: escapeSandboxPrompt(target)}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	stopped := false

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatalf("channel closed before the turn ended (stop sent: %v)", stopped)
			}
			RequireEventFields(t, event)

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
