package codex

import (
	"context"
	"encoding/json"
	"os"
	"testing"

	"github.com/pockode/server/agent"
)

// Forking is what the frontend reads to decide whether to offer the row at all,
// and it travels as a wire field, so this is the declaration the whole feature
// hangs off.
func TestForkSupport(t *testing.T) {
	if got := agent.ForkSupportOf(New()); got != agent.ForkFromAnyMessage {
		t.Errorf("ForkSupportOf(codex) = %q, want %q", got, agent.ForkFromAnyMessage)
	}
}

// forkHistory builds a forked session's history whose records carry the turn ids
// given, in order. An empty id stands for a record no turn is behind (a warning
// Pockode raised itself, or the prompt the user sent), which the anchor search
// must skip.
func forkHistory(t *testing.T, turnIDs ...string) []json.RawMessage {
	t.Helper()
	records := make([]json.RawMessage, 0, len(turnIDs))
	for _, id := range turnIDs {
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
		// sourceState is the source session's codex_resume.json, or nil for a
		// source that never recorded one.
		sourceState *codexResumeState
		// turnIDs are the turn ids the copied history carries. Nil is history
		// from before Pockode recorded them.
		turnIDs []string

		wantCarried bool
		// wantState is the forked session's own state afterwards.
		wantState codexResumeState
	}{
		{
			// The case the whole feature is for: the cut is named by turn, so
			// where the anchor sits in the conversation stops mattering.
			name:        "a cut conversation forks the source's thread at the anchor",
			sourceState: &codexResumeState{ThreadID: "thread-source"},
			turnIDs:     []string{"turn-1", "turn-2"},
			wantCarried: true,
			wantState:   codexResumeState{ThreadID: "thread-source", ForkAtTurnID: "turn-2"},
		},
		{
			name:        "the anchor is the last record that names a turn",
			sourceState: &codexResumeState{ThreadID: "thread-source"},
			// Several records of one turn, then records with no turn behind them
			// at all.
			turnIDs:     []string{"turn-1", "turn-2", "turn-2", "", ""},
			wantCarried: true,
			wantState:   codexResumeState{ThreadID: "thread-source", ForkAtTurnID: "turn-2"},
		},
		{
			// The source is a fork that has not launched yet, so the thread it
			// names is its own source's. This fork's own anchor decides the cut,
			// which is at or before the one the source is waiting on.
			name:        "a fork of an unlaunched fork cuts at its own anchor",
			sourceState: &codexResumeState{ThreadID: "thread-grandparent", ForkAtTurnID: "turn-9"},
			turnIDs:     []string{"turn-1"},
			wantCarried: true,
			wantState:   codexResumeState{ThreadID: "thread-grandparent", ForkAtTurnID: "turn-1"},
		},
		{
			// No turn id means no cut, and an uncut copy would follow the source
			// wherever it has grown to by the time this fork first launches.
			// History from before Pockode recorded turn ids therefore carries
			// nothing, however idle the source looks right now.
			name:        "history with no turn ids carries nothing",
			sourceState: &codexResumeState{ThreadID: "thread-source"},
		},
		{
			name:    "a source that never ran codex carries nothing",
			turnIDs: []string{"turn-1"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dataDir := t.TempDir()
			sourceOpts := agent.StartOptions{DataDir: dataDir, SessionID: "pockode-source"}
			if tt.sourceState != nil {
				writeResumeState(t, sourceOpts, *tt.sourceState)
			}

			history := forkHistory(t, tt.turnIDs...)
			if len(history) == 0 {
				history = []json.RawMessage{json.RawMessage(`{"type":"text"}`)}
			}
			carried, err := New().ForkSession(context.Background(), agent.ForkOptions{
				DataDir:         dataDir,
				SourceSessionID: "pockode-source",
				SessionID:       "pockode-fork",
				History:         history,
			})
			if err != nil {
				t.Fatalf("ForkSession: %v", err)
			}
			if carried != tt.wantCarried {
				t.Fatalf("carried = %v, want %v", carried, tt.wantCarried)
			}

			forkedOpts := agent.StartOptions{DataDir: dataDir, SessionID: "pockode-fork"}
			forked, found := newResumeStateStore(forkedOpts, testLogger()).load()
			if !tt.wantCarried {
				// Nothing recorded is how a fork that carried nothing says its
				// first launch starts a thread of its own.
				if found {
					t.Fatalf("forked resume state = %+v, want none written", forked)
				}
			} else if forked != tt.wantState {
				t.Fatalf("forked resume state = %+v, want %+v", forked, tt.wantState)
			}

			// The fork must not touch the source: its own next launch still
			// opens its own thread.
			if tt.sourceState == nil {
				if _, err := os.Stat(resumeStatePath(dataDir, "pockode-source")); !os.IsNotExist(err) {
					t.Fatalf("fork created resume state for the source, stat err = %v", err)
				}
				return
			}
			if got, _ := newResumeStateStore(sourceOpts, testLogger()).load(); got != *tt.sourceState {
				t.Fatalf("source resume state = %+v, want %+v", got, *tt.sourceState)
			}
		})
	}
}

// writeResumeState puts a whole state on disk, fork intent included — which the
// store's record cannot do, since recording a thread is what retires one.
func writeResumeState(t *testing.T, opts agent.StartOptions, state codexResumeState) {
	t.Helper()
	if err := seedForkIntent(agent.ForkOptions{DataDir: opts.DataDir, SessionID: opts.SessionID}, state); err != nil {
		t.Fatalf("seed resume state: %v", err)
	}
}
