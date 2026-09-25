package work

import (
	"errors"
	"math"
	"testing"

	"github.com/pockode/server/session"
)

// usageStore is a Store that only answers List — all AggregateUsage reads.
type usageStore struct {
	Store
	works   []Work
	listErr error
}

func (s *usageStore) List() ([]Work, error) {
	if s.listErr != nil {
		return nil, s.listErr
	}
	return s.works, nil
}

// usageSource stands in for the worktree manager: recorded session usage, keyed
// by worktree name then session id.
type usageSource struct {
	usages map[string]map[string]session.Usage
	errs   map[string]error
	reads  map[string]int
}

func newUsageSource() *usageSource {
	return &usageSource{
		usages: map[string]map[string]session.Usage{},
		errs:   map[string]error{},
		reads:  map[string]int{},
	}
}

func (s *usageSource) set(worktree, sessionID string, usage session.Usage) *usageSource {
	if s.usages[worktree] == nil {
		s.usages[worktree] = map[string]session.Usage{}
	}
	s.usages[worktree][sessionID] = usage
	return s
}

func (s *usageSource) SessionUsages(worktree string) (map[string]session.Usage, error) {
	s.reads[worktree]++
	if err := s.errs[worktree]; err != nil {
		return nil, err
	}
	return s.usages[worktree], nil
}

func tokens(in, out, cacheRead, cacheWrite int64) session.TokenUsage {
	return session.TokenUsage{
		InputTokens:      in,
		OutputTokens:     out,
		CacheReadTokens:  cacheRead,
		CacheWriteTokens: cacheWrite,
	}
}

func priced(t session.TokenUsage, cost float64) session.Usage {
	return session.Usage{TokenUsage: t, CostUSD: &cost}
}

// costIs compares within a tolerance, both ways round. A subtree's cost is a sum
// of floats and the walk decides the order they are added in, so an exact
// comparison would be a test that passes because of the traversal order.
func costIs(got *float64, want float64) bool {
	return got != nil && math.Abs(*got-want) < 1e-9
}

// A story's total covers its own session and every one of its tasks, and
// nothing belonging to another story.
func TestAggregateUsage_SumsTheStoryAndItsTasks(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "task", StoryID: "story", SessionID: "s-task"},
		{ID: "task-2", StoryID: "story", SessionID: "s-task-2"},
		{ID: "task-3", StoryID: "story", SessionID: "s-task-3"},
		{ID: "unrelated", SessionID: "s-unrelated"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 2, 3, 4), 0.10))
	src.set("", "s-task", priced(tokens(10, 20, 30, 40), 0.20))
	src.set("", "s-task-2", priced(tokens(100, 200, 300, 400), 0.30))
	src.set("", "s-task-3", priced(tokens(1000, 2000, 3000, 4000), 0.40))
	src.set("", "s-unrelated", priced(tokens(9e6, 9e6, 9e6, 9e6), 99))

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Own == nil || usage.Own.TokenUsage != tokens(1, 2, 3, 4) {
		t.Errorf("own = %+v, want the story's own session alone", usage.Own)
	}
	if usage.Total == nil || usage.Total.TokenUsage != tokens(1111, 2222, 3333, 4444) {
		t.Errorf("total = %+v, want the story and every task summed", usage.Total)
	}
	if usage.Total == nil || !costIs(usage.Total.CostUSD, 1.0) {
		t.Errorf("total cost = %v, want 1.0", usage.Total.CostUSD)
	}
	if usage.TaskCount != 3 {
		t.Errorf("task count = %d, want 3", usage.TaskCount)
	}
	if usage.UnpricedSessionCount != 0 {
		t.Errorf("unpriced count = %d, want 0 when every session reported a price", usage.UnpricedSessionCount)
	}

	// One read per worktree, however many work items live in it.
	if src.reads[""] != 1 {
		t.Errorf("read the main worktree %d times, want 1", src.reads[""])
	}
}

// A work item that never started, and one whose session has since been cleaned
// up, are both ordinary states of a plan being filled in: they contribute
// nothing and must not break the aggregation or the count of tasks.
func TestAggregateUsage_SkipsMissingSessions(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "not-started", StoryID: "story"},
		{ID: "session-gone", StoryID: "story", SessionID: "s-deleted"},
		{ID: "counted", StoryID: "story", SessionID: "s-counted"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 1, 1, 1), 0.01))
	src.set("", "s-counted", priced(tokens(2, 2, 2, 2), 0.02))

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || usage.Total.TokenUsage != tokens(3, 3, 3, 3) {
		t.Errorf("total = %+v, want only the two sessions that exist", usage.Total)
	}
	if usage.TaskCount != 3 {
		t.Errorf("task count = %d, want 3 — a task counts whether or not it has a session", usage.TaskCount)
	}
	if usage.UnpricedSessionCount != 0 {
		t.Errorf("unpriced count = %d, want 0 — a missing session is not an unpriced one", usage.UnpricedSessionCount)
	}
}

// The tree a work item runs in is normally one worktree, but a subtree created
// before its parent was pinned can straddle two, and each worktree keeps its own
// session index.
func TestAggregateUsage_ReadsEachWorktree(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "task", StoryID: "story", SessionID: "s-task", Worktree: "feature-x"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 0, 0, 0), 0.01))
	src.set("feature-x", "s-task", priced(tokens(2, 0, 0, 0), 0.02))
	// The same session id in the wrong worktree must not be picked up.
	src.set("", "s-task", priced(tokens(500, 0, 0, 0), 5))

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || usage.Total.InputTokens != 3 {
		t.Errorf("total input = %+v, want 3 — each session read from its own worktree", usage.Total)
	}
}

// Mixing an agent that prices (Claude) with one that never does (Codex) must not
// produce a total that looks complete. The cost is the sum of what was reported,
// and the count of what was not comes with it.
func TestAggregateUsage_CountsUnpricedSessions(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "claude", StoryID: "story", SessionID: "s-claude"},
		{ID: "codex", StoryID: "story", SessionID: "s-codex"},
		{ID: "codex-2", StoryID: "story", SessionID: "s-codex-2"},
		{ID: "idle", StoryID: "story", SessionID: "s-idle"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 0, 0, 0), 1.5))
	src.set("", "s-claude", priced(tokens(1, 0, 0, 0), 2.37))
	src.set("", "s-codex", session.Usage{TokenUsage: tokens(1000, 0, 0, 0)})
	src.set("", "s-codex-2", session.Usage{TokenUsage: tokens(2000, 0, 0, 0)})
	// Spent nothing, so there is nothing missing from the cost either.
	src.set("", "s-idle", session.Usage{})

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || !costIs(usage.Total.CostUSD, 3.87) {
		t.Errorf("total cost = %v, want the 3.87 that was actually reported", usage.Total.CostUSD)
	}
	if usage.UnpricedSessionCount != 2 {
		t.Errorf("unpriced count = %d, want 2 (both Codex sessions)", usage.UnpricedSessionCount)
	}
	if usage.Total.InputTokens != 3002 {
		t.Errorf("total input = %d, want 3002 — unpriced sessions still spent tokens", usage.Total.InputTokens)
	}
}

// "The agent reported no cost" and "the cost was zero" are different facts, and
// only the second may be displayed as a number. A whole subtree of Codex work
// has no cost at all.
func TestAggregateUsage_NoCostAnywhereLeavesItAbsent(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "task", StoryID: "story", SessionID: "s-task"},
	}}
	src := newUsageSource()
	src.set("", "s-story", session.Usage{TokenUsage: tokens(5, 0, 0, 0)})
	src.set("", "s-task", session.Usage{TokenUsage: tokens(7, 0, 0, 0)})

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Own == nil || usage.Own.CostUSD != nil {
		t.Errorf("own cost = %v, want absent", usage.Own)
	}
	if usage.Total == nil || usage.Total.CostUSD != nil {
		t.Errorf("total cost = %v, want absent", usage.Total)
	}
	if usage.UnpricedSessionCount != 2 {
		t.Errorf("unpriced count = %d, want 2", usage.UnpricedSessionCount)
	}
}

// A parent that delegated all the work has spent nothing itself. Its own share
// is absent — displayed as "not reported", never as a zero it did not report —
// while the total still stands.
func TestAggregateUsage_OwnAbsentWhenParentSpentNothing(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story"},
		{ID: "task", StoryID: "story", SessionID: "s-task"},
	}}
	src := newUsageSource()
	src.set("", "s-task", priced(tokens(9, 0, 0, 0), 0.05))

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Own != nil {
		t.Errorf("own = %+v, want absent for a story with no session of its own", usage.Own)
	}
	if usage.Total == nil || usage.Total.InputTokens != 9 {
		t.Errorf("total = %+v, want the child's 9", usage.Total)
	}
}

// Nothing spent anywhere is what a freshly created story looks like, and it is
// the condition the client hides the whole card on. It is not an error, and the
// task count is still the truth about the tree's shape.
func TestAggregateUsage_NothingReported(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story"},
		{ID: "task", StoryID: "story"},
	}}

	usage, err := AggregateUsage(store, newUsageSource(), store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Own != nil || usage.Total != nil {
		t.Errorf("usage = %+v, want both shares absent", usage)
	}
	if usage.TaskCount != 1 {
		t.Errorf("task count = %d, want 1", usage.TaskCount)
	}
}

// A fork's own usage starts at zero on purpose (the tokens behind its copied
// history were spent by the source session), and aggregation must not try to
// make up the difference: the source is very often somewhere in the same tree,
// so "restoring" it would double-count.
func TestAggregateUsage_ForkedSessionCountsOnlyItsOwn(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story"},
		{ID: "source", StoryID: "story", SessionID: "s-source"},
		{ID: "forked", StoryID: "story", SessionID: "s-forked"},
	}}
	src := newUsageSource()
	src.set("", "s-source", priced(tokens(100, 0, 0, 0), 1))
	src.set("", "s-forked", priced(tokens(3, 0, 0, 0), 0.03))

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || usage.Total.InputTokens != 103 {
		t.Errorf("total input = %+v, want 103 — the fork contributes only what it spent itself", usage.Total)
	}
}

// A task's total is its own and nothing else — it holds no tasks, which is what
// makes the aggregation one query rather than a walk.
func TestAggregateUsage_TaskCountsOnlyItself(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "task", StoryID: "story", SessionID: "s-task"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 0, 0, 0), 0.01))
	src.set("", "s-task", priced(tokens(2, 0, 0, 0), 0.02))

	usage, err := AggregateUsage(store, src, store.works[1])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || usage.Total.InputTokens != 2 {
		t.Errorf("total input = %+v, want the task's own 2", usage.Total)
	}
	if usage.TaskCount != 0 {
		t.Errorf("task count = %d, want 0", usage.TaskCount)
	}
}

// A worktree whose session index cannot be read costs the total its share, and
// says so in the log. Failing instead would take the whole work detail
// subscription — comments, steps, everything — down with it.
func TestAggregateUsage_UnreadableWorktreeDegrades(t *testing.T) {
	store := &usageStore{works: []Work{
		{ID: "story", SessionID: "s-story"},
		{ID: "task", StoryID: "story", SessionID: "s-task", Worktree: "broken"},
		{ID: "task-2", StoryID: "story", SessionID: "s-task-2", Worktree: "broken"},
	}}
	src := newUsageSource()
	src.set("", "s-story", priced(tokens(1, 0, 0, 0), 0.01))
	src.errs["broken"] = errors.New("index is not json")

	usage, err := AggregateUsage(store, src, store.works[0])
	if err != nil {
		t.Fatalf("AggregateUsage: %v", err)
	}

	if usage.Total == nil || usage.Total.InputTokens != 1 {
		t.Errorf("total input = %+v, want the readable worktree's 1", usage.Total)
	}
	// The failure is not retried per work item: one read, one log line.
	if src.reads["broken"] != 1 {
		t.Errorf("read the broken worktree %d times, want 1", src.reads["broken"])
	}
}

// A store that cannot list work items is a different matter: the tree's shape is
// unknown, so every number would be a guess.
func TestAggregateUsage_ReturnsStoreError(t *testing.T) {
	store := &usageStore{listErr: errors.New("index is not json")}

	if _, err := AggregateUsage(store, newUsageSource(), Work{ID: "story"}); err == nil {
		t.Fatal("expected an error when the work list cannot be read")
	}
}

// Equal decides whether a session change is worth a notification carrying the
// work item and its whole comment list, so it has to compare what the numbers
// are and not where they are stored.
func TestUsageEqual(t *testing.T) {
	totals := func(in int64, cost *float64) *UsageTotals {
		return &UsageTotals{TokenUsage: tokens(in, 0, 0, 0), CostUSD: cost}
	}
	cost := func(v float64) *float64 { return &v }

	tests := []struct {
		name  string
		a, b  Usage
		equal bool
	}{
		{
			name:  "same numbers in different allocations",
			a:     Usage{Own: totals(1, cost(0.5)), Total: totals(2, cost(0.5)), TaskCount: 1},
			b:     Usage{Own: totals(1, cost(0.5)), Total: totals(2, cost(0.5)), TaskCount: 1},
			equal: true,
		},
		{
			name: "a token count moved",
			a:    Usage{Total: totals(2, nil)},
			b:    Usage{Total: totals(3, nil)},
		},
		{
			name: "a cost appeared",
			a:    Usage{Total: totals(2, nil)},
			b:    Usage{Total: totals(2, cost(0))},
		},
		{
			name: "a scope appeared",
			a:    Usage{Total: totals(2, nil)},
			b:    Usage{Own: totals(2, nil), Total: totals(2, nil)},
		},
		{
			name: "a child was added",
			a:    Usage{Total: totals(2, nil), TaskCount: 1},
			b:    Usage{Total: totals(2, nil), TaskCount: 2},
		},
		{
			name: "a session stopped being priced",
			a:    Usage{Total: totals(2, cost(1)), UnpricedSessionCount: 0},
			b:    Usage{Total: totals(2, cost(1)), UnpricedSessionCount: 1},
		},
		{
			name:  "nothing reported, both ways",
			equal: true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.a.Equal(tc.b); got != tc.equal {
				t.Errorf("a.Equal(b) = %v, want %v", got, tc.equal)
			}
			if got := tc.b.Equal(tc.a); got != tc.equal {
				t.Errorf("b.Equal(a) = %v, want %v", got, tc.equal)
			}
		})
	}
}
