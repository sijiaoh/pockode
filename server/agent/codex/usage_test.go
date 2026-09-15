package codex

import (
	"log/slog"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/internal/logtest"
	"github.com/pockode/server/session"
)

// Frames below are trimmed copies of real codex-cli 0.153.0 token_count events:
// two turns of one thread, the second reading from the cache the first wrote.
const (
	firstTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":12165,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":12170},
		"last_token_usage":{"input_tokens":12165,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":12170},
		"model_context_window":258400},
		"rate_limits":{"limit_id":"codex","primary":{"used_percent":0.0}}}`

	secondTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":24347,"cached_input_tokens":12032,"cache_write_input_tokens":0,"output_tokens":10,"reasoning_output_tokens":0,"total_tokens":24357},
		"last_token_usage":{"input_tokens":12182,"cached_input_tokens":12032,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":12187},
		"model_context_window":258400},
		"rate_limits":{"limit_id":"codex","primary":{"used_percent":1.0}}}`
)

// One turn of codex-cli 0.153.0 that made six tool calls, so seven requests:
// the first request's event and the seventh's. The thread totals have added up
// seven prompts by the end; last_token_usage still reports one.
const (
	longTurnFirstTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":12174,"cached_input_tokens":3968,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0,"total_tokens":12214},
		"last_token_usage":{"input_tokens":12174,"cached_input_tokens":3968,"cache_write_input_tokens":0,"output_tokens":40,"reasoning_output_tokens":0,"total_tokens":12214},
		"model_context_window":258400}}`

	longTurnLastTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":87193,"cached_input_tokens":77440,"cache_write_input_tokens":0,"output_tokens":165,"reasoning_output_tokens":0,"total_tokens":87358},
		"last_token_usage":{"input_tokens":12726,"cached_input_tokens":12416,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0,"total_tokens":12731},
		"model_context_window":258400}}`
)

// A thread of codex-cli 0.153.0 run against an 18000-token window (Codex
// reports 17100 of it as usable) until it compacted itself: the request that
// filled the window, the compaction's own event, and the first request after it.
const (
	beforeCompactionTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":84154,"cached_input_tokens":67072,"cache_write_input_tokens":0,"output_tokens":206,"reasoning_output_tokens":0,"total_tokens":84360},
		"last_token_usage":{"input_tokens":16191,"cached_input_tokens":14592,"cache_write_input_tokens":0,"output_tokens":19,"reasoning_output_tokens":0,"total_tokens":16210},
		"model_context_window":17100}}`

	compactionTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":84154,"cached_input_tokens":67072,"cache_write_input_tokens":0,"output_tokens":206,"reasoning_output_tokens":0,"total_tokens":84360},
		"last_token_usage":{"input_tokens":0,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":0,"reasoning_output_tokens":0,"total_tokens":6140},
		"model_context_window":17100}}`

	afterCompactionTokenCount = `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":96770,"cached_input_tokens":76160,"cache_write_input_tokens":0,"output_tokens":254,"reasoning_output_tokens":0,"total_tokens":97024},
		"last_token_usage":{"input_tokens":12616,"cached_input_tokens":9088,"cache_write_input_tokens":0,"output_tokens":48,"reasoning_output_tokens":0,"total_tokens":12664},
		"model_context_window":17100}}`
)

func observeFrames(t *testing.T, lines ...string) []session.UsageReport {
	t.Helper()

	var got []session.UsageReport
	o := newUsageObserver(slog.Default(), agent.StartOptions{
		OnUsage: func(r session.UsageReport) { got = append(got, r) },
	})
	for _, line := range lines {
		o.observe([]byte(line))
	}
	return got
}

func TestUsageObserverAccumulatesAcrossTurns(t *testing.T) {
	got := observeFrames(t, firstTokenCount, secondTokenCount)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want one per token_count", len(got))
	}

	first := session.TokenUsage{InputTokens: 12165, OutputTokens: 5}
	if got[0].Added != first {
		t.Errorf("first turn added %+v, want %+v", got[0].Added, first)
	}

	// Codex's total_token_usage is cumulative for the thread, so only the
	// difference is new — and the cached half of that difference is counted as a
	// cache read rather than as input, which is the convention every session
	// total is built on.
	second := session.TokenUsage{InputTokens: 150, OutputTokens: 5, CacheReadTokens: 12032}
	if got[1].Added != second {
		t.Errorf("second turn added %+v, want %+v", got[1].Added, second)
	}

	// The normalised counts still add up to what Codex itself called the total.
	if total := got[0].Added.Add(got[1].Added).Total(); total != 24357 {
		t.Errorf("total = %d, want Codex's own 24357", total)
	}
}

// Codex prices nothing — it reports rate limits, a plan and a credit balance —
// so a Codex session must end up with no cost at all rather than a cost of zero.
func TestUsageObserverReportsNoCost(t *testing.T) {
	got := observeFrames(t, firstTokenCount)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].AddedCostUSD != nil {
		t.Errorf("cost = %v, want none", *got[0].AddedCostUSD)
	}
}

// The context reading is the last request's prompt size against the window the
// same event reports.
func TestUsageObserverReportsContext(t *testing.T) {
	got := observeFrames(t, firstTokenCount, secondTokenCount)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if got[1].ContextTokens != 12182 {
		t.Errorf("context tokens = %d, want 12182", got[1].ContextTokens)
	}
	if got[1].ContextWindow != 258400 {
		t.Errorf("context window = %d, want 258400", got[1].ContextWindow)
	}
}

// The context reading is a level, so it must not grow with the number of
// requests a turn makes. Every request re-sends the whole conversation, which is
// why the thread totals climb by a prompt each time while the level barely
// moves — reading the totals as the level multiplies it by the request count.
func TestUsageObserverContextIsNotTheTurnsTotal(t *testing.T) {
	got := observeFrames(t, longTurnFirstTokenCount, longTurnLastTokenCount)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if got[0].ContextTokens != 12174 {
		t.Errorf("context tokens at the turn's first request = %d, want 12174", got[0].ContextTokens)
	}
	if got[1].ContextTokens != 12726 {
		t.Errorf("context tokens at the turn's seventh request = %d, want the prompt it sent, 12726 (its input count in the thread totals had reached 87193, the sum of all seven)",
			got[1].ContextTokens)
	}
}

// Compaction's own token_count measured no request: its last_token_usage is
// zeroed apart from total_tokens, which is Codex's estimate of the compacted
// history and not the size of any prompt. Reporting zero leaves the last real
// measurement in place, and the level then falls on the next request.
func TestUsageObserverContextFallsAfterCompaction(t *testing.T) {
	got := observeFrames(t, beforeCompactionTokenCount, compactionTokenCount, afterCompactionTokenCount)

	if len(got) != 3 {
		t.Fatalf("got %d reports, want 3", len(got))
	}
	if got[0].ContextTokens != 16191 {
		t.Errorf("context tokens before compaction = %d, want 16191", got[0].ContextTokens)
	}
	if got[1].ContextTokens != 0 {
		t.Errorf("compaction reported a context level of %d, want none (6140 is not a prompt size)",
			got[1].ContextTokens)
	}
	if got[2].ContextTokens != 12616 {
		t.Errorf("context tokens after compaction = %d, want 12616", got[2].ContextTokens)
	}
}

// Codex emits token_count during a turn as well as at the end of one, so the
// same totals arrive more than once. A repeat must add no tokens; it still
// carries the context level, which the store recognises as unchanged.
func TestUsageObserverAddsNothingForRepeatedTotals(t *testing.T) {
	got := observeFrames(t, firstTokenCount, firstTokenCount)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if !got[1].Added.IsZero() {
		t.Errorf("repeat added %+v, want nothing", got[1].Added)
	}
}

// `info` is optional: an event carrying only rate limits says nothing about
// usage.
func TestUsageObserverWithoutInfo(t *testing.T) {
	got := observeFrames(t, `{"type":"token_count","rate_limits":{"limit_id":"codex"}}`)
	if len(got) != 0 {
		t.Errorf("got %d reports, want none", len(got))
	}
}

func TestUsageObserverSurvivesUnexpectedShapes(t *testing.T) {
	got := observeFrames(t, `{"type":"token_count","info":"unexpected shape"}`, firstTokenCount)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want the one readable event", len(got))
	}
}

// A provider reporting more cached tokens than input tokens would otherwise
// produce a negative input count that then poisons every total built from it.
func TestUsageObserverFloorsInputAtZero(t *testing.T) {
	got := observeFrames(t, `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":100,"cached_input_tokens":150,"output_tokens":10},
		"last_token_usage":{"input_tokens":100,"cached_input_tokens":150,"output_tokens":10},
		"model_context_window":258400}}`)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].Added.InputTokens != 0 {
		t.Errorf("input tokens = %d, want 0", got[0].Added.InputTokens)
	}
}

// token_count used to be on the ignored list, where a usage event produces
// nothing and nothing complains. This checks the dispatch itself: a token_count
// arriving as a Codex event must reach the observer, and must still add no entry
// to the transcript.
func TestTokenCountEventReachesObserver(t *testing.T) {
	var got []session.UsageReport
	sess := &mcpSession{
		log:    slog.Default(),
		events: make(chan agent.AgentEvent, 1),
		usage: newUsageObserver(slog.Default(), agent.StartOptions{
			OnUsage: func(r session.UsageReport) { got = append(got, r) },
		}),
	}

	sess.processCodexMsg([]byte(firstTokenCount), nil)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	select {
	case event := <-sess.events:
		t.Errorf("token_count produced a transcript event: %T", event)
	default:
	}
}

// The reported total is the only witness available for how Codex's counters
// overlap, so a mismatch must be reported rather than accepted quietly. The
// figures below are what an additive cache_write_input_tokens would look like.
func TestUsageObserverWarnsWhenCountsDoNotAddUp(t *testing.T) {
	warnings, log := logtest.NewWarnRecorder()
	o := newUsageObserver(log, agent.StartOptions{OnUsage: func(session.UsageReport) {}})

	mismatched := `{"type":"token_count","info":{
		"total_token_usage":{"input_tokens":1000,"cached_input_tokens":0,"cache_write_input_tokens":200,"output_tokens":10,"total_tokens":1210},
		"last_token_usage":{"input_tokens":1000,"total_tokens":1210},
		"model_context_window":258400}}`

	o.observe([]byte(mismatched))
	o.observe([]byte(mismatched))

	if got := warnings.Messages(); len(got) != 1 {
		t.Fatalf("got %d warnings, want exactly 1 (once per process, not once per event): %v", len(got), got)
	}
}

// The real frames must not trip that check: the arithmetic matches what Codex
// reports on the provider we can test against.
func TestUsageObserverDoesNotWarnOnRealFrames(t *testing.T) {
	warnings, log := logtest.NewWarnRecorder()
	o := newUsageObserver(log, agent.StartOptions{OnUsage: func(session.UsageReport) {}})

	o.observe([]byte(firstTokenCount))
	o.observe([]byte(secondTokenCount))

	if got := warnings.Messages(); len(got) != 0 {
		t.Errorf("unexpected warnings: %v", got)
	}
}
