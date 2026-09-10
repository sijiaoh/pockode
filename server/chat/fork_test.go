package chat

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// forkingAgent is a mockAgent that declares it can be forked and carries its own
// context across, recording what it was asked for. A real agent writes
// session-scoped state here.
type forkingAgent struct {
	mockAgent
	// support defaults to agent.ForkFromAnyMessage. These tests are about what a
	// fork does once the agent's declaration has let it through, so the declaration
	// is only spelled out where it is the subject.
	support agent.ForkSupport
	carried bool
	err     error
	opts    agent.ForkOptions
}

func (a *forkingAgent) ForkSupport() agent.ForkSupport {
	if a.support == "" {
		return agent.ForkFromAnyMessage
	}
	return a.support
}

func (a *forkingAgent) ForkSession(_ context.Context, opts agent.ForkOptions) (bool, error) {
	a.opts = opts
	return a.carried, a.err
}

// forkFixture is a store holding one source session, plus the manager whose
// registered agent decides what happens on the agent side of a fork.
type forkFixture struct {
	store  session.Store
	client *Client
	// seqs holds the sequence number the store gave each appended record, which is
	// what a client would have been told and is all it may quote back.
	seqs []session.HistorySeq
}

// newForkFixture registers ag for claude sessions; a nil ag registers the plain
// mockAgent, which declares that it cannot be forked at all.
func newForkFixture(t *testing.T, ag *forkingAgent, history []agent.EventRecord) forkFixture {
	t.Helper()

	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	registry := agent.NewRegistry()
	if ag != nil {
		registry.Register(session.AgentTypeClaude, ag)
	} else {
		registry.Register(session.AgentTypeClaude, mockAgent{forkSupport: agent.ForkUnsupported})
	}
	pm := process.NewManager(registry, t.TempDir(), t.TempDir(), "", store, time.Minute)
	t.Cleanup(pm.Shutdown)

	ctx := context.Background()
	if _, err := store.Create(ctx, "source", session.AgentTypeClaude, session.ModeYolo); err != nil {
		t.Fatalf("Create session: %v", err)
	}
	if err := store.Update(ctx, "source", "Fix the parser"); err != nil {
		t.Fatalf("Update title: %v", err)
	}
	var seqs []session.HistorySeq
	for _, rec := range history {
		seq, err := store.AppendToHistory(ctx, "source", rec)
		if err != nil {
			t.Fatalf("AppendToHistory: %v", err)
		}
		seqs = append(seqs, seq)
	}

	return forkFixture{store: store, client: NewClient(store, pm), seqs: seqs}
}

func forkedHistory(t *testing.T, store session.Store, sessionID string) []agent.EventRecord {
	t.Helper()

	raw, err := store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}

	records := make([]agent.EventRecord, len(raw))
	for i, line := range raw {
		if err := json.Unmarshal(line, &records[i]); err != nil {
			t.Fatalf("record %d does not parse: %v", i, err)
		}
	}
	return records
}

// TestFork_CopiesConversationAndMeta is the contract a fork is for: a separate
// session that reads as the source did up to the fork point, on the same agent
// and in the same mode, with nothing after the fork point carried over.
func TestFork_CopiesConversationAndMeta(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: true}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
		{Type: agent.EventTypeDone},
		{Type: agent.EventTypeMessage, Content: "second"},
		{Type: agent.EventTypeText, Content: "answering second"},
	})

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[2], "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	if meta.ID == "source" {
		t.Fatal("fork reused the source session's ID")
	}
	if meta.Title != "Fix the parser" {
		t.Errorf("title = %q, want the source's", meta.Title)
	}
	if meta.AgentType != session.AgentTypeClaude || meta.Mode != session.ModeYolo {
		t.Errorf("agentType/mode = %q/%q, want claude/yolo", meta.AgentType, meta.Mode)
	}
	// The copied history holds the agent's output, so the fork is a session that
	// has already run: switching its agent type would throw that context away.
	if !meta.Activated {
		t.Error("forked session is not activated despite holding agent output")
	}

	got := forkedHistory(t, f.store, meta.ID)
	want := []agent.EventType{agent.EventTypeMessage, agent.EventTypeText, agent.EventTypeDone}
	if len(got) != len(want) {
		t.Fatalf("copied %d records, want %d: %+v", len(got), len(want), got)
	}
	for i, rec := range got {
		if rec.Type != want[i] {
			t.Errorf("record %d is %q, want %q", i, rec.Type, want[i])
		}
	}
	if got[1].Content != "answering first" {
		t.Errorf("record 1 content = %q, want the source's", got[1].Content)
	}

	if meta.ForkedFrom == nil || meta.ForkedFrom.SessionID != "source" {
		t.Errorf("forkedFrom = %+v, want the source's ID", meta.ForkedFrom)
	}

	// The source is left exactly as it was: a fork is not a rewrite.
	if source := forkedHistory(t, f.store, "source"); len(source) != 5 {
		t.Errorf("source history has %d records, want 5 untouched", len(source))
	}
}

// TestFork_TellsAgentWhereTheCutIs pins the hand-off the per-agent fork tasks
// build on: the agent is asked after the session and its history exist, and is
// told whether context past the fork point has to be left behind.
func TestFork_TellsAgentWhereTheCutIs(t *testing.T) {
	tests := []struct {
		name          string
		anchor        int // index into the fixture's history
		wantTruncated bool
	}{
		{name: "cut inside the conversation", anchor: 0, wantTruncated: true},
		{name: "cut at the last record", anchor: 1, wantTruncated: false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ag := &forkingAgent{carried: true}
			f := newForkFixture(t, ag, []agent.EventRecord{
				{Type: agent.EventTypeMessage, Content: "first"},
				{Type: agent.EventTypeText, Content: "answering first"},
			})

			meta, err := f.client.Fork(context.Background(), "source", f.seqs[tt.anchor], "")
			if err != nil {
				t.Fatalf("Fork: %v", err)
			}

			if ag.opts.SourceSessionID != "source" || ag.opts.SessionID != meta.ID {
				t.Errorf("agent got source/new %q/%q, want source/%q",
					ag.opts.SourceSessionID, ag.opts.SessionID, meta.ID)
			}
			if ag.opts.Truncated != tt.wantTruncated {
				t.Errorf("Truncated = %v, want %v", ag.opts.Truncated, tt.wantTruncated)
			}
			if len(ag.opts.History) != tt.anchor+1 {
				t.Errorf("agent got %d records, want %d", len(ag.opts.History), tt.anchor+1)
			}
			if ag.opts.DataDir == "" || ag.opts.WorkDir == "" {
				t.Error("agent was not told where the session's directories are")
			}
		})
	}
}

// TestFork_WarnsWhenTheAgentWillNotRemember: the user is about to talk to an
// agent that remembers none of the history shown above the input box, and
// nothing else says so. This is the agent that can be forked but could not carry
// its context *this time* — one that cannot be forked at all never gets here
// (TestFork_RefusedWhenTheAgentCannotBeForked).
func TestFork_WarnsWhenTheAgentWillNotRemember(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: false}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
	})

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[1], "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	history := forkedHistory(t, f.store, meta.ID)
	last := history[len(history)-1]
	if last.Type != agent.EventTypeWarning {
		t.Fatalf("history ends with %q, want a warning: %+v", last.Type, history)
	}
	if last.Code != "fork_agent_context_unavailable" {
		t.Errorf("warning code = %q, want fork_agent_context_unavailable", last.Code)
	}
	if !strings.Contains(last.Message, "Claude") {
		t.Errorf("warning = %q, want it to name the agent", last.Message)
	}
}

// TestFork_RefusedWhenTheAgentCannotBeForked: an agent declaring
// agent.ForkUnsupported cannot reopen a conversation at any point in it, so a
// fork of its session could only ever produce one whose agent has never seen the
// transcript filling the screen. Refused outright rather than made with a warning
// on it — session.fork must not claim to do something it does not do — and the
// refusal has to name the agent, because the sheet shows it to the user as-is.
//
// Asked of the capability, not of a particular agent: whichever agent declares
// this is the one this applies to.
func TestFork_RefusedWhenTheAgentCannotBeForked(t *testing.T) {
	f := newForkFixture(t, nil, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
	})

	_, err := f.client.Fork(context.Background(), "source", f.seqs[1], "")
	if !errors.Is(err, ErrForkUnsupported) {
		t.Fatalf("error = %v, want ErrForkUnsupported", err)
	}
	if !strings.Contains(err.Error(), "Claude") {
		t.Errorf("error = %q, want it to name the agent that cannot be forked", err)
	}

	// Nothing half-made: the refusal comes before the session is created, so the
	// user is not left with an empty session wearing the source's title.
	sessions, listErr := f.store.List()
	if listErr != nil {
		t.Fatalf("List: %v", listErr)
	}
	if len(sessions) != 1 {
		t.Errorf("sessions = %+v, want only the source", sessions)
	}
}

// TestFork_OfferedWhateverTheAnchorWhenTheAgentCanFork: an agent that can fork
// is offered a fork from the middle too — the fork keeps Pockode's transcript
// either way, and the agent says per fork what it could carry. Only
// ForkUnsupported closes the door.
func TestFork_OfferedWhateverTheAnchorWhenTheAgentCanFork(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{support: agent.ForkFromAnyMessage}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
		{Type: agent.EventTypeMessage, Content: "second"},
	})

	if _, err := f.client.Fork(context.Background(), "source", f.seqs[1], ""); err != nil {
		t.Fatalf("Fork from the middle: %v", err)
	}
}

// TestFork_SaysNothingWhenTheAgentRemembers: an agent that carried its context
// across has nothing to warn about, and a warning there would train the user to
// ignore the one that matters.
func TestFork_SaysNothingWhenTheAgentRemembers(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: true}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
	})

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[1], "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	for _, rec := range forkedHistory(t, f.store, meta.ID) {
		if rec.Type == agent.EventTypeWarning {
			t.Errorf("history holds a warning it should not: %q", rec.Message)
		}
	}
}

// TestFork_AgentFailureLeavesNoSession: a session wearing the source's title with
// half a fork inside it is worse than no session at all.
func TestFork_AgentFailureLeavesNoSession(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{err: errors.New("no transcript to fork")}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
	})

	if _, err := f.client.Fork(context.Background(), "source", f.seqs[0], ""); err == nil {
		t.Fatal("Fork succeeded despite the agent failing")
	}

	sessions, err := f.store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "source" {
		t.Errorf("sessions = %+v, want only the source", sessions)
	}
}

// TestFork_RejectedRequests covers the states a fork cannot be made from. Each
// error has to name what was wrong: the client shows it to the user as-is.
func TestFork_RejectedRequests(t *testing.T) {
	history := []agent.EventRecord{{Type: agent.EventTypeMessage, Content: "first"}}

	tests := []struct {
		name      string
		sessionID string
		anchor    session.HistorySeq
		want      error
	}{
		{name: "unknown session", sessionID: "nope", anchor: 1, want: ErrSessionNotFound},
		{name: "anchor past the end", sessionID: "source", anchor: 2, want: ErrForkAnchorOutOfRange},
		// What a client that never received a seq would send.
		{name: "no anchor at all", sessionID: "source", anchor: session.NoHistorySeq, want: ErrForkAnchorOutOfRange},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newForkFixture(t, &forkingAgent{carried: true}, history)

			_, err := f.client.Fork(context.Background(), tt.sessionID, tt.anchor, "")
			if !errors.Is(err, tt.want) {
				t.Fatalf("error = %v, want %v", err, tt.want)
			}

			sessions, listErr := f.store.List()
			if listErr != nil {
				t.Fatalf("List: %v", listErr)
			}
			if len(sessions) != 1 {
				t.Errorf("sessions = %+v, want only the source", sessions)
			}
		})
	}
}

// TestFork_WhileSourceIsRunning: branching off an earlier point while the agent
// works on is the case the feature is wanted for most, so it must not be refused.
// History is append-only, so the copied prefix is final whatever the running turn
// writes next, and the source is left untouched.
func TestFork_WhileSourceIsRunning(t *testing.T) {
	ag := &forkingAgent{carried: true}
	f := newForkFixture(t, ag, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypeText, Content: "answering first"},
		{Type: agent.EventTypeDone},
		{Type: agent.EventTypeMessage, Content: "second"},
	})

	proc, _, err := f.client.pm.GetOrCreateProcess(
		context.Background(), "source", true, session.AgentTypeClaude, session.ModeYolo)
	if err != nil {
		t.Fatalf("GetOrCreateProcess: %v", err)
	}
	proc.SetRunning()

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[2], "")
	if err != nil {
		t.Fatalf("Fork while running: %v", err)
	}

	got := forkedHistory(t, f.store, meta.ID)
	want := []agent.EventType{agent.EventTypeMessage, agent.EventTypeText, agent.EventTypeDone}
	if len(got) != len(want) {
		t.Fatalf("copied %d records, want %d: %+v", len(got), len(want), got)
	}
	for i, rec := range got {
		if rec.Type != want[i] {
			t.Errorf("record %d is %q, want %q", i, rec.Type, want[i])
		}
	}

	// The turn keeps running in the session it was started in, with its own
	// transcript untouched.
	if source := forkedHistory(t, f.store, "source"); len(source) != 4 {
		t.Errorf("source history has %d records, want 4 untouched", len(source))
	}
	if !f.client.pm.HasProcess("source") {
		t.Error("the source's process was closed by forking it")
	}
	if proc.State() != process.ProcessStateRunning {
		t.Errorf("source process state = %q, want it still running", proc.State())
	}
}

// TestFork_TellsAgentWhetherTheSourceIsLive: a live process can grow the source's
// own transcript at any moment, so an agent that resumes it cannot trust the fork
// point it was given. Truncated does not cover this — the anchor here is the last
// record there is.
func TestFork_TellsAgentWhetherTheSourceIsLive(t *testing.T) {
	tests := []struct {
		name     string
		live     bool
		wantLive bool
	}{
		{name: "no process", live: false, wantLive: false},
		{name: "live process", live: true, wantLive: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ag := &forkingAgent{carried: true}
			f := newForkFixture(t, ag, []agent.EventRecord{
				{Type: agent.EventTypeMessage, Content: "first"},
			})

			if tt.live {
				if _, _, err := f.client.pm.GetOrCreateProcess(
					context.Background(), "source", true, session.AgentTypeClaude, session.ModeYolo); err != nil {
					t.Fatalf("GetOrCreateProcess: %v", err)
				}
			}

			if _, err := f.client.Fork(context.Background(), "source", f.seqs[0], ""); err != nil {
				t.Fatalf("Fork: %v", err)
			}

			if ag.opts.SourceProcessLive != tt.wantLive {
				t.Errorf("SourceProcessLive = %v, want %v", ag.opts.SourceProcessLive, tt.wantLive)
			}
			if ag.opts.Truncated {
				t.Error("Truncated = true, want false: the anchor is the last record")
			}
		})
	}
}

// TestFork_AnchorNamesTheRecordTheClientSaw is the reason the anchor is a
// server-issued sequence number and not a count. Answering a permission request
// appends a record that is never broadcast, so a client counting what it received
// would be one short from then on and would silently cut in the wrong place.
func TestFork_AnchorNamesTheRecordTheClientSaw(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: true}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
		{Type: agent.EventTypePermissionRequest, RequestID: "r1"},
		{Type: agent.EventTypePermissionResponse, RequestID: "r1"}, // stored, never broadcast
		{Type: agent.EventTypeText, Content: "the record the user anchors on"},
		{Type: agent.EventTypeDone},
	})

	anchor := f.seqs[3]
	meta, err := f.client.Fork(context.Background(), "source", anchor, "")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	history := forkedHistory(t, f.store, meta.ID)
	last := history[len(history)-1]
	if last.Content != "the record the user anchors on" {
		t.Errorf("fork ends at %+v, want the anchored record", last)
	}
	if len(history) != 4 {
		t.Errorf("kept %d records, want 4", len(history))
	}
}

// TestFork_UsesTheGivenTitle: the user names the fork in the sheet before
// confirming, so it is not created under the parent's name and renamed after.
func TestFork_UsesTheGivenTitle(t *testing.T) {
	f := newForkFixture(t, &forkingAgent{carried: true}, []agent.EventRecord{
		{Type: agent.EventTypeMessage, Content: "first"},
	})

	meta, err := f.client.Fork(context.Background(), "source", f.seqs[0], "Try the other approach")
	if err != nil {
		t.Fatalf("Fork: %v", err)
	}

	if meta.Title != "Try the other approach" {
		t.Errorf("title = %q, want the given one", meta.Title)
	}
}
