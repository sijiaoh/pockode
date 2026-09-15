package codex

import (
	"encoding/json"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// usageObserver reads the token and context-window figures out of Codex's
// `thread/tokenUsage/updated` notifications and feeds them to the accumulator.
//
// Where the numbers come from, on codex-cli 0.153.0:
//
//   - `tokenUsage.total` — the totals so far. Codex sends this notification
//     during a turn as well as at the end of one, so they arrive more often
//     than once per turn; taking deltas makes that harmless. The count is per
//     process: it starts again from zero when a thread is resumed (measured —
//     two turns in one process ran 16721 -> 33458, and a resume began afresh),
//     which is the same per-process semantics agent.UsageAccumulator is built
//     for.
//   - `tokenUsage.last` — one API request's own figures, not the turn's.
//     Its input_tokens is the size of the prompt that request sent, and so the
//     only report of how large the conversation currently is. Measured on a turn
//     that made six tool calls, i.e. seven requests: the input count in the
//     thread totals reached 87193, the sum of all seven prompts, while the same
//     count here moved only 12174 -> 12726, each request re-sending a prompt
//     that had grown by one tool's output. Reading the totals as a context level
//     would therefore multiply the level by the number of requests in the turn,
//     which is the bug a Claude session showed as 904% of its window.
//   - `tokenUsage.modelContextWindow` — the window that prompt has to fit in.
//   - No cost, ever. Codex reports rate limits, plan type and a credit balance
//     and never a price, so a Codex session stores no cost (see session.Usage).
//
// Compaction emits a usage update of its own, and it measured no request: every
// field of `last` is zero except totalTokens, which carries Codex's
// estimate of the compacted history (6140, in a thread run against an 18000
// token window until it compacted itself, whose next real request then measured
// a prompt of 12616; measured on the MCP channel, whose figures these are the
// renamed form of). Reporting zero is right for it — the store
// reads a zero context level as "not reported in this frame" and keeps the last
// real measurement, so the reading falls once, when the next request measures
// it, rather than dipping to a number no prompt ever had and bouncing back.
// This is why the level is taken from input_tokens and not from total_tokens.
//
// Codex's own UI prints a smaller percentage than Pockode does for the same
// thread, and the difference is understood. Its optional `context-used`
// status-line item showed 1% where the prompt this reports was 14414 of a 258400
// window (5.6%): Codex discounts a baseline of roughly 12000 tokens — about what
// a thread's very first prompt measures, i.e. the system prompt and tool
// definitions that are in every prompt — from both sides of the ratio. Pockode
// does not, because that baseline really is occupying the window, no event
// reports its size as a figure of its own — it would have to be hard-coded from
// Codex's internals — and discounting it for Codex alone would make the figure
// incomparable with the Claude one shown beside it. What the cross-check does
// settle is the shape of the reading: Codex called that turn 1%, not the 38% its
// running total had reached.
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
	InputTokens           int64 `json:"inputTokens"`
	CachedInputTokens     int64 `json:"cachedInputTokens"`
	CacheWriteInputTokens int64 `json:"cacheWriteInputTokens"`
	OutputTokens          int64 `json:"outputTokens"`
	// TotalTokens is Codex's own sum, kept only to check the arithmetic below
	// against it. See usageObserver.checkTotal.
	TotalTokens int64 `json:"totalTokens"`
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

// observe handles one thread/tokenUsage/updated notification.
func (o *usageObserver) observe(params json.RawMessage) {
	var notif struct {
		TokenUsage struct {
			Total              codexTokenUsage `json:"total"`
			Last               codexTokenUsage `json:"last"`
			ModelContextWindow int64           `json:"modelContextWindow"`
		} `json:"tokenUsage"`
	}
	if err := json.Unmarshal(params, &notif); err != nil {
		o.log.Warn("failed to parse thread/tokenUsage/updated", "error", err)
		return
	}

	if notif.TokenUsage.Total.TotalTokens == 0 {
		// A frame that reports no consumption at all: nothing has been spent, so
		// there is nothing to add and no prompt whose size could be the context
		// level. Skipped rather than reported as zeros, because zeros are also
		// what a frame whose shape we misread produces — and feeding those to
		// the accumulator trips its "usage went backwards" warning, which exists
		// to catch a real counter reset.
		return
	}

	total := notif.TokenUsage.Total.normalize()
	o.checkTotal(notif.TokenUsage.Total, total)

	o.accumulator.Report(
		total,
		nil,
		notif.TokenUsage.Last.InputTokens,
		notif.TokenUsage.ModelContextWindow,
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
