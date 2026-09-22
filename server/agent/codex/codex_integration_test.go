//go:build integration

package codex

import (
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/pockode/server/agent"
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

	agent.RunPrompt(t, New(), workDir, dataDir, sessionID, false,
		"Remember this code word: BANANA-42. Reply with exactly: ok")

	state, found := newResumeStateStore(
		agent.StartOptions{DataDir: dataDir, SessionID: sessionID}, testLogger()).load()
	if !found || state.ThreadID == "" {
		t.Fatalf("no thread recorded after the first turn: %+v", state)
	}

	// A brand new process, resuming only from what was written to disk.
	said := agent.RunPrompt(t, New(), workDir, dataDir, sessionID, true,
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

	warnings := agent.RunPromptCollecting(t, New(), workDir, dataDir, sessionID, true, "Reply with exactly: ok").Warnings

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

// checkForkedSessions is Codex's half of the shared fork scenario: which thread
// each session came out on, which the suite cannot ask about because only this
// package knows a conversation is an app-server thread.
//
// It is also what proves the two halves of a Codex fork meet — the turn ids
// stamped on events are the ones `thread/fork` accepts as `lastTurnId` — which
// no unit test can, since both halves are Pockode's own and would agree with
// each other on any value.
func checkForkedSessions(t *testing.T, check agent.ForkCheck) {
	sourceState, _ := newResumeStateStore(
		agent.StartOptions{DataDir: check.DataDir, SessionID: check.SourceSessionID}, testLogger()).load()
	forkState, _ := newResumeStateStore(
		agent.StartOptions{DataDir: check.DataDir, SessionID: check.ForkSessionID}, testLogger()).load()

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
