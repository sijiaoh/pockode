package claude

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/pockode/server/agent"
)

// forkHistory builds a forked session's history where the records carry the CLI
// message ids given, in order. An empty id stands for a record the CLI never put
// an id on (a warning Pockode raised itself), which the anchor search must skip.
func forkHistory(t *testing.T, messageIDs ...string) []json.RawMessage {
	t.Helper()
	records := make([]json.RawMessage, 0, len(messageIDs))
	for _, id := range messageIDs {
		raw, err := json.Marshal(agent.EventRecord{
			Type:              agent.EventTypeText,
			Content:           "hi",
			ProviderMessageID: id,
		})
		if err != nil {
			t.Fatalf("marshal record: %v", err)
		}
		records = append(records, raw)
	}
	return records
}

func TestForkSession(t *testing.T) {
	tests := []struct {
		name string
		// sourceState is the source session's claude_resume.json, or nil for a
		// source that never recorded one.
		sourceState *claudeResumeState
		// messageIDs are the CLI message ids the copied history carries. Nil is
		// history from before Pockode recorded them.
		messageIDs []string

		wantCarried bool
		wantState   claudeResumeState
		// wantLaunch is how the forked session's first launch must open.
		wantLaunch claudeLaunch
	}{
		{
			// The case the whole feature is for: the cut is named by message, so
			// where the anchor sits in the conversation stops mattering.
			name:        "a cut conversation resumes the source and stops at the anchor",
			sourceState: &claudeResumeState{SessionID: "claude-source"},
			messageIDs:  []string{"msg-1", "msg-2"},
			wantCarried: true,
			wantState:   claudeResumeState{SessionID: "claude-source", Recovery: recoveryFork, ResumeAt: "msg-2"},
			wantLaunch:  claudeLaunch{sessionID: "claude-source", resume: true, fork: true, resumeAt: "msg-2"},
		},
		{
			name:        "the anchor is the last record that names a message",
			sourceState: &claudeResumeState{SessionID: "claude-source"},
			// Two records of one assistant message, then a record with no message
			// behind it at all.
			messageIDs:  []string{"msg-1", "msg-2", "msg-2", ""},
			wantCarried: true,
			wantState:   claudeResumeState{SessionID: "claude-source", Recovery: recoveryFork, ResumeAt: "msg-2"},
			wantLaunch:  claudeLaunch{sessionID: "claude-source", resume: true, fork: true, resumeAt: "msg-2"},
		},
		{
			name: "a source waiting to be forked itself is still resumable",
			// The source's own next launch forks too; both replay the same
			// conversation into IDs of their own, so neither claims it.
			sourceState: &claudeResumeState{SessionID: "claude-source", Recovery: recoveryFork},
			messageIDs:  []string{"msg-1"},
			wantCarried: true,
			wantState:   claudeResumeState{SessionID: "claude-source", Recovery: recoveryFork, ResumeAt: "msg-1"},
			wantLaunch:  claudeLaunch{sessionID: "claude-source", resume: true, fork: true, resumeAt: "msg-1"},
		},
		{
			// The source is a fork that has not launched yet, so the session it
			// names is its own source's. This fork's own anchor decides the cut,
			// which is at or before the one the source is waiting on.
			name:        "a fork of an unlaunched fork cuts at its own anchor",
			sourceState: &claudeResumeState{SessionID: "claude-grandparent", Recovery: recoveryFork, ResumeAt: "msg-9"},
			messageIDs:  []string{"msg-1"},
			wantCarried: true,
			wantState:   claudeResumeState{SessionID: "claude-grandparent", Recovery: recoveryFork, ResumeAt: "msg-1"},
			wantLaunch:  claudeLaunch{sessionID: "claude-grandparent", resume: true, fork: true, resumeAt: "msg-1"},
		},
		{
			// No uuid means no cut, and an uncut replay would follow the source
			// wherever it has grown to by the time this fork first launches.
			// History from before Pockode recorded the CLI's uuids therefore
			// carries nothing, however idle the source looks right now.
			name:        "history with no message ids carries nothing",
			sourceState: &claudeResumeState{SessionID: "claude-source"},
			wantState:   claudeResumeState{Unstarted: true},
			wantLaunch:  claudeLaunch{sessionID: "pockode-fork"},
		},
		{
			name:       "a source that never ran claude carries nothing",
			messageIDs: []string{"msg-1"},
			wantState:  claudeResumeState{Unstarted: true},
			wantLaunch: claudeLaunch{sessionID: "pockode-fork"},
		},
		{
			name:        "a source whose provider session gave up carries nothing",
			sourceState: &claudeResumeState{SessionID: "claude-source", Recovery: recoveryFresh},
			messageIDs:  []string{"msg-1"},
			wantState:   claudeResumeState{Unstarted: true},
			wantLaunch:  claudeLaunch{sessionID: "pockode-fork"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dataDir := t.TempDir()
			source := forkTestManager(t, dataDir, "pockode-source")
			if tt.sourceState != nil {
				writeResumeState(t, source, *tt.sourceState)
			}

			history := forkHistory(t, tt.messageIDs...)
			if len(history) == 0 {
				history = []json.RawMessage{json.RawMessage(`{"type":"text"}`)}
			}
			opts := agent.ForkOptions{
				DataDir:         dataDir,
				SourceSessionID: "pockode-source",
				SessionID:       "pockode-fork",
				History:         history,
			}
			carried, err := New().ForkSession(context.Background(), opts)
			if err != nil {
				t.Fatalf("ForkSession: %v", err)
			}
			if carried != tt.wantCarried {
				t.Fatalf("carried = %v, want %v", carried, tt.wantCarried)
			}

			// Resume mirrors activation, which a session born holding a
			// transcript has, so this manager is the one the user's first
			// message in the fork actually launches through.
			forked := forkTestManager(t, dataDir, "pockode-fork")
			forked.opts.Resume = true

			if got := readResumeState(t, forked); got != tt.wantState {
				t.Fatalf("forked resume state = %+v, want %+v", got, tt.wantState)
			}
			if got := forked.resolve(); got != tt.wantLaunch {
				t.Fatalf("forked launch = %+v, want %+v", got, tt.wantLaunch)
			}
			if _, warned := forked.pendingWarning(); warned {
				t.Fatal("a forked session's first launch must not warn about a lost conversation")
			}

			// The fork must not touch the source: its own next launch still
			// opens its own provider session.
			if tt.sourceState == nil {
				if _, err := os.Stat(source.path()); !os.IsNotExist(err) {
					t.Fatalf("fork created resume state for the source, stat err = %v", err)
				}
				return
			}
			if got := readResumeState(t, source); got != *tt.sourceState {
				t.Fatalf("source resume state = %+v, want %+v", got, *tt.sourceState)
			}
		})
	}
}

// A record that does not parse cannot be the anchor, but it must not stop the
// search either: history is written by a version of Pockode that may not be this
// one, and giving up on the first bad line would cost the whole conversation.
func TestForkAnchorMessageSkipsUnreadableRecords(t *testing.T) {
	history := append(forkHistory(t, "msg-1"), json.RawMessage(`{`))
	if got := forkAnchorMessage(history); got != "msg-1" {
		t.Fatalf("anchor = %q, want msg-1", got)
	}
}

func forkTestManager(t *testing.T, dataDir, sessionID string) *claudeResumeStateManager {
	t.Helper()
	return newClaudeResumeStateManager(agent.StartOptions{
		DataDir:   dataDir,
		SessionID: sessionID,
	}, testLogger())
}
