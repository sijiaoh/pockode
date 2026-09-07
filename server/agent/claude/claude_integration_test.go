//go:build integration

package claude

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
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
