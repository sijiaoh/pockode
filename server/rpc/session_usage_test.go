package rpc

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

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

	row, err := json.Marshal(NewSessionListItem(meta))
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

// The row's whole account of what a session is doing is its turn. The two
// fields it replaced were a lossy view of that same state, and one of them —
// the process state — was volatile, so a row could contradict the session it
// was drawn from.
func TestSessionListItemCarriesTheTurn(t *testing.T) {
	raised := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	meta := session.SessionMeta{
		ID: "sess-1",
		Turn: session.TurnState{
			Phase: session.PhaseBlocked,
			Open:  true,
			Blockers: []session.Blocker{
				{Kind: session.BlockerQuestion, RequestID: "req-7", RaisedAt: raised},
			},
			Since: raised,
		},
	}

	row, err := json.Marshal(NewSessionListItem(meta))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// The request id is what the chat's blocker strip jumps to the card with, so
	// it has to survive the narrowing.
	for _, wanted := range []string{`"phase":"blocked"`, `"kind":"question"`, `"request_id":"req-7"`} {
		if !strings.Contains(string(row), wanted) {
			t.Errorf("list row is missing %s: %s", wanted, row)
		}
	}
	for _, gone := range []string{`"state"`, `"needs_input"`} {
		if strings.Contains(string(row), gone) {
			t.Errorf("list row still carries %s: %s", gone, row)
		}
	}
}
