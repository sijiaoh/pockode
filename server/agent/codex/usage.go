package codex

import (
	"encoding/json"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// usageObserver reads the token and context-window figures out of Codex's
// `token_count` events and feeds them to the accumulator.
//
// Where the numbers come from, on codex-cli 0.153.0:
//
//   - `info.total_token_usage` — the thread's totals so far. Codex emits a
//     token_count event during a turn as well as at the end of one, so these
//     arrive more often than once per turn; taking deltas makes that harmless.
//   - `info.last_token_usage` — the last request's own figures, whose
//     input_tokens is the size of the prompt that was sent, and so the only
//     report of how large the conversation currently is.
//   - `info.model_context_window` — the window that prompt has to fit in.
//   - No cost, ever. Codex reports rate limits, plan type and a credit balance
//     and never a price, so a Codex session stores no cost (see session.Usage).
//
// `info` is optional in the event: a token_count carrying only `rate_limits`
// says nothing about usage and is skipped.
type usageObserver struct {
	log         *slog.Logger
	accumulator *agent.UsageAccumulator
	// warnedTotalMismatch keeps checkTotal's warning to one per process.
	warnedTotalMismatch bool
}

func newUsageObserver(log *slog.Logger, opts agent.StartOptions) *usageObserver {
	return &usageObserver{log: log, accumulator: agent.NewUsageAccumulator(log, opts)}
}

// codexTokenUsage is one of Codex's token counts. Note the convention it
// differs on: input_tokens is the whole prompt with the cached tokens included,
// where session.TokenUsage counts them separately.
type codexTokenUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	// TotalTokens is Codex's own sum, kept only to check the arithmetic below
	// against it. See usageObserver.checkTotal.
	TotalTokens int64 `json:"total_tokens"`
}

// normalize converts to Pockode's convention by taking the cached and the
// freshly written tokens back out of the input count.
//
// That input_tokens contains the cached ones is measured, not assumed: a
// two-turn thread reported a second prompt of 12182 tokens of which 12032 were
// cached, and the first prompt was 12165 — consistent only if the cached tokens
// are part of the count, since a prompt that had grown by 12032 tokens over one
// short turn is not.
//
// Whether it also contains cache_write_input_tokens could not be measured: the
// only provider available to test against (OpenAI) reports that counter as zero
// throughout. Subtracting it is the reading that makes total_tokens come out as
// input_tokens + output_tokens, which is what Codex itself reports — and
// checkTotal watches for the provider that proves otherwise rather than leaving
// it to be discovered as a quietly wrong figure.
//
// Floored at zero: a provider reporting more cached tokens than input tokens
// would otherwise produce a negative count that propagates into every total
// built from it.
func (u codexTokenUsage) normalize() session.TokenUsage {
	input := u.InputTokens - u.CachedInputTokens - u.CacheWriteInputTokens
	if input < 0 {
		input = 0
	}
	return session.TokenUsage{
		InputTokens:      input,
		OutputTokens:     u.OutputTokens,
		CacheReadTokens:  u.CachedInputTokens,
		CacheWriteTokens: u.CacheWriteInputTokens,
	}
}

// observe handles one token_count event.
func (o *usageObserver) observe(raw json.RawMessage) {
	var event struct {
		Info *struct {
			TotalTokenUsage    codexTokenUsage `json:"total_token_usage"`
			LastTokenUsage     codexTokenUsage `json:"last_token_usage"`
			ModelContextWindow int64           `json:"model_context_window"`
		} `json:"info"`
	}
	if err := json.Unmarshal(raw, &event); err != nil {
		o.log.Warn("failed to parse token_count", "error", err)
		return
	}
	if event.Info == nil {
		return
	}

	total := event.Info.TotalTokenUsage.normalize()
	o.checkTotal(event.Info.TotalTokenUsage, total)

	o.accumulator.Report(
		total,
		nil,
		event.Info.LastTokenUsage.InputTokens,
		event.Info.ModelContextWindow,
	)
}

// checkTotal compares the normalised counts against the total Codex reported for
// the same figures, and says so once if they disagree.
//
// It exists because normalize has to take a position on how Codex's counters
// overlap, and one part of that position — that cache_write_input_tokens is
// inside input_tokens — is untestable on the only provider available (it reports
// that counter as zero). If it is wrong, the split and the total are both short
// by the cache-write count, and nothing about the number that reaches the user
// looks wrong. Codex's own total is the one witness available, so it is used as
// one: a mismatch means the arithmetic here no longer describes the CLI, which is
// worth a line in the log rather than a figure quietly drifting from the bill.
func (o *usageObserver) checkTotal(reported codexTokenUsage, normalized session.TokenUsage) {
	if o.warnedTotalMismatch || reported.TotalTokens == 0 || reported.TotalTokens == normalized.Total() {
		return
	}
	o.warnedTotalMismatch = true
	o.log.Warn("codex token counts do not add up to the total it reports, session usage may be inaccurate",
		"reportedTotal", reported.TotalTokens,
		"computedTotal", normalized.Total(),
		"inputTokens", reported.InputTokens,
		"cachedInputTokens", reported.CachedInputTokens,
		"cacheWriteInputTokens", reported.CacheWriteInputTokens,
		"outputTokens", reported.OutputTokens)
}
