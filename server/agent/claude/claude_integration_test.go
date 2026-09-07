//go:build integration

package claude

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

func TestIntegration_ClaudeCliAvailable(t *testing.T) {
	_, err := exec.LookPath(Binary)
	if err != nil {
		t.Fatalf("claude CLI not found in PATH: %v", err)
	}
}

func TestIntegration(t *testing.T) {
	agent.RunIntegrationTests(t, func() agent.Agent { return New() }, agent.IntegrationTestOptions{
		DenyEndsInterrupted: true,
	})
}

// TestIntegration_NoInternalSystemNoise locks the system-event allowlist. Even a
// single bash call makes the CLI emit internal bookkeeping events (init,
// task_started, task_notification, thinking_tokens); none of them belong in the
// transcript, so a plain tool turn must produce no system event at all.
func TestIntegration_NoInternalSystemNoise(t *testing.T) {
	// A real turn that calls a tool routinely takes 45-55s.
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	sess, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    t.TempDir(),
		DataDir:    t.TempDir(),
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Run this exact bash command: echo hi"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before done event")
			}
			switch e := event.(type) {
			case agent.SystemEvent:
				t.Errorf("unexpected system event in transcript: %s", e.Content)
			case agent.ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case agent.DoneEvent:
				return
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for done event")
		}
	}
}

// TestIntegration_RecoversBurnedSessionID reproduces the state that used to make
// a session permanently unusable: the CLI owns <pockodeID>.jsonl (it claims the
// id at the first turn) while Pockode has no provider id recorded, because the
// turn died before we wrote one. Relaunching with --session-id then aborts with
// "Session ID ... is already in use" forever.
func TestIntegration_RecoversBurnedSessionID(t *testing.T) {
	workDir := t.TempDir()
	dataDir := t.TempDir()
	sessionID := uuid.Must(uuid.NewV7()).String()

	// Let the CLI claim sessionID, then drop our record of it.
	runTurn(t, workDir, dataDir, sessionID, false)
	statePath := filepath.Join(dataDir, "sessions", sessionID, resumeStateFile)
	if err := os.Remove(statePath); err != nil {
		t.Fatalf("remove resume state: %v", err)
	}

	// The next message must recover instead of failing on the burned id.
	runTurn(t, workDir, dataDir, sessionID, true)

	data, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("read resume state: %v", err)
	}
	var state claudeResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parse resume state: %v", err)
	}
	if state.Recovery != recoveryNone {
		t.Errorf("recovery = %q after a successful turn, want empty", state.Recovery)
	}
	if state.SessionID == sessionID {
		t.Errorf("provider session id is still the burned id %q; the fork should have minted a new one", sessionID)
	}
	if _, err := uuid.Parse(state.SessionID); err != nil {
		t.Errorf("recorded session id %q is not a UUID: %v", state.SessionID, err)
	}
}

// runTurn drives one complete message through a real CLI process.
func runTurn(t *testing.T, workDir, dataDir, sessionID string, resume bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	sess, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    workDir,
		DataDir:    dataDir,
		SessionID:  sessionID,
		Resume:     resume,
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Reply with exactly: ok"); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before done event")
			}
			switch e := event.(type) {
			case agent.ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case agent.DoneEvent:
				return
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for done event")
		}
	}
}

// TestIntegration_BackgroundTaskDoesNotEndTheTurn covers the CLI behaviour that
// no other adapter has: after starting a background task the CLI ends the turn
// with an ordinary success result and then resumes output by itself once the
// task finishes, without the host sending anything. Pockode must report a single
// turn, so the first result frame is swallowed and the only DoneEvent arrives
// after the resumed output.
//
// Codex has no background tasks, which is why this lives here and not in the
// shared suite.
func TestIntegration_BackgroundTaskDoesNotEndTheTurn(t *testing.T) {
	// The measured run took ~50s; the task alone sleeps 20s.
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	sess, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    t.TempDir(),
		DataDir:    t.TempDir(),
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	if err := sess.SendMessage("Use the Bash tool with run_in_background: true to run exactly: sleep 20; echo MARKER_DONE . " +
		"Do NOT poll or wait for it. Immediately end your turn with the single word STARTED. " +
		"Later when you are notified that it finished, reply RESUMED followed by its output."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Both markers matter: MARKER_DONE is the resumed output, and STARTED before
	// it proves the model really did end its turn instead of polling in-turn —
	// without that, a compliant-looking run could pass without ever exercising
	// the swallow.
	var sawStarted, sawMarker bool
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before done event")
			}
			switch e := event.(type) {
			case agent.TextEvent:
				if !sawMarker && strings.Contains(e.Content, "STARTED") {
					sawStarted = true
				}
				if strings.Contains(e.Content, "MARKER_DONE") {
					sawMarker = true
				}
			case agent.ToolResultEvent:
				if strings.Contains(e.ToolResult, "MARKER_DONE") {
					sawMarker = true
				}
			case agent.ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case agent.DoneEvent:
				if !sawMarker {
					t.Fatal("turn ended while the background task was still running; the pseudo-ending was not swallowed")
				}
				if !sawStarted {
					t.Skip("model waited on the task in-turn instead of ending it; the background wait was never entered")
				}
				return
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for done event")
		}
	}
}

// The CLI's behaviour when it is interrupted with no active turn was never
// verified, and a background wait is exactly that situation: Pockode swallowed
// the ending, the UI still shows a running turn with a Stop button, and the CLI
// has nothing running. Whatever the CLI answers, Stop must land the session in a
// state the user can read — it must not leave the spinner running forever.
func TestIntegration_StopDuringBackgroundWait(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	sess, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    t.TempDir(),
		DataDir:    t.TempDir(),
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	// Long enough that the task is certainly still running when Stop is pressed.
	if err := sess.SendMessage("Use the Bash tool with run_in_background: true to run exactly: sleep 120; echo MARKER_DONE . " +
		"Do NOT poll or wait for it. Immediately end your turn with the single word STARTED. " +
		"Later when you are notified that it finished, reply RESUMED followed by its output."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var interruptSent bool
	// The result frame follows the last text within a second or so; this gives it
	// room so the interrupt really lands during the wait and not before it.
	interruptAfter := time.NewTimer(time.Hour)
	defer interruptAfter.Stop()

	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before the session settled")
			}
			switch e := event.(type) {
			case agent.TextEvent:
				if !interruptSent && strings.Contains(e.Content, "STARTED") {
					interruptAfter.Reset(5 * time.Second)
				}
			case agent.DoneEvent:
				// The model ignored the instructions and finished in one turn, so
				// there was no wait to press Stop during. A model-behaviour miss,
				// not a regression.
				t.Skip("the turn ended before any background wait began")
			case agent.InterruptedEvent:
				if !interruptSent {
					t.Fatal("got an interrupt event before Stop was pressed")
				}
				return
			case agent.ErrorEvent:
				// Also acceptable: the user asked for a stop and got a readable
				// explanation instead of a silent spinner.
				if !interruptSent {
					t.Fatalf("error event before Stop was pressed: %s", e.Error)
				}
				t.Logf("stop during the wait ended the turn with an error: %s", e.Error)
				return
			}
		case <-interruptAfter.C:
			if err := sess.SendInterrupt(); err != nil {
				t.Fatalf("SendInterrupt failed: %v", err)
			}
			interruptSent = true
		case <-ctx.Done():
			if !interruptSent {
				t.Skip("the model never ended its turn on a background task, so Stop was never pressed")
			}
			t.Fatal("Stop during the background wait never produced an ending: the UI would spin forever")
		}
	}
}

// TestIntegration_LostBackgroundTasksAreReportedOnRestart covers the other half
// of a background wait: the tasks live inside the CLI process, so killing it —
// an idle reap, a stop, a server restart — destroys them. The turn was being
// held open for results that are now never coming, and the user has to be told
// so instead of finding the work quietly stopped.
func TestIntegration_LostBackgroundTasksAreReportedOnRestart(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 240*time.Second)
	defer cancel()

	workDir := t.TempDir()
	dataDir := t.TempDir()
	sessionID := uuid.Must(uuid.NewV7()).String()

	sess, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    workDir,
		DataDir:    dataDir,
		SessionID:  sessionID,
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}

	if err := sess.SendMessage("Use the Bash tool with run_in_background: true to run exactly: sleep 120; echo MARKER_DONE . " +
		"Do NOT poll or wait for it. Immediately end your turn with the single word STARTED. " +
		"Later when you are notified that it finished, reply RESUMED followed by its output."); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Kill the process while the task is still running, a few seconds after the
	// turn's last text so the swallowed result frame has certainly arrived.
	killAfter := time.NewTimer(time.Hour)
	defer killAfter.Stop()

waitForKill:
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("the process ended on its own before it could be killed")
			}
			switch event.(type) {
			case agent.TextEvent:
				killAfter.Reset(5 * time.Second)
			case agent.DoneEvent:
				// The model ignored the instructions and finished in one turn, so
				// there was no background task left to lose.
				sess.Close()
				t.Skip("the turn ended without leaving a background task running")
			}
		case <-killAfter.C:
			// The same predicate the idle reaper consults, on a real process in a
			// real wait: it must be exempt at exactly this moment, because this is
			// the moment reaping it would destroy the task below.
			if waiter, ok := sess.(agent.BackgroundWaiter); !ok || !waiter.WaitingForBackgroundWork() {
				t.Error("a session waiting on a background task must be exempt from the idle reaper")
			}
			sess.Close()
			break waitForKill
		case <-ctx.Done():
			t.Fatal("timeout waiting for the turn to start a background task")
		}
	}

	// The loss is recorded as the process tears down, so wait for it to finish.
	for range sess.Events() {
	}

	resumed, err := New().Start(ctx, agent.StartOptions{
		WorkDir:    workDir,
		DataDir:    dataDir,
		SessionID:  sessionID,
		Resume:     true,
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed on resume: %v", err)
	}
	defer resumed.Close()

	for {
		select {
		case event, ok := <-resumed.Events():
			if !ok {
				t.Fatal("the resumed session never mentioned the lost background task")
			}
			if warning, isWarning := event.(agent.WarningEvent); isWarning && warning.Code == backgroundTasksLostCode {
				return
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for the lost background task to be reported")
		}
	}
}
