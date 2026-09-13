package work

import (
	"log/slog"

	"github.com/pockode/server/session"
)

// Usage is what a work item has consumed: its own session's share, and the share
// of the whole subtree beneath it.
//
// It belongs to a work item's *detail*, never to Work itself. Work is the one
// shape the list and the detail share, so a field added there would make every
// row of the work list carry a subtree aggregation — which is both the expensive
// thing and the thing nobody asked for.
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

	// Total is Own plus every descendant's, at every depth. Absent under the same
	// condition as Own, applied to the whole subtree.
	Total *UsageTotals `json:"total,omitempty"`

	// DescendantCount is how many work items sit beneath this one, at every
	// depth. Always sent: usage is not on Work, so a client holds no consumption
	// figure for any work item but the one it has open and cannot aggregate the
	// subtree itself. Whether the subtree has anything in it is also what decides
	// whether a total is worth showing at all — a question that must not be
	// answered by comparing Total against Own, which would make a column appear
	// the moment a child's first turn lands.
	DescendantCount int `json:"descendant_count"`

	// UnpricedSessionCount is how many sessions in the subtree (this work's own
	// included) spent tokens while their agent reported no price. Without it a
	// tree mixing Claude (which prices) and Codex (which never does) would report
	// a total that looks complete and is not.
	UnpricedSessionCount int `json:"unpriced_session_count,omitempty"`
}

// Equal compares two aggregations by value, following the pointers rather than
// comparing them — two Usages holding the same numbers in different allocations
// are the same usage (session.Usage.equal exists for the same reason). It is what
// lets a watcher tell "this session change moved the numbers" from "it did not".
func (u Usage) Equal(o Usage) bool {
	return u.DescendantCount == o.DescendantCount &&
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

// UsageTotals is consumption at one scope — one session, or a whole subtree.
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

// AggregateUsage adds up what root and its whole subtree consumed.
//
// It only reads what the sessions already recorded; nothing here re-counts
// tokens. Sessions that are missing — a work that never started, or one whose
// session has since been cleaned up — contribute nothing rather than failing the
// aggregation, which is the normal state of a subtree the user is still filling
// in.
func AggregateUsage(store Store, src SessionUsageSource, root Work) (Usage, error) {
	works, err := store.List()
	if err != nil {
		return Usage{}, err
	}

	children := make(map[string][]Work, len(works))
	for _, w := range works {
		if w.ParentID != "" {
			children[w.ParentID] = append(children[w.ParentID], w)
		}
	}

	lookup := newUsageLookup(src)

	var own, total session.TokenUsage
	var ownCost, totalCost *float64
	unpriced := 0
	visited := 0

	// Iterative walk with a seen set: a parent chain that somehow points back
	// into itself would otherwise make this recurse forever, and a work item
	// counted twice is worse than a work item counted once.
	seen := map[string]struct{}{root.ID: {}}
	stack := []Work{root}
	for len(stack) > 0 {
		node := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		visited++

		if usage, found := lookup.get(node.Worktree, node.SessionID); found {
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

		for _, child := range children[node.ID] {
			if _, dup := seen[child.ID]; dup {
				continue
			}
			seen[child.ID] = struct{}{}
			stack = append(stack, child)
		}
	}

	return Usage{
		Own:                  newTotals(own, ownCost),
		Total:                newTotals(total, totalCost),
		DescendantCount:      visited - 1,
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
// cost was zero" — the first is what a Codex-only subtree looks like, and
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
