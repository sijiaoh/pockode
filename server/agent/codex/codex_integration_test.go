//go:build integration

package codex

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// TestIntegration_ResumesAcrossProcesses is the check behind the whole change.
// The MCP channel this package used to speak kept a thread in the memory of the
// process that created it, so every restart started the agent over with no
// memory of the transcript the user was looking at. This proves the app-server
// channel does not: a second process, given nothing but the recorded thread id,
// answers a question only the first process was told the answer to.
func TestIntegration_ResumesAcrossProcesses(t *testing.T) {
	workDir := t.TempDir()
	dataDir := t.TempDir()
	sessionID := uuid.Must(uuid.NewV7()).String()

	runPrompt(t, workDir, dataDir, sessionID, false,
		"Remember this code word: BANANA-42. Reply with exactly: ok")

	state, found := newResumeStateStore(
		agent.StartOptions{DataDir: dataDir, SessionID: sessionID}, testLogger()).load()
	if !found || state.ThreadID == "" {
		t.Fatalf("no thread recorded after the first turn: %+v", state)
	}

	// A brand new process, resuming only from what was written to disk.
	said := runPrompt(t, workDir, dataDir, sessionID, true,
		"What was the code word I gave you? Reply with just the word, or UNKNOWN if you were never given one.")
	if !strings.Contains(said, "BANANA-42") {
		t.Fatalf("the resumed session does not remember the code word, it said: %q", said)
	}

	// Resuming keeps the thread, so the recorded id must not churn — a new one
	// each time would mean each process was starting over.
	after, _ := newResumeStateStore(
		agent.StartOptions{DataDir: dataDir, SessionID: sessionID}, testLogger()).load()
	if after.ThreadID != state.ThreadID {
		t.Errorf("thread id changed across the resume: %q -> %q", state.ThreadID, after.ThreadID)
	}
}

// TestIntegration_UnresumableThreadDegrades checks the other half: a recorded
// thread whose rollout is gone must not make the session permanently unusable.
// It has to start a new thread, tell the user the earlier messages are no longer
// in the agent's memory, and stop naming the dead id.
func TestIntegration_UnresumableThreadDegrades(t *testing.T) {
	workDir := t.TempDir()
	dataDir := t.TempDir()
	sessionID := uuid.Must(uuid.NewV7()).String()

	// A well-formed thread id no rollout was ever written for.
	dead := uuid.Must(uuid.NewV7()).String()
	newResumeStateStore(agent.StartOptions{DataDir: dataDir, SessionID: sessionID}, testLogger()).record(dead)

	warnings := runPromptCollectingWarnings(t, workDir, dataDir, sessionID, true, "Reply with exactly: ok")

	var warned bool
	for _, w := range warnings {
		if w.Code == "session_not_resumable" {
			warned = true
		}
	}
	if !warned {
		t.Errorf("the user was not told the conversation could not be reopened; warnings: %+v", warnings)
	}

	state, _ := newResumeStateStore(agent.StartOptions{DataDir: dataDir, SessionID: sessionID}, testLogger()).load()
	if state.ThreadID == dead || state.ThreadID == "" {
		t.Errorf("thread id = %q, want the replacement thread rather than the dead id", state.ThreadID)
	}
}

// TestIntegration_ForksAtATurn is stage two's own check, and it is the probe's
// experiment run through Pockode rather than against the CLI directly: a fork
// taken before the second code word was given must remember the first and not
// the second, while the session it was forked from remembers both.
//
// It is what proves the two halves meet — the turn ids stamped on events are
// the ones `thread/fork` accepts as `lastTurnId` — which no unit test can, since
// both halves are Pockode's own and would agree with each other on any value.
func TestIntegration_ForksAtATurn(t *testing.T) {
	workDir := t.TempDir()
	dataDir := t.TempDir()
	sourceID := uuid.Must(uuid.NewV7()).String()

	// The fork point: everything the agent said up to here is what the forked
	// session keeps, and chat.Client.Fork would have cut the prompt that follows.
	kept := runPromptCollecting(t, workDir, dataDir, sourceID, false,
		"Remember this code word: APPLE-1. Reply with exactly: ok").records
	runPrompt(t, workDir, dataDir, sourceID, true,
		"Here is a second code word: ZEBRA-7. Reply with exactly: ok")

	forkID := uuid.Must(uuid.NewV7()).String()
	carried, err := New().ForkSession(context.Background(), agent.ForkOptions{
		WorkDir:         workDir,
		DataDir:         dataDir,
		SourceSessionID: sourceID,
		SessionID:       forkID,
		History:         kept,
	})
	if err != nil {
		t.Fatalf("ForkSession failed: %v", err)
	}
	if !carried {
		t.Fatal("the fork carried no context, though the kept history was recorded with turn ids")
	}

	const question = "List every code word you have been given, separated by spaces. Reply with just the words, or NONE if you were never given any."

	said := runPrompt(t, workDir, dataDir, forkID, true, question)
	if !strings.Contains(said, "APPLE-1") {
		t.Errorf("the fork does not remember the turn it was taken at, it said: %q", said)
	}
	if strings.Contains(said, "ZEBRA-7") {
		t.Errorf("the fork remembers a turn taken after the fork point, it said: %q", said)
	}

	// The source is untouched by all of it.
	said = runPrompt(t, workDir, dataDir, sourceID, true, question)
	if !strings.Contains(said, "APPLE-1") || !strings.Contains(said, "ZEBRA-7") {
		t.Errorf("the source lost part of its own conversation, it said: %q", said)
	}

	sourceState, _ := newResumeStateStore(
		agent.StartOptions{DataDir: dataDir, SessionID: sourceID}, testLogger()).load()
	forkState, _ := newResumeStateStore(
		agent.StartOptions{DataDir: dataDir, SessionID: forkID}, testLogger()).load()
	if forkState.ThreadID == "" || forkState.ThreadID == sourceState.ThreadID {
		t.Errorf("fork thread = %q, source thread = %q; want the fork on a thread of its own",
			forkState.ThreadID, sourceState.ThreadID)
	}
	// Spent at the first launch: a second one resumes the forked thread rather
	// than forking the source over again.
	if forkState.ForkAtTurnID != "" {
		t.Errorf("fork intent = %q, want it retired once the fork was taken", forkState.ForkAtTurnID)
	}
}

// promptRun is what one turn through a real CLI process produced.
type promptRun struct {
	said     string
	warnings []agent.WarningEvent
	// records are the turn's events as history stores them — the form a fork
	// reads to find the turn it was taken at.
	records []json.RawMessage
}

// runPrompt drives one complete message through a real CLI process and returns
// everything the agent said.
func runPrompt(t *testing.T, workDir, dataDir, sessionID string, resume bool, prompt string) string {
	t.Helper()
	return runPromptCollecting(t, workDir, dataDir, sessionID, resume, prompt).said
}

func runPromptCollectingWarnings(t *testing.T, workDir, dataDir, sessionID string, resume bool, prompt string) []agent.WarningEvent {
	t.Helper()
	return runPromptCollecting(t, workDir, dataDir, sessionID, resume, prompt).warnings
}

func runPromptCollecting(t *testing.T, workDir, dataDir, sessionID string, resume bool, prompt string) promptRun {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	sess, err := New().Start(ctx, agent.StartOptions{
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

	if err := sess.SendMessage(prompt); err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	var said strings.Builder
	run := promptRun{}
	for {
		select {
		case event, ok := <-sess.Events():
			if !ok {
				t.Fatal("channel closed before done event")
			}
			raw, err := json.Marshal(event.ToRecord())
			if err != nil {
				t.Fatalf("marshal record: %v", err)
			}
			run.records = append(run.records, raw)

			switch e := event.(type) {
			case agent.TextEvent:
				said.WriteString(e.Content)
			case agent.WarningEvent:
				run.warnings = append(run.warnings, e)
			case agent.ErrorEvent:
				t.Fatalf("error event: %s", e.Error)
			case agent.DoneEvent:
				run.said = said.String()
				return run
			}
		case <-ctx.Done():
			t.Fatal("timeout waiting for done event")
		}
	}
}
