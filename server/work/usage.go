package work

import (
	"log/slog"

	"github.com/pockode/server/session"
)

// Usage is what a work item has consumed: its own session's share, and the share
// of its tasks as well.
//
// It belongs to a work item's *detail*, never to Work itself. Work is the record
// the store holds; this is derived at read time by reading every session the
// work and its tasks ran, which the store knows nothing about. A field here
// would put that read behind every reader of a Work — Store.List above all,
// which AggregateUsage itself calls to find the tasks.
//
// No context window here, at any level: a window is a property of one live
// conversation, and there is no meaning to the sum of several.
type Usage struct {
	// Own is the work's own session's consumption, absent when there is nothing
	// to show for it: no session, a session that was deleted, or one whose agent
	// never reported a token. Absent means "not reported" and is displayed as
	// such; it is deliberately not a zero, which would claim the agent reported
	// one.
	Own *UsageTotals `json:"own,omitempty"`

	// Total is Own plus every task's. Absent under the same condition as Own,
	// applied to the story and its tasks together. On a task it equals Own: a
	// task holds no tasks.
	Total *UsageTotals `json:"total,omitempty"`

	// TaskCount is how many tasks this story holds, and 0 on a task. It was
	// `descendant_count` while the shape was a tree of any depth; with one level
	// below a story there are no descendants to count that are not tasks, and a
	// name promising depth invites reading it as one.
	//
	// Always sent: usage is not on Work, so a client holds no consumption figure
	// for any work item but the one it has open and cannot aggregate the tasks
	// itself. Whether there are any is also what decides whether a total is
	// worth showing at all — a question that must not be answered by comparing
	// Total against Own, which would make a column appear the moment a task's
	// first turn lands.
	TaskCount int `json:"task_count"`

	// UnpricedSessionCount is how many of the sessions the total covers (this
	// work's own included) spent tokens while their agent reported no price.
	// Without it a story mixing Claude (which prices) and Codex (which never
	// does) would report a total that looks complete and is not.
	UnpricedSessionCount int `json:"unpriced_session_count,omitempty"`
}

// Equal compares two aggregations by value, following the pointers rather than
// comparing them — two Usages holding the same numbers in different allocations
// are the same usage (session.Usage.equal exists for the same reason). It is what
// lets a watcher tell "this session change moved the numbers" from "it did not".
func (u Usage) Equal(o Usage) bool {
	return u.TaskCount == o.TaskCount &&
		u.UnpricedSessionCount == o.UnpricedSessionCount &&
		u.Own.equal(o.Own) &&
		u.Total.equal(o.Total)
}

func (t *UsageTotals) equal(o *UsageTotals) bool {
	switch {
	case t == nil && o == nil:
		return true
	case t == nil || o == nil:
		return false
	}
	if t.TokenUsage != o.TokenUsage {
		return false
	}
	switch {
	case t.CostUSD == nil && o.CostUSD == nil:
		return true
	case t.CostUSD == nil || o.CostUSD == nil:
		return false
	default:
		return *t.CostUSD == *o.CostUSD
	}
}

// UsageTotals is consumption at one scope — one session, or a story and its
// tasks together.
// The four counters are session.TokenUsage's, so a work total and a session
// total are the same units added the same way.
//
// No total_tokens field: the sum of the four is derived by whoever displays it
// (session.TokenUsage.Total does it here), rather than shipped as a third copy
// of the same fact.
type UsageTotals struct {
	session.TokenUsage

	// CostUSD is absent when no session in scope reported a cost, and is the sum
	// of those that did otherwise — see UnpricedSessionCount for how many were
	// left out of it.
	CostUSD *float64 `json:"cost_usd,omitempty"`
}

// SessionUsageSource resolves recorded session consumption per worktree.
// Implemented by worktree.Manager.
type SessionUsageSource interface {
	// SessionUsages returns what every session in the named worktree has
	// consumed, keyed by session id; "" names the main one. A worktree with no
	// sessions yet returns an empty map and no error.
	SessionUsages(worktree string) (map[string]session.Usage, error)
}

// AggregateUsage adds up what root and its tasks consumed.
//
// It only reads what the sessions already recorded; nothing here re-counts
// tokens. Sessions that are missing — a work that never started, or one whose
// session has since been cleaned up — contribute nothing rather than failing the
// aggregation, which is the normal state of a story the user is still filling
// in.
//
// It used to be a walk with a seen set, guarding against a parent chain that
// pointed back into itself. There is no chain left to loop: a task's tasks are
// the empty set, so root plus TasksOf(root) is the whole of it.
func AggregateUsage(store Store, src SessionUsageSource, root Work) (Usage, error) {
	works, err := store.List()
	if err != nil {
		return Usage{}, err
	}

	lookup := newUsageLookup(src)

	var own, total session.TokenUsage
	var ownCost, totalCost *float64
	unpriced := 0

	tasks := TasksOf(works, root.ID)
	for _, node := range append([]Work{root}, tasks...) {
		usage, found := lookup.get(node.Worktree, node.SessionID)
		if !found {
			continue
		}
		total = total.Add(usage.TokenUsage)
		totalCost = addCost(totalCost, usage.CostUSD)
		if node.ID == root.ID {
			own = own.Add(usage.TokenUsage)
			ownCost = addCost(ownCost, usage.CostUSD)
		}
		if !usage.TokenUsage.IsZero() && usage.CostUSD == nil {
			unpriced++
		}
	}

	return Usage{
		Own:                  newTotals(own, ownCost),
		Total:                newTotals(total, totalCost),
		TaskCount:            len(tasks),
		UnpricedSessionCount: unpriced,
	}, nil
}

// newTotals drops a scope that has nothing to report. A cost without tokens
// still counts as something to report: the money was spent either way.
func newTotals(tokens session.TokenUsage, cost *float64) *UsageTotals {
	if tokens.IsZero() && cost == nil {
		return nil
	}
	return &UsageTotals{TokenUsage: tokens, CostUSD: cost}
}

// addCost sums costs while keeping "nobody reported a cost" distinct from "the
// cost was zero" — the first is what a Codex-only story looks like, and
// displaying it as $0.00 would be a claim the agent never made.
func addCost(sum *float64, add *float64) *float64 {
	if add == nil {
		return sum
	}
	total := *add
	if sum != nil {
		total += *sum
	}
	return &total
}

// usageLookup reads each worktree's sessions once per aggregation. Per call
// rather than cached across calls: the numbers change while the user watches
// them, and a cache would answer with the ones from the last page load.
type usageLookup struct {
	src        SessionUsageSource
	byWorktree map[string]map[string]session.Usage
}

func newUsageLookup(src SessionUsageSource) *usageLookup {
	return &usageLookup{src: src, byWorktree: make(map[string]map[string]session.Usage)}
}

func (l *usageLookup) get(worktree, sessionID string) (session.Usage, bool) {
	if sessionID == "" {
		return session.Usage{}, false
	}

	usages, loaded := l.byWorktree[worktree]
	if !loaded {
		var err error
		usages, err = l.src.SessionUsages(worktree)
		if err != nil {
			// A worktree we cannot read costs us its share of the total, which is
			// worth logging and not worth failing a work detail subscription over:
			// the rest of the page is fine, and an unreadable session index is
			// already reported where it is read.
			slog.Warn("failed to read session usage for work aggregation",
				"worktree", worktree, "error", err)
			usages = nil
		}
		if usages == nil {
			usages = map[string]session.Usage{}
		}
		l.byWorktree[worktree] = usages
	}

	usage, found := usages[sessionID]
	return usage, found
}
