package claude

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"testing"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/internal/logtest"
	"github.com/pockode/server/session"
)

// Frames below are trimmed copies of real claude 2.1.263 output: a first turn
// answered by opus with a side call to haiku (the session title), then a second
// turn in the same process, whose modelUsage is the running total of both.
const (
	initFrame = `{"type":"system","subtype":"init","session_id":"s","model":"claude-opus-5[1m]"}`

	firstResultFrame = `{"type":"result","subtype":"success","is_error":false,
		"usage":{"input_tokens":2,"cache_creation_input_tokens":3577,"cache_read_input_tokens":12117,"output_tokens":3},
		"modelUsage":{
			"claude-haiku-4-5-20251001":{"inputTokens":898,"outputTokens":14,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.000968,"contextWindow":200000,"canonicalModel":"claude-haiku-4-5"},
			"claude-opus-5[1m]":{"inputTokens":2,"outputTokens":3,"cacheReadInputTokens":12117,"cacheCreationInputTokens":3577,"costUSD":0.0419,"contextWindow":1000000,"canonicalModel":"claude-opus-5"}},
		"total_cost_usd":0.042868}`

	secondResultFrame = `{"type":"result","subtype":"success","is_error":false,
		"usage":{"input_tokens":2,"cache_creation_input_tokens":36,"cache_read_input_tokens":15694,"output_tokens":3},
		"modelUsage":{
			"claude-haiku-4-5-20251001":{"inputTokens":898,"outputTokens":14,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.000968,"contextWindow":200000,"canonicalModel":"claude-haiku-4-5"},
			"claude-opus-5[1m]":{"inputTokens":4,"outputTokens":6,"cacheReadInputTokens":27811,"cacheCreationInputTokens":3613,"costUSD":0.0502,"contextWindow":1000000,"canonicalModel":"claude-opus-5"}},
		"total_cost_usd":0.051173}`
)

// assistantFrame is one API request's usage in the shape claude 2.1.263 reports
// it, which is where the context reading comes from.
func assistantFrame(input, cacheRead, cacheCreation int64) string {
	return fmt.Sprintf(`{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-opus-5",`+
		`"usage":{"input_tokens":%d,"cache_read_input_tokens":%d,"cache_creation_input_tokens":%d,"output_tokens":7}}}`,
		input, cacheRead, cacheCreation)
}

// observeFrames feeds raw stream-json lines through the observer the way
// streamOutput does, and returns everything it reported.
func observeFrames(t *testing.T, lines ...string) []session.UsageReport {
	t.Helper()

	var got []session.UsageReport
	o := newUsageObserver(slog.Default(), agent.StartOptions{
		OnUsage: func(r session.UsageReport) { got = append(got, r) },
	})

	for _, line := range lines {
		var event cliEvent
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			t.Fatalf("test frame is not valid JSON: %v", err)
		}
		o.observe([]byte(line), event)
	}
	return got
}

func TestUsageObserverAccumulatesAcrossTurns(t *testing.T) {
	got := observeFrames(t, initFrame, firstResultFrame, initFrame, secondResultFrame)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want one per result frame", len(got))
	}

	// Every model in the frame counts, the side model included: haiku's 898+14
	// are reported nowhere else, so a total built from `usage` alone loses them.
	first := session.TokenUsage{InputTokens: 900, OutputTokens: 17, CacheReadTokens: 12117, CacheWriteTokens: 3577}
	if got[0].Added != first {
		t.Errorf("first turn added %+v, want %+v", got[0].Added, first)
	}

	// The second frame's modelUsage is the running total of both turns, so only
	// the difference is new.
	second := session.TokenUsage{InputTokens: 2, OutputTokens: 3, CacheReadTokens: 15694, CacheWriteTokens: 36}
	if got[1].Added != second {
		t.Errorf("second turn added %+v, want %+v", got[1].Added, second)
	}

	if got[0].AddedCostUSD == nil || *got[0].AddedCostUSD != 0.042868 {
		t.Errorf("first turn cost = %v, want 0.042868", got[0].AddedCostUSD)
	}
	if got[1].AddedCostUSD == nil || math.Abs(*got[1].AddedCostUSD-0.008305) > 1e-9 {
		t.Errorf("second turn cost = %v, want 0.008305", got[1].AddedCostUSD)
	}
}

// The context reading is the prompt of the last API request the turn made, cache
// hits and cache writes included: that is how much of the window the conversation
// occupies right now.
func TestUsageObserverReportsContext(t *testing.T) {
	got := observeFrames(t, initFrame, assistantFrame(2, 15694, 36), secondResultFrame)

	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if want := int64(2 + 36 + 15694); got[0].ContextTokens != want {
		t.Errorf("context tokens = %d, want %d", got[0].ContextTokens, want)
	}
	// The window of the model the session runs, not of the side model that also
	// appears in modelUsage.
	if got[0].ContextWindow != 1000000 {
		t.Errorf("context window = %d, want 1000000", got[0].ContextWindow)
	}
}

func TestUsageObserverContextWindowForSmallModelSession(t *testing.T) {
	// A session running haiku, whose window is the narrower of the two reported:
	// picking the widest would claim the conversation has five times the room it
	// actually has.
	haikuInit := `{"type":"system","subtype":"init","model":"claude-haiku-4-5-20251001"}`

	got := observeFrames(t, haikuInit, firstResultFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].ContextWindow != 200000 {
		t.Errorf("context window = %d, want 200000", got[0].ContextWindow)
	}
}

// A resumed process names the model without the variant suffix the modelUsage
// key still carries, so the ids only match after canonicalisation.
func TestUsageObserverContextWindowMatchesCanonicalModel(t *testing.T) {
	plainInit := `{"type":"system","subtype":"init","model":"claude-opus-5"}`

	got := observeFrames(t, plainInit, firstResultFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].ContextWindow != 1000000 {
		t.Errorf("context window = %d, want 1000000", got[0].ContextWindow)
	}
}

// Without an init frame there is no model to match, and the widest window is the
// best guess left. Reporting none would leave the context unreadable.
func TestUsageObserverContextWindowWithoutInit(t *testing.T) {
	got := observeFrames(t, firstResultFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].ContextWindow != 1000000 {
		t.Errorf("context window = %d, want 1000000", got[0].ContextWindow)
	}
}

// An error result still reports what the failed turn consumed: the tokens were
// spent whether or not the answer arrived.
func TestUsageObserverCountsFailedTurn(t *testing.T) {
	errorFrame := `{"type":"result","subtype":"error_during_execution","is_error":true,
		"usage":{"input_tokens":5,"cache_read_input_tokens":100,"output_tokens":0},
		"modelUsage":{"claude-opus-5[1m]":{"inputTokens":5,"outputTokens":0,"cacheReadInputTokens":100,"contextWindow":1000000}},
		"total_cost_usd":0.001}`

	got := observeFrames(t, initFrame, errorFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if got[0].Added.Total() != 105 {
		t.Errorf("added %d tokens, want 105", got[0].Added.Total())
	}
}

// Nothing is recorded from a CLI that reports no per-model totals, because the
// frame's own `usage` is an increment and cannot be mixed with cumulative
// figures. Recording nothing is the honest outcome; crashing or double counting
// are not.
func TestUsageObserverWithoutModelUsage(t *testing.T) {
	frame := `{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2}}`

	warnings, log := logtest.NewWarnRecorder()
	o := newUsageObserver(log, agent.StartOptions{
		OnUsage: func(session.UsageReport) { t.Error("recorded usage from a frame with no per-model totals") },
	})
	for range 3 {
		var event cliEvent
		if err := json.Unmarshal([]byte(frame), &event); err != nil {
			t.Fatalf("test frame is not valid JSON: %v", err)
		}
		o.observe([]byte(frame), event)
	}

	// Said once, not once per turn: this is a property of the CLI, and it would
	// otherwise be repeated for every turn of every session it runs.
	if msgs := warnings.Messages(); len(msgs) != 1 {
		t.Errorf("got %d warnings, want exactly 1: %v", len(msgs), msgs)
	}
}

// Frames that carry no usage at all must not be mistaken for ones that do.
func TestUsageObserverIgnoresOtherFrames(t *testing.T) {
	got := observeFrames(t,
		initFrame,
		`{"type":"assistant","message":{"model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":5}}}`,
		`{"type":"system","subtype":"compact_boundary"}`,
		`{"type":"rate_limit_event"}`,
	)
	if len(got) != 0 {
		t.Errorf("got %d reports, want none", len(got))
	}
}

// A malformed result frame must not take the session's counting down with it.
func TestUsageObserverSurvivesUnexpectedShapes(t *testing.T) {
	got := observeFrames(t,
		`{"type":"system","subtype":"init","model":{"unexpected":"shape"}}`,
		`{"type":"result","modelUsage":"unexpected shape"}`,
		firstResultFrame,
	)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want the one readable frame", len(got))
	}
	if got[0].ContextWindow != 1000000 {
		t.Errorf("context window = %d, want 1000000", got[0].ContextWindow)
	}
}

// Two entries can share a canonical model — a process that used both the 1m
// variant and the plain one — and ranging over a map hands them over in a
// different order every time. The answer must not depend on that.
func TestUsageObserverContextWindowIsStableAcrossBothVariants(t *testing.T) {
	plainInit := `{"type":"system","subtype":"init","model":"claude-opus-5"}`
	bothVariants := `{"type":"result","subtype":"success","usage":{"input_tokens":1},"modelUsage":{
		"claude-opus-5":{"inputTokens":1,"contextWindow":200000,"canonicalModel":"claude-opus-5"},
		"claude-opus-5[1m]":{"inputTokens":1,"contextWindow":1000000,"canonicalModel":"claude-opus-5"}},
		"total_cost_usd":0.01}`

	for range 20 {
		got := observeFrames(t, plainInit, bothVariants)
		if len(got) != 1 {
			t.Fatalf("got %d reports, want 1", len(got))
		}
		// The exact key match wins outright, so the plain variant's own window is
		// the answer every time.
		if got[0].ContextWindow != 200000 {
			t.Fatalf("context window = %d, want 200000", got[0].ContextWindow)
		}
	}
}

// Same shape, but with no exact key to match, so the canonical fallback decides.
func TestUsageObserverContextWindowCanonicalFallbackIsStable(t *testing.T) {
	suffixedInit := `{"type":"system","subtype":"init","model":"claude-opus-5[500k]"}`
	bothVariants := `{"type":"result","subtype":"success","usage":{"input_tokens":1},"modelUsage":{
		"claude-opus-5":{"inputTokens":1,"contextWindow":200000,"canonicalModel":"claude-opus-5"},
		"claude-opus-5[1m]":{"inputTokens":1,"contextWindow":1000000,"canonicalModel":"claude-opus-5"}},
		"total_cost_usd":0.01}`

	for range 20 {
		got := observeFrames(t, suffixedInit, bothVariants)
		if len(got) != 1 {
			t.Fatalf("got %d reports, want 1", len(got))
		}
		if got[0].ContextWindow != 1000000 {
			t.Fatalf("context window = %d, want the widest canonical match 1000000", got[0].ContextWindow)
		}
	}
}

// The contract this file exists to protect: a turn that makes many API requests
// must report the size the conversation reached, not the sum of every prompt it
// sent along the way. The figures are one real claude 2.1.263 turn of seven
// requests, whose `result.usage.cache_read_input_tokens` was 163135 — exactly
// those seven cache reads added up, and 6.6x the conversation's actual size.
func TestUsageObserverContextIsNotTheTurnsTotal(t *testing.T) {
	frames := []string{initFrame}
	for _, cacheRead := range []int64{18534, 23726, 23935, 24055, 24175, 24295, 24415} {
		frames = append(frames, assistantFrame(2, cacheRead, 120))
	}
	frames = append(frames, secondResultFrame)

	got := observeFrames(t, frames...)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if want := int64(2 + 24415 + 120); got[0].ContextTokens != want {
		t.Errorf("context tokens = %d, want the last request's prompt %d", got[0].ContextTokens, want)
	}
}

// A compaction shrinks the conversation, and the reading has to follow it down.
// The levels are a real /compact between two turns of one process — 66200 before
// and 24876 after — and the boundary frame is carried along because its
// `post_tokens` (3026) is the tempting wrong answer: it counts the retained
// conversation alone, without the system prompt and tool definitions that the
// next request's 24876 includes.
func TestUsageObserverContextFallsAfterCompaction(t *testing.T) {
	got := observeFrames(t,
		initFrame, assistantFrame(2, 66078, 120), firstResultFrame,
		`{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"manual","pre_tokens":66631,"post_tokens":3026}}`,
		initFrame, assistantFrame(2, 20000, 4874), secondResultFrame,
	)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want one per result frame", len(got))
	}
	if got[0].ContextTokens != 66200 {
		t.Errorf("context before compaction = %d, want 66200", got[0].ContextTokens)
	}
	if got[1].ContextTokens != 24876 {
		t.Errorf("context after compaction = %d, want 24876", got[1].ContextTokens)
	}
}

// A subagent is prompted with a conversation of its own, so the size of its
// prompt is not the size of this session's window. Its frames are the last ones
// a turn emits whenever the turn ends on a Task call.
func TestUsageObserverIgnoresSubagentContext(t *testing.T) {
	subagent := `{"type":"assistant","parent_tool_use_id":"toolu_01","message":{"model":"claude-opus-5",` +
		`"usage":{"input_tokens":2,"cache_read_input_tokens":11798,"cache_creation_input_tokens":0,"output_tokens":9}}}`

	got := observeFrames(t, initFrame, assistantFrame(2, 24032, 0), subagent, secondResultFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if want := int64(2 + 24032); got[0].ContextTokens != want {
		t.Errorf("context tokens = %d, want the main conversation's %d", got[0].ContextTokens, want)
	}
}

// A turn that sent no request of its own has not made the conversation smaller,
// so the last measurement still stands. `/compact` is such a turn: it ends in a
// result frame whose own `usage` is all zeroes and whose modelUsage still carries
// the totals of the turn before it, and it emits no assistant frame at all.
func TestUsageObserverContextSurvivesTurnWithoutRequests(t *testing.T) {
	compactResultFrame := `{"type":"result","subtype":"success","is_error":false,
		"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0},
		"modelUsage":{
			"claude-haiku-4-5-20251001":{"inputTokens":898,"outputTokens":14,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.000968,"contextWindow":200000,"canonicalModel":"claude-haiku-4-5"},
			"claude-opus-5[1m]":{"inputTokens":2,"outputTokens":3,"cacheReadInputTokens":12117,"cacheCreationInputTokens":3577,"costUSD":0.0419,"contextWindow":1000000,"canonicalModel":"claude-opus-5"}},
		"total_cost_usd":0.042868}`

	got := observeFrames(t, initFrame, assistantFrame(2, 15694, 36), firstResultFrame, compactResultFrame)

	if len(got) != 2 {
		t.Fatalf("got %d reports, want one per result frame", len(got))
	}
	if want := int64(2 + 36 + 15694); got[1].ContextTokens != want {
		t.Errorf("context tokens = %d, want the last measurement %d", got[1].ContextTokens, want)
	}
}

// An assistant frame that carries no usage measured nothing, so it must not be
// read as "the conversation is now empty" and overwrite the frame that did
// measure something. Unlike the store's guard on the same value
// (session/usage.go), this one protects the reading for the rest of the process,
// not just the one report — every later result would report the zero too.
//
// The frame is constructed rather than captured: no such frame was seen on
// claude 2.1.263. It pins what the guard promises, not a claim about the CLI.
func TestUsageObserverIgnoresAssistantFrameWithoutUsage(t *testing.T) {
	noUsage := `{"type":"assistant","parent_tool_use_id":null,"message":{"model":"claude-opus-5","content":[]}}`

	got := observeFrames(t, initFrame, assistantFrame(2, 15694, 36), noUsage, secondResultFrame)
	if len(got) != 1 {
		t.Fatalf("got %d reports, want 1", len(got))
	}
	if want := int64(2 + 36 + 15694); got[0].ContextTokens != want {
		t.Errorf("context tokens = %d, want the last real measurement %d", got[0].ContextTokens, want)
	}
}
