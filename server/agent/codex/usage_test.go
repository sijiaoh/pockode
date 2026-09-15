package codex

import (
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/internal/logtest"
	"github.com/pockode/server/session"
)

// Frames below are trimmed copies of real codex-cli 0.153.0
// `thread/tokenUsage/updated` params. This set is one turn that made several
// requests: the counters in `total` add a whole prompt per request, while `last`
// reports the one request that was just made.
const (
	firstUsageUpdate = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":16216,"inputTokens":16111,"cachedInputTokens":12032,"cacheWriteInputTokens":0,"outputTokens":105,"reasoningOutputTokens":0},
		"last":{"totalTokens":16216,"inputTokens":16111,"cachedInputTokens":12032,"cacheWriteInputTokens":0,"outputTokens":105,"reasoningOutputTokens":0},
		"modelContextWindow":258400}}`

	secondUsageUpdate = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":32689,"inputTokens":32485,"cachedInputTokens":27904,"cacheWriteInputTokens":0,"outputTokens":204,"reasoningOutputTokens":0},
		"last":{"totalTokens":16473,"inputTokens":16374,"cachedInputTokens":15872,"cacheWriteInputTokens":0,"outputTokens":99,"reasoningOutputTokens":0},
		"modelContextWindow":258400}}`

	// The fifth and last request of that same turn.
	lastUsageUpdate = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":82974,"inputTokens":82620,"cachedInputTokens":77056,"cacheWriteInputTokens":0,"outputTokens":354,"reasoningOutputTokens":0},
		"last":{"totalTokens":16854,"inputTokens":16849,"cachedInputTokens":16512,"cacheWriteInputTokens":0,"outputTokens":5,"reasoningOutputTokens":0},
		"modelContextWindow":258400}}`
)

// A thread run against an 18000-token window (Codex reports 17100 of it as
// usable) until it compacted itself: the request that filled the window, the
// compaction's own update, and the first request after it.
//
// Captured on codex-cli 0.153.0 over the MCP channel, whose `token_count` event
// carries these same counters under snake_case names; the figures are
// transcribed into the app-server shape. Compaction is not something a probe can
// provoke cheaply enough to recapture, and the behaviour under test is about
// what a zeroed `last` means, which both channels report the same way.
const (
	beforeCompactionUsage = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":84360,"inputTokens":84154,"cachedInputTokens":67072,"cacheWriteInputTokens":0,"outputTokens":206,"reasoningOutputTokens":0},
		"last":{"totalTokens":16210,"inputTokens":16191,"cachedInputTokens":14592,"cacheWriteInputTokens":0,"outputTokens":19,"reasoningOutputTokens":0},
		"modelContextWindow":17100}}`

	compactionUsage = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":84360,"inputTokens":84154,"cachedInputTokens":67072,"cacheWriteInputTokens":0,"outputTokens":206,"reasoningOutputTokens":0},
		"last":{"totalTokens":6140,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},
		"modelContextWindow":17100}}`

	afterCompactionUsage = `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":97024,"inputTokens":96770,"cachedInputTokens":76160,"cacheWriteInputTokens":0,"outputTokens":254,"reasoningOutputTokens":0},
		"last":{"totalTokens":12664,"inputTokens":12616,"cachedInputTokens":9088,"cacheWriteInputTokens":0,"outputTokens":48,"reasoningOutputTokens":0},
		"modelContextWindow":17100}}`
)

func observeFrames(t *testing.T, frames ...string) []session.UsageReport {
	t.Helper()

	var got []session.UsageReport
	o := newUsageObserver(testLogger(), agent.StartOptions{
		OnUsage: func(r session.UsageReport) { got = append(got, r) },
	})
	for _, frame := range frames {
		o.observe([]byte(frame))
	}
	return got
}

// Codex reports running totals; the session is built from what is new in them.
func TestUsageObserverAccumulatesFromReportedTotals(t *testing.T) {
	got := observeFrames(t, firstUsageUpdate, secondUsageUpdate)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want one per usage update", len(got))
	}

	// The cached half is counted as a cache read rather than as input, which is
	// the convention every session total is built on.
	first := session.TokenUsage{InputTokens: 4079, OutputTokens: 105, CacheReadTokens: 12032}
	if got[0].Added != first {
		t.Errorf("first update added %+v, want %+v", got[0].Added, first)
	}

	second := session.TokenUsage{InputTokens: 502, OutputTokens: 99, CacheReadTokens: 15872}
	if got[1].Added != second {
		t.Errorf("second update added %+v, want %+v", got[1].Added, second)
	}

	// The normalised counts still add up to what Codex itself called the total.
	if total := got[0].Added.Add(got[1].Added).Total(); total != 32689 {
		t.Errorf("total = %d, want Codex's own 32689", total)
	}
}

// Codex prices nothing — it reports rate limits, a plan and a credit balance —
// so a Codex session must end up with no cost at all rather than a cost of zero.
func TestUsageObserverReportsNoCost(t *testing.T) {
	got := observeFrames(t, firstUsageUpdate)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].AddedCostUSD != nil {
		t.Errorf("cost = %v, want none", *got[0].AddedCostUSD)
	}
}

// The context reading is the last request's prompt size against the window the
// same update reports.
func TestUsageObserverReportsContext(t *testing.T) {
	got := observeFrames(t, firstUsageUpdate, secondUsageUpdate)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if got[1].ContextTokens != 16374 {
		t.Errorf("context tokens = %d, want 16374", got[1].ContextTokens)
	}
	if got[1].ContextWindow != 258400 {
		t.Errorf("context window = %d, want 258400", got[1].ContextWindow)
	}
}

// The context reading is a level, so it must not grow with the number of
// requests a turn makes. Every request re-sends the whole conversation, which is
// why the reported totals climb by a prompt each time while the level barely
// moves — reading the totals as the level multiplies it by the request count.
func TestUsageObserverContextIsNotTheTurnsTotal(t *testing.T) {
	got := observeFrames(t, firstUsageUpdate, lastUsageUpdate)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if got[0].ContextTokens != 16111 {
		t.Errorf("context tokens at the turn's first request = %d, want 16111", got[0].ContextTokens)
	}
	if got[1].ContextTokens != 16849 {
		t.Errorf("context tokens at the turn's last request = %d, want the prompt it sent, 16849 (its input count in the totals had reached 82620, the sum of all five)",
			got[1].ContextTokens)
	}
}

// Compaction's own update measured no request: its `last` is zeroed apart from
// totalTokens, which is Codex's estimate of the compacted history and not the
// size of any prompt. Reporting zero leaves the last real measurement in place,
// and the level then falls on the next request.
func TestUsageObserverContextFallsAfterCompaction(t *testing.T) {
	got := observeFrames(t, beforeCompactionUsage, compactionUsage, afterCompactionUsage)

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

// Codex sends usage updates during a turn as well as at the end of one, so the
// same totals arrive more than once. A repeat must add no tokens; it still
// carries the context level, which the store recognises as unchanged.
func TestUsageObserverAddsNothingForRepeatedTotals(t *testing.T) {
	got := observeFrames(t, firstUsageUpdate, firstUsageUpdate)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want 2", len(got))
	}
	if !got[1].Added.IsZero() {
		t.Errorf("repeat added %+v, want nothing", got[1].Added)
	}
}

// A provider reporting more cached tokens than input tokens would otherwise
// produce a negative input count that then poisons every total built from it.
func TestUsageObserverFloorsInputAtZero(t *testing.T) {
	got := observeFrames(t, `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"totalTokens":110,"inputTokens":100,"cachedInputTokens":150,"outputTokens":10},
		"last":{"totalTokens":110,"inputTokens":100,"cachedInputTokens":150,"outputTokens":10},
		"modelContextWindow":258400}}`)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].Added.InputTokens != 0 {
		t.Errorf("input tokens = %d, want 0", got[0].Added.InputTokens)
	}
}

// A frame whose totals are zero — nothing spent, or a shape we misread — must
// not reach the accumulator: the zeros look like a counter reset to it, and the
// warning that exists to catch a real one would fire on every such frame.
func TestUsageObserverSkipsEmptyTotals(t *testing.T) {
	warnings, log := logtest.NewWarnRecorder()
	var got []session.UsageReport
	o := newUsageObserver(log, agent.StartOptions{OnUsage: func(r session.UsageReport) { got = append(got, r) }})

	o.observe([]byte(firstUsageUpdate))
	o.observe([]byte(`{"threadId":"t","turnId":"u","tokenUsage":{"total":{},"last":{}}}`))

	if len(got) != 1 {
		t.Fatalf("got %d reports, want only the real one", len(got))
	}
	if msgs := warnings.Messages(); len(msgs) != 0 {
		t.Errorf("unexpected warnings: %v", msgs)
	}
}

// Dispatch, not just the observer: a usage update must reach the observer and
// must still add no entry to the transcript.
func TestUsageUpdateReachesObserverWithoutATranscriptEntry(t *testing.T) {
	var got []session.UsageReport
	sess := newTestSession()
	defer sess.cancel()
	sess.usage = newUsageObserver(testLogger(), agent.StartOptions{
		OnUsage: func(r session.UsageReport) { got = append(got, r) },
	})

	sess.notify("thread/tokenUsage/updated", firstUsageUpdate)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if events := drainEvents(sess.events); len(events) != 0 {
		t.Errorf("a usage update produced transcript events: %v", events)
	}
}

func TestUsageObserverSurvivesUnexpectedShapes(t *testing.T) {
	got := observeFrames(t, `{"threadId":"t","tokenUsage":"unexpected shape"}`, firstUsageUpdate)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want the one readable update", len(got))
	}
}

// The reported total is the only witness available for how Codex's counters
// overlap, so a mismatch must be reported rather than accepted quietly. The
// figures below are what an additive cacheWriteInputTokens would look like.
func TestUsageObserverWarnsWhenCountsDoNotAddUp(t *testing.T) {
	warnings, log := logtest.NewWarnRecorder()
	o := newUsageObserver(log, agent.StartOptions{OnUsage: func(session.UsageReport) {}})

	mismatched := `{"threadId":"t","turnId":"u","tokenUsage":{
		"total":{"inputTokens":1000,"cachedInputTokens":0,"cacheWriteInputTokens":200,"outputTokens":10,"totalTokens":1210},
		"last":{"inputTokens":1000,"totalTokens":1210},
		"modelContextWindow":258400}}`

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

	o.observe([]byte(firstUsageUpdate))
	o.observe([]byte(secondUsageUpdate))

	if got := warnings.Messages(); len(got) != 0 {
		t.Errorf("unexpected warnings: %v", got)
	}
}
