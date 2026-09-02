//go:build integration

package claude

import (
	"context"
	"os/exec"
	"testing"
	"time"

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
