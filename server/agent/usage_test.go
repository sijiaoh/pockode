package agent

import (
	"log/slog"
	"math"
	"testing"

	"github.com/pockode/server/internal/logtest"
	"github.com/pockode/server/session"
)

func collectUsage(reports *[]session.UsageReport) StartOptions {
	return StartOptions{OnUsage: func(r session.UsageReport) { *reports = append(*reports, r) }}
}

func float64Ptr(v float64) *float64 { return &v }

// The point of the accumulator: a CLI's running totals become per-report
// increments, so a session total is the sum of its reports no matter how many of
// them a process sent.
func TestUsageAccumulatorReportsIncrements(t *testing.T) {
	var got []session.UsageReport
	acc := NewUsageAccumulator(slog.Default(), collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 2, OutputTokens: 14, CacheReadTokens: 10126}, float64Ptr(0.05), 15510, 1000000)
	acc.Report(session.TokenUsage{InputTokens: 4, OutputTokens: 20, CacheReadTokens: 25856}, float64Ptr(0.09), 25880, 1000000)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}

	first := session.TokenUsage{InputTokens: 2, OutputTokens: 14, CacheReadTokens: 10126}
	if got[0].Added != first {
		t.Errorf("first increment = %+v, want %+v", got[0].Added, first)
	}
	second := session.TokenUsage{InputTokens: 2, OutputTokens: 6, CacheReadTokens: 15730}
	if got[1].Added != second {
		t.Errorf("second increment = %+v, want %+v", got[1].Added, second)
	}

	if got[0].AddedCostUSD == nil || *got[0].AddedCostUSD != 0.05 {
		t.Errorf("first cost increment = %v, want 0.05", got[0].AddedCostUSD)
	}
	if got[1].AddedCostUSD == nil || math.Abs(*got[1].AddedCostUSD-0.04) > 1e-9 {
		t.Errorf("second cost increment = %v, want 0.04", got[1].AddedCostUSD)
	}

	// Context is a level, so it is passed through as reported rather than differenced.
	if got[1].ContextTokens != 25880 || got[1].ContextWindow != 1000000 {
		t.Errorf("context = %d/%d, want 25880/1000000", got[1].ContextTokens, got[1].ContextWindow)
	}
}

// A repeated report is what a CLI sends when it re-states its totals — Codex
// emits token_count more than once per turn. It must add nothing.
func TestUsageAccumulatorIgnoresRepeatedTotals(t *testing.T) {
	var got []session.UsageReport
	acc := NewUsageAccumulator(slog.Default(), collectUsage(&got))

	total := session.TokenUsage{InputTokens: 100, OutputTokens: 10}
	acc.Report(total, nil, 0, 0)
	acc.Report(total, nil, 0, 0)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1 (the repeat says nothing new)", len(got))
	}
}

// A repeat that still carries the window is not empty: the first report of a
// session may be the one that tells us the window at all.
func TestUsageAccumulatorReportsContextWithoutTokens(t *testing.T) {
	var got []session.UsageReport
	acc := NewUsageAccumulator(slog.Default(), collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 100}, nil, 100, 258400)
	acc.Report(session.TokenUsage{InputTokens: 100}, nil, 100, 258400)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if !got[1].Added.IsZero() || got[1].ContextWindow != 258400 {
		t.Errorf("second report = %+v, want context only", got[1])
	}
}

// Nothing in either CLI is known to count backwards, but a session total that
// shrinks would be worse than one that stalls. It is warned about because the
// clamp is also what a CLI resetting its own counters would run into, and that
// case stops the session counting for good — silently, unless something says so.
func TestUsageAccumulatorClampsCountersThatWentBackwards(t *testing.T) {
	var got []session.UsageReport
	warnings, log := logtest.NewWarnRecorder()
	acc := NewUsageAccumulator(log, collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 100, OutputTokens: 50}, float64Ptr(1.0), 0, 0)
	acc.Report(session.TokenUsage{InputTokens: 40, OutputTokens: 60}, float64Ptr(0.5), 0, 0)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	want := session.TokenUsage{OutputTokens: 10}
	if got[1].Added != want {
		t.Errorf("increment = %+v, want %+v (the counter that fell adds nothing)", got[1].Added, want)
	}
	// Still reported, because the CLI still priced the turn — but adding nothing.
	if got[1].AddedCostUSD == nil || *got[1].AddedCostUSD != 0 {
		t.Errorf("cost increment = %v, want 0", got[1].AddedCostUSD)
	}

	// The baseline kept the higher figure, so recovering to it adds nothing either.
	acc.Report(session.TokenUsage{InputTokens: 100, OutputTokens: 60}, nil, 0, 0)
	if len(got) != 2 {
		t.Errorf("got %d reports, want still 2", len(got))
	}

	if msgs := warnings.Messages(); len(msgs) != 1 {
		t.Errorf("got %d warnings, want exactly 1 (once per process): %v", len(msgs), msgs)
	}
}

// The ordinary case must stay quiet, or the warning above is worth nothing.
func TestUsageAccumulatorDoesNotWarnOnGrowingCounters(t *testing.T) {
	var got []session.UsageReport
	warnings, log := logtest.NewWarnRecorder()
	acc := NewUsageAccumulator(log, collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 10, OutputTokens: 5}, float64Ptr(0.1), 15, 200000)
	acc.Report(session.TokenUsage{InputTokens: 20, OutputTokens: 9}, float64Ptr(0.2), 29, 200000)
	// A repeat is not a decrease.
	acc.Report(session.TokenUsage{InputTokens: 20, OutputTokens: 9}, float64Ptr(0.2), 29, 200000)

	if msgs := warnings.Messages(); len(msgs) != 0 {
		t.Errorf("unexpected warnings: %v", msgs)
	}
}

// An agent that reports no cost must leave the session without one, rather than
// with a cost of zero: the two mean different things to whoever displays it.
func TestUsageAccumulatorWithoutCost(t *testing.T) {
	var got []session.UsageReport
	acc := NewUsageAccumulator(slog.Default(), collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 100}, nil, 0, 0)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].AddedCostUSD != nil {
		t.Errorf("cost = %v, want none", *got[0].AddedCostUSD)
	}
}

func TestUsageAccumulatorWithoutCallback(t *testing.T) {
	acc := NewUsageAccumulator(slog.Default(), StartOptions{})
	// Nobody is counting; the only requirement is that reporting is still safe.
	acc.Report(session.TokenUsage{InputTokens: 1}, float64Ptr(1), 1, 1)
}

// An agent that prices its turns must leave a cost on the session even when a
// turn added nothing to the bill: an absent cost is reserved for agents that
// report no price at all, and the two must not look alike.
func TestUsageAccumulatorReportsZeroCostWhenPriced(t *testing.T) {
	var got []session.UsageReport
	acc := NewUsageAccumulator(slog.Default(), collectUsage(&got))

	acc.Report(session.TokenUsage{InputTokens: 100}, float64Ptr(0), 0, 0)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].AddedCostUSD == nil {
		t.Fatal("cost = none, want a reported zero")
	}
	if *got[0].AddedCostUSD != 0 {
		t.Errorf("cost = %v, want 0", *got[0].AddedCostUSD)
	}
}
