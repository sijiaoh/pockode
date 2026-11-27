package process

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/session"
)

// A plan is said inside a turn already shown to have reached the model, so it
// keeps the turn alive and nothing more: it must not end a background wait.
func TestTurnInputFor_PlanIsNoise(t *testing.T) {
	in, ok := turnInputFor(agent.PlanEvent{ToolUseID: "toolu_1"})
	if !ok || in.Signal != session.SignalNoise {
		t.Errorf("signal = %q (ok=%v), want %q", in.Signal, ok, session.SignalNoise)
	}
}

// A new process can read the plan the session's history last recorded, so the
// CLI's task list, which outlives the process, can be followed from the first
// update on.
func TestManager_SeedsThePlanFromHistory(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	var seed func(context.Context) []agent.PlanStep
	mock := &mockAgent{startErr: func(opts agent.StartOptions) error {
		seed = opts.PlanSeed
		return nil
	}}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	// A session that never started has nothing to read.
	if _, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "fresh")); err != nil {
		t.Fatal(err)
	}
	if seed != nil {
		t.Error("a session that never started was handed a seed")
	}

	meta := createActivatedSession(t, store, "sess-1")
	steps := []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepInProgress}}
	for _, record := range []agent.EventRecord{
		agent.PlanEvent{ToolUseID: "toolu_0", Steps: []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepPending}}}.ToRecord(),
		agent.PlanEvent{ToolUseID: "toolu_1", Steps: steps}.ToRecord(),
		agent.TextEvent{Content: "done"}.ToRecord(),
	} {
		if _, err := store.AppendToHistory(context.Background(), "sess-1", record); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := m.GetOrCreateProcess(context.Background(), meta); err != nil {
		t.Fatal(err)
	}
	if seed == nil {
		t.Fatal("a resumed session was handed no seed")
	}
	if got := seed(context.Background()); !reflect.DeepEqual(got, steps) {
		t.Errorf("seed = %+v, want %+v", got, steps)
	}
}

// The seed waits for the session's previous process to finish: one taken out
// of the map is still writing its history, and its last plan is the one the
// new process needs.
func TestManager_PlanSeedWaitsForThePreviousProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	var seed func(context.Context) []agent.PlanStep
	gate := make(chan struct{})
	mock := &mockAgent{exitGate: gate, startErr: func(opts agent.StartOptions) error {
		seed = opts.PlanSeed
		return nil
	}}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()

	meta := createActivatedSession(t, store, "sess-1")
	if _, _, err := m.GetOrCreateProcess(context.Background(), meta); err != nil {
		t.Fatal(err)
	}
	go m.Close("sess-1")
	waitUntil(t, "the process to leave the map", func() bool {
		m.processesMu.Lock()
		defer m.processesMu.Unlock()
		_, running := m.processes["sess-1"]
		return !running
	})
	if _, _, err := m.GetOrCreateProcess(context.Background(), meta); err != nil {
		t.Fatal(err)
	}

	got := make(chan []agent.PlanStep, 1)
	go func() { got <- seed(context.Background()) }()
	select {
	case steps := <-got:
		t.Fatalf("seed = %+v before the previous process ended", steps)
	case <-time.After(50 * time.Millisecond):
	}

	// The previous process's last plan, written as it drains.
	steps := []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepCompleted}}
	if _, err := store.AppendToHistory(context.Background(), "sess-1", agent.PlanEvent{ToolUseID: "toolu_1", Steps: steps}.ToRecord()); err != nil {
		t.Fatal(err)
	}
	close(gate)
	select {
	case seeded := <-got:
		if !reflect.DeepEqual(seeded, steps) {
			t.Errorf("seed = %+v, want %+v", seeded, steps)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the seed never returned")
	}
}

// A process closed before its agent read the seed is in the manager's exiting
// set by then, and its stream cannot end until the seed returns: the seed must
// not wait for the process it belongs to.
func TestManager_PlanSeedNeverWaitsForItsOwnProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	var seed func(context.Context) []agent.PlanStep
	gate := make(chan struct{})
	mock := &mockAgent{exitGate: gate, startErr: func(opts agent.StartOptions) error {
		seed = opts.PlanSeed
		return nil
	}}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()
	defer close(gate)

	if _, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1")); err != nil {
		t.Fatal(err)
	}
	go m.Close("sess-1")
	waitUntil(t, "the process to be exiting", func() bool {
		m.processesMu.Lock()
		defer m.processesMu.Unlock()
		return len(m.exiting) == 1
	})

	got := make(chan struct{})
	go func() {
		seed(context.Background())
		close(got)
	}()
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("the seed waited for its own process")
	}
}

// A previous process slow to exit costs only the seed: the new process reads
// none of its output until the seed returns.
func TestManager_PlanSeedGivesUpOnASlowPreviousProcess(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	var seed func(context.Context) []agent.PlanStep
	gate := make(chan struct{})
	mock := &mockAgent{exitGate: gate, startErr: func(opts agent.StartOptions) error {
		seed = opts.PlanSeed
		return nil
	}}
	m := NewManager(mockRegistry(mock), "", "/tmp", "", "", store, idleOnly(10*time.Minute))
	defer m.Shutdown()
	defer close(gate)
	m.planSeedWait = 20 * time.Millisecond

	meta := createActivatedSession(t, store, "sess-1")
	if _, _, err := m.GetOrCreateProcess(context.Background(), meta); err != nil {
		t.Fatal(err)
	}
	go m.Close("sess-1")
	waitUntil(t, "the process to leave the map", func() bool {
		m.processesMu.Lock()
		defer m.processesMu.Unlock()
		_, running := m.processes["sess-1"]
		return !running
	})
	steps := []agent.PlanStep{{ID: "1", Text: "A", Status: agent.PlanStepPending}}
	if _, err := store.AppendToHistory(context.Background(), "sess-1", agent.PlanEvent{ToolUseID: "toolu_1", Steps: steps}.ToRecord()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := m.GetOrCreateProcess(context.Background(), meta); err != nil {
		t.Fatal(err)
	}

	got := make(chan []agent.PlanStep, 1)
	go func() { got <- seed(context.Background()) }()
	select {
	case seeded := <-got:
		if seeded != nil {
			t.Errorf("seed = %+v, want none while the previous process is still exiting", seeded)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the seed kept waiting for the previous process")
	}
}
