package work

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// activityCase is one row of testdata/activity_cases.json. The client's own
// activity test reads the same file, which is what makes the rule single even
// though it is evaluated on both sides of the wire.
type activityCase struct {
	Name string `json:"name"`
	Work struct {
		Status WorkStatus `json:"status"`
		Wait   WorkWait   `json:"wait"`
	} `json:"work"`
	Turn *struct {
		Phase    session.TurnPhase     `json:"phase"`
		Blockers []session.BlockerKind `json:"blockers"`
	} `json:"turn"`
	Want Activity `json:"want"`
}

func loadActivityCases(t *testing.T) []activityCase {
	t.Helper()

	data, err := os.ReadFile("testdata/activity_cases.json")
	if err != nil {
		t.Fatalf("read activity cases: %v", err)
	}
	var file struct {
		Cases []activityCase `json:"cases"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("parse activity cases: %v", err)
	}
	if len(file.Cases) == 0 {
		t.Fatal("no activity cases; the shared table is what both sides are checked against")
	}
	return file.Cases
}

func TestDeriveActivity(t *testing.T) {
	for _, tc := range loadActivityCases(t) {
		t.Run(tc.Name, func(t *testing.T) {
			var turn session.TurnState
			if tc.Turn != nil {
				turn.Phase = tc.Turn.Phase
				for _, kind := range tc.Turn.Blockers {
					turn.Blockers = append(turn.Blockers, session.Blocker{Kind: kind, RaisedAt: time.Unix(1, 0)})
				}
			}

			got := DeriveActivity(Work{Status: tc.Work.Status, Wait: tc.Work.Wait}, turn)
			if got != tc.Want {
				t.Errorf("activity = %q, want %q", got, tc.Want)
			}
		})
	}
}

// The attention dot's whole definition. It is deliberately narrower than "not
// idle": a dot that also means "something is happening" is a dot users learn to
// ignore, and that habit is what made the old needs-input dot worthless.
func TestNeedsUserIsTheThreeLeavesTheUserCanActOn(t *testing.T) {
	want := map[Activity]bool{
		ActivityNeedsAnswer:     true,
		ActivityNeedsPermission: true,
		ActivityNeedsMessage:    true,
		ActivityOpen:            false,
		ActivityRunning:         false,
		ActivityBackground:      false,
		ActivityWaitingChildren: false,
		ActivityIdle:            false,
		ActivityStopped:         false,
		ActivityClosed:          false,
	}
	for activity, needs := range want {
		if got := activity.NeedsUser(); got != needs {
			t.Errorf("%q.NeedsUser() = %v, want %v", activity, got, needs)
		}
	}
}

type fakeTurnSource struct {
	turns map[string]map[string]session.TurnState
	err   error
	calls int
}

func (f *fakeTurnSource) SessionTurns(worktree string) (map[string]session.TurnState, error) {
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	return f.turns[worktree], nil
}

// One read per worktree per batch, not one per row: a project's work list is
// mostly one worktree, and the unloaded ones are answered by reading a file.
func TestActivityResolverReadsEachWorktreeOnce(t *testing.T) {
	source := &fakeTurnSource{turns: map[string]map[string]session.TurnState{
		"": {"s1": {Phase: session.PhaseRunning}},
		"feature": {"s2": {Phase: session.PhaseBlocked, Blockers: []session.Blocker{
			{Kind: session.BlockerQuestion, RequestID: "req-1"},
		}}},
	}}
	resolver := NewActivityResolver(source)

	works := []Work{
		{ID: "w1", Status: StatusActive, SessionID: "s1"},
		{ID: "w2", Status: StatusActive, SessionID: "unknown"},
		{ID: "w3", Status: StatusActive, SessionID: "s2", Worktree: "feature"},
	}
	want := []Activity{ActivityRunning, ActivityIdle, ActivityNeedsAnswer}

	for i, w := range works {
		if got := resolver.Activity(w); got != want[i] {
			t.Errorf("%s activity = %q, want %q", w.ID, got, want[i])
		}
	}
	if source.calls != 2 {
		t.Errorf("read the turn source %d times, want one read per worktree (2)", source.calls)
	}
}

// A worktree that cannot be read must not blank a row: the work's own status
// still says whether the engine is driving it.
func TestActivityResolverSurvivesAnUnreadableWorktree(t *testing.T) {
	resolver := NewActivityResolver(&fakeTurnSource{err: errors.New("index is not json")})

	if got := resolver.Activity(Work{Status: StatusActive, SessionID: "s1"}); got != ActivityIdle {
		t.Errorf("activity = %q, want %q", got, ActivityIdle)
	}
	if got := resolver.Activity(Work{Status: StatusStopped, SessionID: "s1"}); got != ActivityStopped {
		t.Errorf("activity = %q, want %q", got, ActivityStopped)
	}
}
