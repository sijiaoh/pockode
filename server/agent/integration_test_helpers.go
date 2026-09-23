//go:build integration

package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// promptRunTimeout is a ceiling on one helper-driven turn, not a wait. It is the
// larger of the two per-CLI budgets these helpers were merged from, so no CLI
// got less room than it had.
const promptRunTimeout = 180 * time.Second

// PromptRun is one turn, in each of the forms the tests read it back in.
type PromptRun struct {
	// Said is everything the agent said in the turn.
	Said string
	// Warnings are the turn's warning events, which a test reads to check what
	// the user was told about something that went wrong but did not fail the turn.
	Warnings []WarningEvent
	// Records are the turn's events as history stores them — the form a fork
	// reads to find the point it was taken at.
	Records []json.RawMessage
}

// RunPrompt drives one complete message through a real CLI process and returns
// everything the agent said.
func RunPrompt(t *testing.T, a Agent, workDir, dataDir, sessionID string, resume bool, prompt string) string {
	t.Helper()
	return RunPromptCollecting(t, a, workDir, dataDir, sessionID, resume, prompt).Said
}

// RunPromptCollecting is RunPrompt with the whole turn kept rather than only
// what the agent said.
func RunPromptCollecting(t *testing.T, a Agent, workDir, dataDir, sessionID string, resume bool, prompt string) PromptRun {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), promptRunTimeout)
	defer cancel()

	sess, err := a.Start(ctx, StartOptions{
		WorkDir:   workDir,
		DataDir:   dataDir,
		SessionID: sessionID,
		Resume:    resume,
		// Yolo, so no approval prompt can block a turn nobody is watching.
		Mode:       session.ModeYolo,
		DisableMCP: true,
	})
	if err != nil {
		t.Fatalf("Start failed: %v", err)
	}
	defer sess.Close()

	return TurnOn(t, ctx, sess, prompt)
}

// TurnOn sends one message to an already running session and collects that turn,
// up to and including its ending.
func TurnOn(t *testing.T, ctx context.Context, sess Session, prompt string) PromptRun {
	t.Helper()
	if err := sess.SendMessage(Prompt{Text: prompt}); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var said strings.Builder
	var run PromptRun
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before done event")
			}
			raw, err := json.Marshal(NewEventRecord(event))
			if err != nil {
				t.Fatalf("marshal record: %v", err)
			}
			run.Records = append(run.Records, raw)

			switch e := event.(type) {
			case TextEvent:
				said.WriteString(e.Content)
			case WarningEvent:
				run.Warnings = append(run.Warnings, e)
			case ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case DoneEvent:
				run.Said = said.String()
				return run
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for done event")
		}
	}
}
