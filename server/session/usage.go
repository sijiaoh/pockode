package session

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// TokenUsage counts the tokens a conversation consumed, on Anthropic's
// convention: InputTokens counts only what was actually sent to the model,
// with the tokens served from cache and the tokens written into it counted
// separately. Codex reports its prompt size the other way round — cached tokens
// included in the input count — so its parser subtracts them out (see
// agent/codex/usage.go). Without one convention, adding two sessions' totals
// together would add up two different things.
type TokenUsage struct {
	InputTokens      int64 `json:"input_tokens"`
	OutputTokens     int64 `json:"output_tokens"`
	CacheReadTokens  int64 `json:"cache_read_tokens"`
	CacheWriteTokens int64 `json:"cache_write_tokens"`
}

// Total is every token the conversation was billed for. Derived rather than
// stored: a stored total is a second copy of the same fact, and the copy is what
// goes stale when a counter is added or corrected.
func (u TokenUsage) Total() int64 {
	return u.InputTokens + u.OutputTokens + u.CacheReadTokens + u.CacheWriteTokens
}

// Add returns the two counts summed field by field.
func (u TokenUsage) Add(o TokenUsage) TokenUsage {
	return TokenUsage{
		InputTokens:      u.InputTokens + o.InputTokens,
		OutputTokens:     u.OutputTokens + o.OutputTokens,
		CacheReadTokens:  u.CacheReadTokens + o.CacheReadTokens,
		CacheWriteTokens: u.CacheWriteTokens + o.CacheWriteTokens,
	}
}

// IsZero reports whether no tokens have been counted yet. It is promoted onto
// Usage, where it still answers about the token counters alone — which is the
// question worth asking there too: a session the agent never reported anything
// for is one with nothing to show.
func (u TokenUsage) IsZero() bool { return u == TokenUsage{} }

// Usage is everything a session has consumed, as its agent reported it.
//
// It is part of SessionMeta but not of rpc.SessionListItem: a list row has no
// use for it, and the list goes to every subscriber on every change.
type Usage struct {
	TokenUsage

	// CostUSD is the agent's own cost accounting for this session, and is absent
	// when the agent reports no cost at all — Codex reports rate limits and
	// credits but never a price. Pockode does not estimate one from a price list:
	// a number we made up is indistinguishable, once displayed, from the one the
	// provider will actually bill.
	CostUSD *float64 `json:"cost_usd,omitempty"`

	// ContextTokens is how large the conversation was the last time the agent
	// measured it, and ContextWindow is the size of the window it has to fit in.
	// Unlike the counters above these are a level, not a total: a compaction
	// makes ContextTokens fall while the totals keep climbing.
	ContextTokens int64 `json:"context_tokens,omitempty"`
	ContextWindow int64 `json:"context_window,omitempty"`
}

// UsageReport is one report from an agent CLI, in the shape the session store
// applies it. The two halves are applied differently and are named for it: the
// Added* fields are increments, the Context* fields are the current level.
//
// Increments rather than totals because both CLIs report their totals per
// *process*, not per session: a resumed session starts a new process and both
// counters start again from zero. See agent.UsageAccumulator, which is what
// turns the one into the other.
type UsageReport struct {
	Added TokenUsage
	// AddedCostUSD is nil when the CLI reports no cost.
	AddedCostUSD *float64
	// ContextTokens and ContextWindow are zero when the CLI reports no window
	// state, which leaves whatever was last recorded in place.
	ContextTokens int64
	ContextWindow int64
}

// IsEmpty reports whether the report says nothing at all, which is what a CLI
// frame that repeated the previous totals amounts to.
func (r UsageReport) IsEmpty() bool {
	return r.Added.IsZero() && r.AddedCostUSD == nil && r.ContextTokens == 0 && r.ContextWindow == 0
}

// apply folds a report into the running totals, reporting whether anything
// changed — so a report that repeats what is already stored costs no index
// write and no notification.
func (u *Usage) apply(report UsageReport) bool {
	before := *u

	u.TokenUsage = u.TokenUsage.Add(report.Added)

	if report.AddedCostUSD != nil {
		total := *report.AddedCostUSD
		if u.CostUSD != nil {
			total += *u.CostUSD
		}
		u.CostUSD = &total
	}

	// Zero means "not reported in this frame", not "the context is empty": the
	// window state rides along on frames that carry token counts, and overwriting
	// a known window with zero would make the context reading flicker.
	if report.ContextTokens > 0 {
		u.ContextTokens = report.ContextTokens
	}
	if report.ContextWindow > 0 {
		u.ContextWindow = report.ContextWindow
	}

	return !u.equal(before)
}

// equal compares two snapshots by value, following CostUSD rather than
// comparing the pointers — two Usage values holding equal costs in different
// allocations are the same usage.
func (u Usage) equal(o Usage) bool {
	if u.TokenUsage != o.TokenUsage || u.ContextTokens != o.ContextTokens || u.ContextWindow != o.ContextWindow {
		return false
	}
	switch {
	case u.CostUSD == nil && o.CostUSD == nil:
		return true
	case u.CostUSD == nil || o.CostUSD == nil:
		return false
	default:
		return *u.CostUSD == *o.CostUSD
	}
}

// ReadUsages reports what every session in a data directory has consumed, read
// from the index on disk rather than through a store.
//
// For readers that do not own the directory. A FileStore must be the only
// instance for its dataDir, and worktree data directories are opened lazily, so
// something summing usage across worktrees (see work.AggregateUsage) cannot go
// through the stores: it would either need one that does not exist yet or a
// second one for a directory that already has an owner. Reading the file is
// safe and current — the index is written atomically, and every usage write
// persists it before notifying anyone, so it is never behind the change that
// prompted the read.
//
// No lock, on purpose: locking cannot make the read see a newer version than it
// happens to arrive at, and would create a .lock file in a directory this
// caller only wants to look at (see server/AGENTS.md).
//
// A directory with no index yet has no sessions, which is not an error.
func ReadUsages(dataDir string) (map[string]Usage, error) {
	data, err := os.ReadFile(indexPath(dataDir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read session index: %w", err)
	}

	var idx indexData
	if err := json.Unmarshal(data, &idx); err != nil {
		return nil, fmt.Errorf("parse session index: %w", err)
	}

	usages := make(map[string]Usage, len(idx.Sessions))
	for _, meta := range idx.Sessions {
		usages[meta.ID] = meta.Usage
	}
	return usages, nil
}
