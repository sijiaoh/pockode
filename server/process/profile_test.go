package process

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/cliprofile"
	"github.com/pockode/server/session"
)

// lastStart is the most recent start the mock agent saw.
func (m *mockAgent) lastStart(t *testing.T) startCall {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.startCalls) == 0 {
		t.Fatal("no agent was started")
	}
	return m.startCalls[len(m.startCalls)-1]
}

func (m *mockAgent) startCount() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.startCalls)
}

// A process is started as the profile current at the time, named explicitly so
// that what it records is what the CLI was started as.
func TestManager_StartsAsTheCurrentProfile(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()

	proc, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if got := proc.ProfileID(); got != "A" {
		t.Errorf("ProfileID = %q, want A", got)
	}
	if got := mock.lastStart(t).profile; got != cliprofile.Select("A") {
		t.Errorf("started with %+v, want profile A named explicitly", got)
	}
}

// Choosing another account moves an idle session to it on its next message:
// the old CLI is stopped first and a successor resumes the conversation as the
// current profile.
func TestManager_ReplacesAnIdleProcessOnAnotherProfile(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	meta := createActivatedSession(t, store, "sess-1")
	old, _, err := m.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	oldSession := mock.session(t, "sess-1")

	mock.setProfile("B")
	proc, created, err := m.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess after the switch: %v", err)
	}
	if !created || proc == old {
		t.Fatal("expected a new process for the newly current profile")
	}
	if !oldSession.isClosed() {
		t.Error("the old process was not stopped")
	}
	select {
	case <-old.done:
	default:
		t.Error("the successor started before the old process had ended")
	}
	start := mock.lastStart(t)
	if start.profile != cliprofile.Select("B") || !start.resume {
		t.Errorf("successor started with profile %+v, resume %v; want B, resumed", start.profile, start.resume)
	}
	if got := proc.ProfileID(); got != "B" {
		t.Errorf("ProfileID = %q, want B", got)
	}
	if m.GetProcess("sess-1") != proc {
		t.Error("the successor is not the session's process")
	}
	if _, err := old.SendMessage(agent.Prompt{Text: "late"}); !errors.Is(err, ErrProcessReplaced) {
		t.Errorf("a message handed to the replaced process = %v, want ErrProcessReplaced", err)
	}
}

// A turn in progress is never cut off by a switch — running, waiting on a
// permission answer, or parked on background work: the process is used as it
// is for this message.
func TestManager_KeepsAProcessMidTurnOnAnotherProfile(t *testing.T) {
	tests := []struct {
		name    string
		blocker agent.AgentEvent
		holds   func(session.TurnState) bool
	}{
		{"running", nil, session.TurnState.InProgress},
		{"awaiting permission", agent.PermissionRequestEvent{RequestID: "req-1", ToolName: "Bash"}, session.TurnState.AwaitingUserAnswer},
		{"background wait", agent.BackgroundWaitEvent{}, session.TurnState.WaitingForBackground},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{profile: "A"}
			m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
			defer m.Shutdown()
			ctx := context.Background()

			meta := createActivatedSession(t, store, "sess-1")
			old, _, err := m.GetOrCreateProcess(ctx, meta)
			if err != nil {
				t.Fatalf("GetOrCreateProcess: %v", err)
			}
			sess := mock.session(t, "sess-1")
			startTurn(t, old)
			if tt.blocker != nil {
				sess.emit(t, tt.blocker)
			}
			waitFor(t, func() bool { return tt.holds(old.turnState()) })

			mock.setProfile("B")
			proc, created, err := m.GetOrCreateProcess(ctx, meta)
			if err != nil {
				t.Fatalf("GetOrCreateProcess mid-turn: %v", err)
			}
			if created || proc != old || sess.isClosed() {
				t.Fatal("a process mid-turn was replaced")
			}
		})
	}
}

// Once the turn is over, the next message moves the session to the current
// profile.
func TestManager_ReplacesAfterTheTurnIsOver(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	meta := createActivatedSession(t, store, "sess-1")
	old, _, err := m.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	sess := mock.session(t, "sess-1")
	startTurn(t, old)
	mock.setProfile("B")
	// The message the kept process was fetched for joins the turn.
	if proc, _, err := m.GetOrCreateProcess(ctx, meta); err != nil || proc != old {
		t.Fatalf("mid-turn fetch = %p, %v; want the running process", proc, err)
	}
	startTurn(t, old)

	sess.emit(t, agent.DoneEvent{})
	waitFor(t, func() bool { return !old.turnState().InProgress() })

	proc, created, err := m.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess after the turn: %v", err)
	}
	if !created || proc == old || proc.ProfileID() != "B" {
		t.Errorf("after the turn ended: created %v, same process %v, profile %q; want a new process as B",
			created, proc == old, proc.ProfileID())
	}
}

// While a replaced CLI is still exiting, nothing starts its successor beside
// it — not another sender, and not the idle reaper taking the replaced process
// out of the map, which an idle process near the end of its budget invites.
func TestManager_OneCLIAtATimeWhileReplacing(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	gate := make(chan struct{})
	mock := &mockAgent{profile: "A", exitGate: gate}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()
	defer func() {
		select {
		case <-gate:
		default:
			close(gate)
		}
	}()
	ctx := context.Background()

	meta := createActivatedSession(t, store, "sess-1")
	old, _, err := m.GetOrCreateProcess(ctx, meta)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	mock.setProfile("B")

	type fetched struct {
		proc *Process
		err  error
	}
	results := make(chan fetched, 2)
	fetch := func() {
		proc, _, err := m.GetOrCreateProcess(ctx, meta)
		results <- fetched{proc, err}
	}
	go fetch()
	waitFor(t, old.closed.Load)

	m.reapLeasesAsOf(time.Now().Add(time.Hour))
	go fetch()
	if m.GetProcess("sess-1") != old {
		t.Error("the replaced process left the map before its CLI exited")
	}
	select {
	case r := <-results:
		t.Fatalf("a fetch returned (%p, %v) before the replaced CLI exited", r.proc, r.err)
	case <-time.After(50 * time.Millisecond):
	}
	if n := mock.startCount(); n != 1 {
		t.Fatalf("%d CLIs started while the replaced one was still exiting, want 1", n)
	}

	close(gate)
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("fetches failed: %v, %v", first.err, second.err)
	}
	if first.proc != second.proc || first.proc.ProfileID() != "B" {
		t.Error("the two fetches did not get the one successor as B")
	}
	if n := mock.startCount(); n != 2 {
		t.Errorf("%d CLIs started in all, want 2", n)
	}
}

// The current profile that cannot be read fails the fetch rather than run the
// user's work on an account nobody can say they chose.
func TestManager_CurrentProfileUnreadable(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profileErr: errors.New("disk on fire")}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1")); err == nil {
		t.Fatal("expected an error")
	}
	if n := mock.startCount(); n != 0 {
		t.Errorf("%d agents started, want none", n)
	}
}

// A profile is released from every idle process running as it, once their
// CLIs have exited; one mid-turn is left alone and reported, and so is
// released by a later call once its turn is over. Processes on another profile
// are not touched.
func TestManager_ReleaseProfile(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()
	ctx := context.Background()

	fetch := func(id string) *Process {
		t.Helper()
		proc, _, err := m.GetOrCreateProcess(ctx, createActivatedSession(t, store, id))
		if err != nil {
			t.Fatalf("GetOrCreateProcess %s: %v", id, err)
		}
		return proc
	}
	idle, running := fetch("idle"), fetch("running")
	startTurn(t, running)
	mock.setProfile("B")
	other := fetch("other")

	busy, err := m.ReleaseProfile(ctx, session.AgentTypeClaude, "A")
	if err != nil {
		t.Fatalf("ReleaseProfile: %v", err)
	}
	if len(busy) != 1 || busy[0] != "running" {
		t.Errorf("busy = %v, want [running]", busy)
	}
	select {
	case <-idle.done:
	default:
		t.Error("ReleaseProfile returned before the idle process had ended")
	}
	if m.GetProcess("running") != running || mock.session(t, "running").isClosed() {
		t.Error("the process mid-turn was stopped")
	}
	if m.GetProcess("other") != other || mock.session(t, "other").isClosed() {
		t.Error("a process on another profile was stopped")
	}
	if _, err := idle.SendMessage(agent.Prompt{Text: "late"}); !errors.Is(err, ErrProcessReplaced) {
		t.Errorf("a message racing the release = %v, want ErrProcessReplaced to go to a successor", err)
	}

	mock.session(t, "running").emit(t, agent.DoneEvent{})
	waitFor(t, func() bool { return !running.turnState().InProgress() })
	if busy, err := m.ReleaseProfile(ctx, session.AgentTypeClaude, "A"); err != nil || len(busy) != 0 {
		t.Fatalf("ReleaseProfile after the turn = %v, %v; want nothing left", busy, err)
	}
	if n := mock.startCount(); n != 3 {
		t.Errorf("%d CLIs started in all, want 3: releasing starts nothing", n)
	}
}

// ReleaseProfile stands for "no CLI runs as it any more", so it waits for a
// stopped CLI to exit — for as long as its caller lets it.
func TestManager_ReleaseProfileWaitsForTheCLI(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	gate := make(chan struct{})
	mock := &mockAgent{profile: "A", exitGate: gate}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()

	exited := sync.OnceFunc(func() { close(gate) })
	defer exited()

	proc, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	mock.setProfile("B")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := m.ReleaseProfile(ctx, session.AgentTypeClaude, "A"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ReleaseProfile while the CLI is exiting = %v, want the deadline", err)
	}
	exited()
	// Already stopped: a second call has only to wait it out.
	if busy, err := m.ReleaseProfile(context.Background(), session.AgentTypeClaude, "A"); err != nil || len(busy) != 0 {
		t.Fatalf("ReleaseProfile = %v, %v; want nothing left", busy, err)
	}
	select {
	case <-proc.done:
	default:
		t.Error("ReleaseProfile returned before the CLI had exited")
	}
}

// A fetch that read the current profile before a switch does not start a
// process as the old one: the profile is read again where the process starts.
// That this second read is under processesMu, the lock ReleaseProfile looks
// under, is what keeps a released profile from gaining a process; this test
// cannot tell where the read is, only that it is the one used.
func TestManager_StartsAsTheProfileCurrentAtTheStart(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	mock.afterProfileRead = func() {
		mock.setProfile("B")
	}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()

	proc, _, err := m.GetOrCreateProcess(context.Background(), createSession(t, store, "sess-1"))
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if proc.ProfileID() != "B" || mock.lastStart(t).profile != cliprofile.Select("B") {
		t.Errorf("started as %q, want B: the profile current when the CLI starts", proc.ProfileID())
	}
}

// A process already taken out of the map — here by the idle lease — no longer
// belongs to its session, but its CLI may still be running as the profile:
// releasing waits for it all the same.
func TestManager_ReleaseProfileWaitsForAProcessAlreadyClosing(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	gate := make(chan struct{})
	mock := &mockAgent{profile: "A", exitGate: gate}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()
	exited := sync.OnceFunc(func() { close(gate) })
	defer exited()

	if _, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1")); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	m.reapLeasesAsOf(time.Now().Add(time.Hour))
	if m.GetProcess("sess-1") != nil {
		t.Fatal("the idle lease did not collect the process")
	}
	mock.setProfile("B")

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := m.ReleaseProfile(ctx, session.AgentTypeClaude, "A"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("ReleaseProfile while a collected CLI is exiting = %v, want the deadline", err)
	}
	exited()
	if busy, err := m.ReleaseProfile(context.Background(), session.AgentTypeClaude, "A"); err != nil || len(busy) != 0 {
		t.Fatalf("ReleaseProfile = %v, %v; want nothing left", busy, err)
	}
}

// The current profile cannot be released: whatever was stopped would come
// back as it on the next message.
func TestManager_ReleaseProfileRefusesTheCurrentOne(t *testing.T) {
	store, _ := session.NewFileStore(t.TempDir())
	mock := &mockAgent{profile: "A"}
	m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
	defer m.Shutdown()

	if _, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1")); err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	if _, err := m.ReleaseProfile(context.Background(), session.AgentTypeClaude, "A"); !errors.Is(err, ErrProfileCurrent) {
		t.Fatalf("ReleaseProfile of the current profile = %v, want ErrProfileCurrent", err)
	}
	if mock.session(t, "sess-1").isClosed() {
		t.Error("a process was stopped for a refused release")
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(awaitTimeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("condition never held")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A credentials refusal and a usage limit are recorded with the account the
// process's CLI was started as — "" for the default one, written out so that it
// reads apart from a record kept before accounts were recorded — and keep it
// after the current account has changed.
func TestProcess_RecordsTheAccountOnAuthAndLimitRecords(t *testing.T) {
	for _, profile := range []string{"A", ""} {
		t.Run("profile "+strconv.Quote(profile), func(t *testing.T) {
			store, _ := session.NewFileStore(t.TempDir())
			mock := &mockAgent{profile: profile}
			m := NewManager(mockRegistry(mock), "", t.TempDir(), "", "", store, idleOnly(time.Minute))
			defer m.Shutdown()

			proc, _, err := m.GetOrCreateProcess(context.Background(), createActivatedSession(t, store, "sess-1"))
			if err != nil {
				t.Fatalf("GetOrCreateProcess: %v", err)
			}
			sess := mock.session(t, "sess-1")
			startTurn(t, proc)
			mock.setProfile("B")
			sess.emit(t, agent.WarningEvent{Message: "retrying", AuthFailure: &agent.AuthFailure{Agent: session.AgentTypeClaude}})
			sess.emit(t, agent.WarningEvent{Message: "hit your limit", UsageLimit: &agent.UsageLimit{Agent: session.AgentTypeClaude}})
			sess.emit(t, agent.ErrorEvent{Error: "failed", UsageLimit: &agent.UsageLimit{Agent: session.AgentTypeCodex}})
			sess.emit(t, agent.WarningEvent{Message: "unrelated"})
			waitForHistory(t, store, "sess-1", 4)

			records, err := store.GetHistory(context.Background(), "sess-1")
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, raw := range records {
				var rec struct {
					Type        agent.EventType            `json:"type"`
					AuthFailure map[string]json.RawMessage `json:"auth_failure"`
					UsageLimit  map[string]json.RawMessage `json:"usage_limit"`
				}
				if err := json.Unmarshal(raw, &rec); err != nil {
					t.Fatal(err)
				}
				if rec.Type != agent.EventTypeWarning && rec.Type != agent.EventTypeError {
					continue
				}
				got = append(got, string(rec.AuthFailure["profile_id"])+"|"+string(rec.UsageLimit["profile_id"]))
			}
			id := strconv.Quote(profile)
			want := []string{id + "|", "|" + id, "|" + id, "|"}
			if !slices.Equal(got, want) {
				t.Errorf("auth_failure|usage_limit profile_id per record = %q, want %q", got, want)
			}
		})
	}
}
