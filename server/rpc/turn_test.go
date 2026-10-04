package rpc

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/pockode/server/session"
)

// The wire carries how long the turn has been open, never the instant it opened:
// a client counting from a server timestamp would be trusting its own clock.
func TestTurnCarriesAReadingNotAnInstant(t *testing.T) {
	opened := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	state := session.TurnState{Phase: session.PhaseBlocked, Open: true, OpenedAt: opened, Since: opened.Add(time.Minute)}

	got := decodeTurn(t, NewTurn(state, opened.Add(64*time.Second)))

	if got["open_elapsed_ms"] != float64(64000) {
		t.Fatalf("open_elapsed_ms = %v, want 64000 — counted from the turn, not the phase", got["open_elapsed_ms"])
	}
	if _, leaked := got["opened_at"]; leaked {
		t.Fatal("opened_at reached the wire")
	}
	if got["phase"] != "blocked" {
		t.Fatalf("phase = %v, want the embedded state alongside the reading", got["phase"])
	}
}

func TestTurnWithNoOpenTurnHasNoReading(t *testing.T) {
	now := time.Date(2026, 10, 4, 12, 0, 0, 0, time.UTC)
	got := decodeTurn(t, NewTurn(session.NewTurnState(now), now))

	if _, ok := got["open_elapsed_ms"]; ok {
		t.Fatalf("open_elapsed_ms = %v on an idle turn, want absent", got["open_elapsed_ms"])
	}
}

// SessionDetail embeds SessionMeta, whose own Turn would otherwise go out raw.
func TestSessionDetailSendsTheWireTurn(t *testing.T) {
	meta := session.SessionMeta{ID: "s", Turn: session.TurnState{
		Phase: session.PhaseRunning, Open: true, OpenedAt: time.Now().Add(-time.Hour),
	}}

	data, err := json.Marshal(NewSessionDetail(meta, ""))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var detail struct {
		Turn map[string]any `json:"turn"`
	}
	if err := json.Unmarshal(data, &detail); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := detail.Turn["open_elapsed_ms"]; !ok {
		t.Fatalf("detail turn = %v, want open_elapsed_ms", detail.Turn)
	}
	if _, leaked := detail.Turn["opened_at"]; leaked {
		t.Fatal("opened_at reached the wire")
	}
}

func decodeTurn(t *testing.T, turn Turn) map[string]any {
	t.Helper()
	data, err := json.Marshal(turn)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return got
}
