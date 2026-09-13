package rpc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/session"
)

// A session's consumption is detail-only. The list goes to every subscriber on
// every change, and these numbers change on every turn of every session, so
// carrying them there would turn each metered turn into a broadcast to clients
// reading something else.
func TestSessionListItemCarriesNoUsage(t *testing.T) {
	meta := session.SessionMeta{
		ID:    "sess-1",
		Title: "Some chat",
		Usage: session.Usage{
			TokenUsage:    session.TokenUsage{InputTokens: 1234, OutputTokens: 56},
			ContextTokens: 9000,
			ContextWindow: 200000,
		},
	}

	row, err := json.Marshal(NewSessionListItem(meta, "idle"))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, unwanted := range []string{"usage", "input_tokens", "output_tokens", "cost_usd", "context_window"} {
		if strings.Contains(string(row), unwanted) {
			t.Errorf("list row mentions %q: %s", unwanted, row)
		}
	}
}

// The detail subscription carries the whole of SessionMeta, which is how the
// frontend gets the numbers at all — and, because the store notifies on every
// change, how it gets them live.
func TestSessionDetailCarriesUsage(t *testing.T) {
	cost := 0.5
	result, err := json.Marshal(SessionDetailSubscribeResult{Session: session.SessionMeta{
		ID: "sess-1",
		Usage: session.Usage{
			TokenUsage:    session.TokenUsage{InputTokens: 1234, OutputTokens: 56},
			CostUSD:       &cost,
			ContextTokens: 9000,
			ContextWindow: 200000,
		},
	}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, want := range []string{"input_tokens", "output_tokens", "cost_usd", "context_tokens", "context_window"} {
		if !strings.Contains(string(result), want) {
			t.Errorf("detail result is missing %q: %s", want, result)
		}
	}
}
