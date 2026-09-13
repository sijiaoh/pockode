package agent

import (
	"log/slog"

	"github.com/pockode/server/session"
)

// UsageAccumulator turns the running totals an agent CLI reports into the
// increments a session total can be built from, and hands them to
// StartOptions.OnUsage.
//
// Both CLIs report cumulative figures, and both count from the start of the
// *process* rather than of the session: Claude's result frame carries
// `modelUsage` and `total_cost_usd` accumulated since the CLI started, Codex's
// `token_count` carries `info.total_token_usage` for the thread its mcp-server
// process is holding. A session outlives many processes — every restart and
// every resume is a new one — and on a resumed session both counters start again
// from zero (verified against claude 2.1.263 and codex-cli 0.153.0). So storing
// the reported total would lose everything consumed before the last restart,
// while adding it on every turn would count each turn again for every later turn
// of the same process. Adding only what is new does neither.
//
// One accumulator per process, created with the process, which is why there is
// no reset: a new process is a new accumulator with a zero baseline, and that is
// exactly the state its first report has to be read against.
//
// Not safe for concurrent use; each agent drives its own from the single
// goroutine that reads its CLI's output.
type UsageAccumulator struct {
	log    *slog.Logger
	report func(session.UsageReport)
	tokens session.TokenUsage
	cost   float64
	// warnedWentBackwards keeps the warning below to one per process.
	warnedWentBackwards bool
}

// NewUsageAccumulator builds an accumulator reporting to opts.OnUsage. A nil
// callback is fine — Report then does nothing, so agents need no nil check of
// their own.
func NewUsageAccumulator(log *slog.Logger, opts StartOptions) *UsageAccumulator {
	return &UsageAccumulator{log: log, report: opts.OnUsage}
}

// Report takes the totals the CLI has reported so far in this process, plus the
// context window state it reported alongside them, and passes on what is new.
//
// totalCostUSD is nil for a CLI that reports no cost, and no cost is then
// recorded at all — Pockode does not estimate one. contextTokens and
// contextWindow are zero when the frame says nothing about the window; see
// session.UsageReport for how that is read.
//
// A counter that went backwards contributes nothing rather than a negative
// increment, and the baseline keeps the higher figure, so a total that only
// dipped for one frame is not counted twice when it recovers. It is also warned
// about, once, because the other thing that looks like this is a CLI that reset
// its own counters mid-process — after which the clamp holds every later
// increment at zero and the session simply stops counting. Neither has been seen
// on either CLI, and guessing which one it was would mean choosing between
// double counting and under counting on no evidence; the log is what turns that
// choice into an informed one if it ever comes up.
func (a *UsageAccumulator) Report(total session.TokenUsage, totalCostUSD *float64, contextTokens, contextWindow int64) {
	if a.report == nil {
		return
	}

	before := a.tokens
	usage := session.UsageReport{
		Added: session.TokenUsage{
			InputTokens:      advanceCounter(&a.tokens.InputTokens, total.InputTokens),
			OutputTokens:     advanceCounter(&a.tokens.OutputTokens, total.OutputTokens),
			CacheReadTokens:  advanceCounter(&a.tokens.CacheReadTokens, total.CacheReadTokens),
			CacheWriteTokens: advanceCounter(&a.tokens.CacheWriteTokens, total.CacheWriteTokens),
		},
		ContextTokens: contextTokens,
		ContextWindow: contextWindow,
	}
	a.warnIfWentBackwards(before, total, totalCostUSD)

	// Reported whenever the CLI priced anything, even when the increment is zero:
	// an absent cost is how session.Usage says "this agent reports no cost at
	// all", so a Claude turn that added nothing to the bill must not be recorded
	// the same way a Codex turn is.
	if totalCostUSD != nil {
		added := 0.0
		if *totalCostUSD > a.cost {
			added = *totalCostUSD - a.cost
			a.cost = *totalCostUSD
		}
		usage.AddedCostUSD = &added
	}

	if usage.IsEmpty() {
		return
	}
	a.report(usage)
}

func advanceCounter(baseline *int64, total int64) int64 {
	if total <= *baseline {
		return 0
	}
	added := total - *baseline
	*baseline = total
	return added
}

// warnIfWentBackwards reports a reported total that is lower than one already
// seen. baseline is what was recorded before this report was folded in.
func (a *UsageAccumulator) warnIfWentBackwards(baseline, total session.TokenUsage, totalCostUSD *float64) {
	if a.warnedWentBackwards || a.log == nil {
		return
	}

	costFell := totalCostUSD != nil && *totalCostUSD < a.cost
	tokensFell := total.InputTokens < baseline.InputTokens ||
		total.OutputTokens < baseline.OutputTokens ||
		total.CacheReadTokens < baseline.CacheReadTokens ||
		total.CacheWriteTokens < baseline.CacheWriteTokens
	if !tokensFell && !costFell {
		return
	}

	a.warnedWentBackwards = true
	a.log.Warn("agent reported lower usage than before, the session may stop counting",
		"reportedTokens", total.Total(), "countedTokens", baseline.Total(), "costFell", costFell)
}
