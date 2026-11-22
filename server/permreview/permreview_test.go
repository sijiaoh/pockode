package permreview

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/process"
	"github.com/pockode/server/session"
)

// fakeAgent starts sessions that do nothing on their own and keeps every start,
// so a test can speak as each CLI and see what it was launched with.
type fakeAgent struct {
	mu     sync.Mutex
	starts []fakeStart
	// failReviewers makes every reviewer's start fail.
	failReviewers bool
}

type fakeStart struct {
	opts agent.StartOptions
	sess *fakeSession
}

func (a *fakeAgent) Start(_ context.Context, opts agent.StartOptions) (agent.Session, error) {
	sess := &fakeSession{events: make(chan agent.AgentEvent)}
	a.mu.Lock()
	if opts.PermissionReviewer && a.failReviewers {
		a.mu.Unlock()
		return nil, errors.New("reviewer CLI missing")
	}
	a.starts = append(a.starts, fakeStart{opts: opts, sess: sess})
	a.mu.Unlock()
	return sess, nil
}

// startsOf is every start of sessionID so far, in order.
func (a *fakeAgent) startsOf(sessionID string) []fakeStart {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []fakeStart
	for _, s := range a.starts {
		if s.opts.SessionID == sessionID {
			out = append(out, s)
		}
	}
	return out
}

type fakeSession struct {
	events chan agent.AgentEvent

	mu      sync.Mutex
	prompts []string
	answers []string // "allow:<id>", "deny:<id>:<message>"
}

func (s *fakeSession) Events() <-chan agent.AgentEvent { return s.events }
func (s *fakeSession) SendMessage(p agent.Prompt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prompts = append(s.prompts, p.Text)
	return nil
}
func (s *fakeSession) SendPermissionResponse(d agent.PermissionRequestData, c agent.PermissionChoice) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c == agent.PermissionAllow {
		s.answers = append(s.answers, "allow:"+d.RequestID)
	} else {
		s.answers = append(s.answers, "other:"+d.RequestID)
	}
	return nil
}
func (s *fakeSession) DenyPermissionWithMessage(d agent.PermissionRequestData, message string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.answers = append(s.answers, "deny:"+d.RequestID+":"+message)
	return nil
}
func (s *fakeSession) SendInterrupt() error { return nil }
func (s *fakeSession) Close()               { close(s.events) }

func (s *fakeSession) sentPrompts() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.prompts...)
}

func (s *fakeSession) sentAnswers() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.answers...)
}

// fakeTimers stands in for time.AfterFunc, so a test fires a timeout when it
// says so rather than waiting one out.
type fakeTimers struct {
	mu     sync.Mutex
	timers []*fakeTimer
}

type fakeTimer struct {
	wait    time.Duration
	fn      func()
	stopped bool
}

func (ft *fakeTimers) afterFunc(d time.Duration, fn func()) func() bool {
	ft.mu.Lock()
	defer ft.mu.Unlock()
	t := &fakeTimer{wait: d, fn: fn}
	ft.timers = append(ft.timers, t)
	return func() bool {
		ft.mu.Lock()
		defer ft.mu.Unlock()
		was := !t.stopped
		t.stopped = true
		return was
	}
}

func (ft *fakeTimers) get(t *testing.T, i int) *fakeTimer {
	t.Helper()
	ft.mu.Lock()
	defer ft.mu.Unlock()
	if i >= len(ft.timers) {
		t.Fatalf("timer %d was never armed (%d armed)", i, len(ft.timers))
	}
	return ft.timers[i]
}

func (ft *fakeTimers) isStopped(t *testing.T, i int) bool {
	t.Helper()
	timer := ft.get(t, i)
	ft.mu.Lock()
	defer ft.mu.Unlock()
	return timer.stopped
}

type fixture struct {
	store   session.Store
	pm      *process.Manager
	chat    *chat.Client
	agent   *fakeAgent
	service *Service
	timers  *fakeTimers

	engineMu sync.Mutex
	engine   session.Engine

	// holdRequests keeps the reviewer's own permission requests from reaching
	// the service, so a test can leave one standing.
	holdRequests atomic.Bool

	// failGet makes every read of a session through the service's store fail.
	failGet atomic.Bool

	// mainIdles counts the main session falling idle after its process came
	// up — what marks a session unread (watch.SessionListWatcher).
	mainIdles atomic.Int32
}

// flakyStore is the service's store, with reads that fail on request.
type flakyStore struct {
	session.Store
	f *fixture
}

func (s flakyStore) Get(sessionID string) (session.SessionMeta, bool, error) {
	if s.f.failGet.Load() {
		return session.SessionMeta{}, false, errors.New("index unreadable")
	}
	return s.Store.Get(sessionID)
}

func newFixture(t *testing.T, mode session.Mode) *fixture {
	t.Helper()
	return newFixtureOn(t, session.AgentTypeClaude, mode)
}

// newFixtureOn is newFixture with the main session on agentType.
func newFixtureOn(t *testing.T, agentType session.AgentType, mode session.Mode) *fixture {
	t.Helper()
	store, err := session.NewFileStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ag := &fakeAgent{}
	registry := agent.NewRegistry()
	registry.Register(session.AgentTypeClaude, ag)
	registry.Register(session.AgentTypeCodex, ag)
	pm := process.NewManager(registry, "", "/work/tree", t.TempDir(), "", store, session.LeaseBudgets{Idle: time.Minute})
	t.Cleanup(pm.Shutdown)

	f := &fixture{store: store, pm: pm, chat: chat.NewClient(store, pm), agent: ag}
	f.engine = session.Engine{Model: "haiku", Effort: "low"}
	f.service = New(Config{
		Store:     flakyStore{Store: store, f: f},
		Chat:      f.chat,
		Processes: pm,
		Engine: func(agentType session.AgentType) session.Engine {
			f.engineMu.Lock()
			defer f.engineMu.Unlock()
			e := f.engine
			e.AgentType = agentType
			return e
		},
		WorkDir:     "/work/tree",
		ProjectRoot: "/work",
	})
	f.timers = &fakeTimers{}
	f.service.afterFunc = f.timers.afterFunc
	t.Cleanup(f.service.Close)
	f.service.blockedRetry = time.Millisecond
	pm.SetPermissionRouter(func(proc *process.Process, request agent.PermissionRequestEvent) process.PermissionRouting {
		if proc.SessionID() == "main" || !f.holdRequests.Load() {
			return f.service.HandlePermissionRequest(proc, request)
		}
		return process.PermissionRouting{}
	})
	pm.SetOnTurnChanged(f.service.HandleTurnChanged)
	pm.SetOnStateChange(func(e process.StateChangeEvent) {
		if e.SessionID == "main" && e.State == process.ProcessStateIdle && !e.IsInitial {
			f.mainIdles.Add(1)
		}
	})
	store.AddOnChangeListener(f.service)

	if _, err := store.Create(context.Background(), "main", session.CreateSpec{AgentType: agentType, Mode: mode}); err != nil {
		t.Fatalf("Create: %v", err)
	}
	if err := f.chat.SendSystemMessage(context.Background(), "main", "go", "kickoff", nil); err != nil {
		t.Fatalf("start the main session: %v", err)
	}
	return f
}

func (f *fixture) setEngine(e session.Engine) {
	f.engineMu.Lock()
	defer f.engineMu.Unlock()
	f.engine = e
}

func (f *fixture) mainSession(t *testing.T) *fakeSession {
	t.Helper()
	starts := f.agent.startsOf("main")
	if len(starts) == 0 {
		t.Fatal("the main session has no process")
	}
	return starts[len(starts)-1].sess
}

// raise has the main session's CLI ask for permission and waits for the
// request to be recorded, which is when it is routed.
func (f *fixture) raise(t *testing.T, request agent.PermissionRequestEvent) {
	t.Helper()
	f.mainSession(t).events <- request
	waitFor(t, "the request to be waiting", func() bool {
		proc := f.pm.GetProcess("main")
		return proc != nil && proc.TurnState().AwaitingAnswerTo(request.RequestID)
	})
}

// reviewer waits for the main session's reviewer to have been sent n review
// messages, and returns its id and its latest CLI.
func (f *fixture) reviewer(t *testing.T, n int) (string, *fakeSession) {
	t.Helper()
	var id string
	var sess *fakeSession
	waitFor(t, "the reviewer to be sent the request", func() bool {
		reviewer, found, err := session.FindPermissionReviewer(f.store, "main")
		if err != nil || !found {
			return false
		}
		id = reviewer.ID
		total := 0
		for _, s := range f.agent.startsOf(id) {
			total += len(s.sess.sentPrompts())
			sess = s.sess
		}
		if total < n {
			return false
		}
		// And recorded as delivered, which a turn ending reads.
		for _, p := range f.service.Pending(id) {
			if !p.Delivered {
				return false
			}
		}
		return true
	})
	return id, sess
}

// reviewID is the id the reviewer was told to call requestID by.
func (f *fixture) reviewID(t *testing.T, reviewerID, requestID string) string {
	t.Helper()
	for _, p := range f.service.Pending(reviewerID) {
		if p.Data.RequestID == requestID {
			return p.ReviewID
		}
	}
	t.Fatalf("request %s is not pending with reviewer %s", requestID, reviewerID)
	return ""
}

// records is every record of type typ in sessionID's history.
func (f *fixture) records(t *testing.T, sessionID string, typ agent.EventType) []agent.EventRecord {
	t.Helper()
	history, err := f.store.GetHistory(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("GetHistory: %v", err)
	}
	var out []agent.EventRecord
	for _, raw := range history {
		var rec agent.EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if rec.Type == typ {
			out = append(out, rec)
		}
	}
	return out
}

// wantAutoDeny waits for the main session's CLI to be refused requestID by
// Pockode, and checks the record says so: by pockode, of kind, naming the
// reviewer.
func (f *fixture) wantAutoDeny(t *testing.T, requestID, reviewerID string, kind agent.PermissionAutoDeny) {
	t.Helper()
	waitFor(t, "the request to be denied", func() bool { return len(f.mainSession(t).sentAnswers()) > 0 })
	answers := f.mainSession(t).sentAnswers()
	if len(answers) != 1 || !strings.HasPrefix(answers[0], "deny:"+requestID+":Pockode denied this call: ") {
		t.Errorf("main CLI got %q, want Pockode's deny of %s", answers, requestID)
	}
	responses := f.records(t, "main", agent.EventTypePermissionResponse)
	if len(responses) != 1 {
		t.Fatalf("%d permission responses, want 1", len(responses))
	}
	r := responses[0]
	if r.By != agent.RespondedByPockode || r.Choice != "deny" || r.Review == nil ||
		r.Review.Automatic != kind || r.Review.SessionID != reviewerID || r.Review.Reason == "" || r.Review.Category != "" {
		t.Errorf("recorded response = %+v (review %+v), want pockode's %s deny naming %s", r, r.Review, kind, reviewerID)
	}
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func bashRequest(id, command string) agent.PermissionRequestEvent {
	input, _ := json.Marshal(map[string]string{"command": command})
	return agent.PermissionRequestEvent{RequestID: id, ToolName: "Bash", ToolInput: input, ToolUseID: "tu-" + id}
}

// The reviewer of an unattended session is created on its first request,
// launched as a reviewer with the engine the settings name in the main
// session's worktree, and handed the request — and nothing of the main
// session's conversation — as JSON, which names the main session's
// directories.
func TestRoute_SendsTheRequestToANewReviewer(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	request := bashRequest("req-1", `rm -rf "$DIR/" && cat <x > /dev/null`)
	request.DecisionReason = "\x1b[1mrm\x1b[0m target may expand to /"
	request.BlockedPath = "/tmp/x"
	f.raise(t, request)

	reviewerID, reviewer := f.reviewer(t, 1)

	meta, _, err := f.store.Get(reviewerID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if meta.PermissionReviewerOf != "main" {
		t.Errorf("reviewer of %q, want main", meta.PermissionReviewerOf)
	}
	start := f.agent.startsOf(reviewerID)[0].opts
	if !start.PermissionReviewer || start.Model != "haiku" || start.Effort != "low" {
		t.Errorf("reviewer launched with reviewer=%v model=%q effort=%q, want a reviewer on haiku/low", start.PermissionReviewer, start.Model, start.Effort)
	}
	// In the main session's worktree, so that it loads the project's settings
	// and signs in as the main session does.
	if start.WorkDir != "/work/tree" {
		t.Errorf("reviewer launched in %q, want the main session's worktree", start.WorkDir)
	}

	prompt := reviewer.sentPrompts()[0]
	body := prompt[strings.Index(prompt, "{"):]
	var got map[string]any
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("the review message holds no JSON object: %v\n%s", err, prompt)
	}
	want := map[string]any{
		"request_id":      f.reviewID(t, reviewerID, "req-1"),
		"tool_name":       "Bash",
		"tool_input":      map[string]any{"command": `rm -rf "$DIR/" && cat <x > /dev/null`},
		"cwd":             "/work/tree",
		"project_root":    "/work",
		"decision_reason": "rm target may expand to /",
		"blocked_path":    "/tmp/x",
	}
	// Read as written, not as \u0026 and the like.
	if !strings.Contains(prompt, `&& cat <x > /dev/null`) {
		t.Errorf("the command is not shown verbatim:\n%s", prompt)
	}
	gotJSON, _ := json.Marshal(got)
	wantJSON, _ := json.Marshal(want)
	if string(gotJSON) != string(wantJSON) {
		t.Errorf("review request = %s\nwant %s", gotJSON, wantJSON)
	}
}

// storedBlockers is the main session's turn as every client reads it: the
// stored one, which is what session rows and work activity are drawn from.
func (f *fixture) storedBlockers(t *testing.T) []session.Blocker {
	t.Helper()
	meta, _, err := f.store.Get("main")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	return meta.Turn.Blockers
}

// A request routed to the reviewer is raised under review on the session's
// turn, so that no surface calls the person to it — not even for the moment
// routing takes — and the session does not go unread for it; it still takes
// their answer.
func TestRoute_RaisesTheRequestUnderReview(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))

	if blockers := f.storedBlockers(t); len(blockers) != 1 || !blockers[0].Reviewing {
		t.Errorf("stored blockers = %+v, want the request under review from the raise", blockers)
	}
	if !f.pm.GetProcess("main").TurnState().Blockers[0].Reviewing {
		t.Error("the process's copy of the turn does not say the request is under review")
	}
	f.reviewer(t, 1)
	if n := f.mainIdles.Load(); n != 0 {
		t.Errorf("the main session fell idle %d times; a request under review calls nobody", n)
	}
}

// A request routing cannot decide on is the person's: not under review, and
// raised the way it is anywhere else — the session going unread for it.
func TestRoute_HandsBackARequestItCannotDecideOn(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.failGet.Store(true)
	f.raise(t, bashRequest("req-1", "a"))

	waitFor(t, "the warning", func() bool {
		for _, w := range f.records(t, "main", agent.EventTypeWarning) {
			if w.Code == "permission_review_failed" {
				return true
			}
		}
		return false
	})
	if blockers := f.storedBlockers(t); len(blockers) != 1 || blockers[0].Reviewing {
		t.Errorf("stored blockers = %+v, want the request waiting for a person", blockers)
	}
	if n := f.mainIdles.Load(); n != 1 {
		t.Errorf("the main session fell idle %d times, want once: the request calls the person", n)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 0 {
		t.Errorf("main CLI got %q; the request is the person's to answer", answers)
	}
}

// A later request goes to the same reviewer.
func TestRoute_ReusesTheReviewer(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	first, _ := f.reviewer(t, 1)
	f.raise(t, bashRequest("req-2", "b"))
	second, _ := f.reviewer(t, 2)

	if first != second {
		t.Errorf("second request went to reviewer %s, first to %s", second, first)
	}
	sessions, _ := f.store.List()
	if len(sessions) != 2 {
		t.Errorf("%d sessions, want the main session and one reviewer", len(sessions))
	}
}

// Only unattended sessions of an agent with a reviewer are reviewed: a yolo
// session's requests wait for a person, as they always have.
func TestRoute_IgnoresOtherModes(t *testing.T) {
	tests := []struct {
		name      string
		agentType session.AgentType
		mode      session.Mode
	}{
		{"yolo", session.AgentTypeClaude, session.ModeYolo},
		{"default", session.AgentTypeClaude, session.ModeDefault},
		// Codex raises no request under YOLO, so Pockode has no reviewer for
		// it; one that arrived anyway would be the person's, as under YOLO.
		{"codex unattended", session.AgentTypeCodex, session.ModeUnattended},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFixtureOn(t, tt.agentType, tt.mode)
			f.raise(t, bashRequest("req-1", "a"))
			// Routing runs on its own goroutine; give it the time it would take.
			time.Sleep(50 * time.Millisecond)
			if _, found, _ := session.FindPermissionReviewer(f.store, "main"); found {
				t.Error("a reviewer was created")
			}
			if reviewing := f.storedBlockers(t)[0].Reviewing; reviewing {
				t.Error("the request is marked under review, but it waits for a person")
			}
			if n := f.mainIdles.Load(); n != 1 {
				t.Errorf("the main session fell idle %d times, want once: the request calls the person", n)
			}
		})
	}
}

// A settings change reaches an existing reviewer from the next review: its
// process, idle by then, is replaced by one running the new engine.
func TestRoute_AppliesTheEngineAtReviewTime(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, reviewer := f.reviewer(t, 1)
	reviewer.events <- agent.DoneEvent{}
	waitFor(t, "the reviewer's turn to end", func() bool {
		return f.pm.GetProcess(reviewerID).TurnState().Phase == session.PhaseIdle
	})

	f.setEngine(session.Engine{Model: "sonnet", Effort: "high"})
	f.raise(t, bashRequest("req-2", "b"))
	f.reviewer(t, 2)

	starts := f.agent.startsOf(reviewerID)
	if len(starts) != 2 {
		t.Fatalf("reviewer started %d times, want a restart for the new engine", len(starts))
	}
	if got := starts[1].opts; got.Model != "sonnet" || got.Effort != "high" {
		t.Errorf("restarted with %q/%q, want sonnet/high", got.Model, got.Effort)
	}
}

// A deny reaches the main session as a refusal carrying the reason, without
// stopping its turn, and is recorded as the reviewer's.
func TestVerdict_Deny(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", `rm -rf "$DIR/"`))
	reviewerID, _ := f.reviewer(t, 1)

	outcome, err := f.service.Verdict(context.Background(), reviewerID, Verdict{
		RequestID: f.reviewID(t, reviewerID, "req-1"),
		Category:  agent.DenySystemReachUnverifiable,
		Reason:    "check $DIR first",
	})
	if err != nil || outcome != Answered {
		t.Fatalf("Verdict = %v, %v; want answered", outcome, err)
	}
	review := agent.PermissionReview{SessionID: reviewerID, Category: agent.DenySystemReachUnverifiable, Reason: "check $DIR first"}
	answers := f.mainSession(t).sentAnswers()
	if len(answers) != 1 || answers[0] != "deny:req-1:"+review.DenialMessage() {
		t.Errorf("main CLI got %q", answers)
	}
	if pending := f.service.Pending(reviewerID); len(pending) != 0 {
		t.Errorf("still pending: %+v", pending)
	}
}

// An allow answers that one request with a single allow, and the category a
// reviewer may have sent along is not recorded on it.
func TestVerdict_Allow(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "ls"))
	reviewerID, _ := f.reviewer(t, 1)

	if _, err := f.service.Verdict(context.Background(), reviewerID, Verdict{RequestID: f.reviewID(t, reviewerID, "req-1"), Allow: true, Category: agent.DenySystemDamage}); err != nil {
		t.Fatalf("Verdict: %v", err)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 1 || answers[0] != "allow:req-1" {
		t.Errorf("main CLI got %q", answers)
	}
	history, _ := f.store.GetHistory(context.Background(), "main")
	var response agent.EventRecord
	for _, raw := range history {
		var rec agent.EventRecord
		_ = json.Unmarshal(raw, &rec)
		if rec.Type == agent.EventTypePermissionResponse {
			response = rec
		}
	}
	if response.By != agent.RespondedByPermissionReviewer || response.Review == nil || response.Review.Category != "" {
		t.Errorf("recorded response = %+v", response)
	}
}

// What a verdict may not do: answer for a request it was not sent, or deny
// without a category. Neither reaches the main session, and the request stays
// waiting for a proper answer.
func TestVerdict_Refusals(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, _ := f.reviewer(t, 1)
	id := f.reviewID(t, reviewerID, "req-1")

	tests := []struct {
		name     string
		reviewer string
		verdict  Verdict
		want     error
	}{
		{"not a reviewer", "main", Verdict{RequestID: id, Allow: true}, ErrNotRouted},
		{"unknown request", reviewerID, Verdict{RequestID: "req-9", Allow: true}, ErrNotRouted},
		// The CLI's own id is not what the reviewer was told to answer by.
		{"the CLI's request id", reviewerID, Verdict{RequestID: "req-1", Allow: true}, ErrNotRouted},
		{"deny without category", reviewerID, Verdict{RequestID: id}, ErrDenyNeedsCategory},
		{"deny with another category", reviewerID, Verdict{RequestID: id, Category: "unreasonable"}, ErrDenyNeedsCategory},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := f.service.Verdict(context.Background(), tt.reviewer, tt.verdict); err != tt.want {
				t.Errorf("err = %v, want %v", err, tt.want)
			}
		})
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 0 {
		t.Errorf("main CLI got %q", answers)
	}
	if pending := f.service.Pending(reviewerID); len(pending) != 1 {
		t.Errorf("pending = %+v, want req-1 still waiting", pending)
	}
}

// A person who answered first wins: the reviewer's verdict is dropped and
// reported as no longer pending, not as a failure.
func TestVerdict_PersonAnsweredFirst(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	request := bashRequest("req-1", "a")
	f.raise(t, request)
	reviewerID, _ := f.reviewer(t, 1)
	id := f.reviewID(t, reviewerID, "req-1")

	data := agent.PermissionRequestData{RequestID: "req-1", ToolInput: request.ToolInput, ToolUseID: request.ToolUseID}
	if err := f.chat.SendPermissionResponse(context.Background(), "main", data, agent.PermissionAllow); err != nil {
		t.Fatalf("person's answer: %v", err)
	}
	outcome, err := f.service.Verdict(context.Background(), reviewerID, Verdict{RequestID: id, Category: agent.DenySystemDamage})
	if err != nil || outcome != NoLongerPending {
		t.Errorf("Verdict = %v, %v; want no longer pending", outcome, err)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 1 {
		t.Errorf("main CLI got %q, want the person's answer alone", answers)
	}
}

// Pending forgets a request a person answered, and the summary the tool
// returns names what is still waiting.
func TestPending_DropsWhatStoppedWaiting(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	f.raise(t, bashRequest("req-2", "b"))
	reviewerID, _ := f.reviewer(t, 2)
	second := f.reviewID(t, reviewerID, "req-2")

	data := agent.PermissionRequestData{RequestID: "req-1"}
	if err := f.chat.SendPermissionResponse(context.Background(), "main", data, agent.PermissionDeny); err != nil {
		t.Fatalf("person's answer: %v", err)
	}
	if got, want := f.service.PendingSummary(reviewerID), "Still waiting for your verdict: "+second+" (Bash)."; got != want {
		t.Errorf("summary = %q, want %q", got, want)
	}
}

func TestStripANSI(t *testing.T) {
	tests := map[string]string{
		"\x1b[31mred\x1b[0m":                        "red",
		"\x1b]8;;https://x\x1b\\link\x1b]8;;\x1b\\": "link",
		"plain":                      "plain",
		"bell \x1b]0;title\x07after": "bell after",
	}
	for in, want := range tests {
		if got := stripANSI(in); got != want {
			t.Errorf("stripANSI(%q) = %q, want %q", in, got, want)
		}
	}
}

// A reviewer that finishes a turn with a request still open is reminded of it,
// MaxNudges times in a row; the turn after that ends the request in Pockode's
// own deny, which the reviewer's session is told of too.
func TestTurnEnded_NudgesThenDenies(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, reviewer := f.reviewer(t, 1)
	id := f.reviewID(t, reviewerID, "req-1")
	completed := session.TurnEnd{SessionID: reviewerID, Outcome: session.OutcomeCompleted}

	for n := 1; n <= MaxNudges; n++ {
		f.service.HandleTurnEnded(completed)
		prompts := reviewer.sentPrompts()
		if len(prompts) != n+1 {
			t.Fatalf("after %d endings the reviewer has %d prompts, want %d", n, len(prompts), n+1)
		}
		if nudge := prompts[n]; !strings.Contains(nudge, id+" (Bash)") || !strings.Contains(nudge, agent.PermissionVerdictTool) {
			t.Errorf("nudge %d does not name the request:\n%s", n, nudge)
		}
		if answers := f.mainSession(t).sentAnswers(); len(answers) != 0 {
			t.Fatalf("denied after %d nudges: %q", n, answers)
		}
	}

	f.service.HandleTurnEnded(completed)
	f.wantAutoDeny(t, "req-1", reviewerID, agent.AutoDenyNoVerdict)
	if got := len(reviewer.sentPrompts()); got != MaxNudges+1 {
		t.Errorf("reviewer has %d prompts, want no nudge past the limit", got)
	}
	warnings := f.records(t, reviewerID, agent.EventTypeWarning)
	if len(warnings) != 1 || !strings.Contains(warnings[0].Message, id) {
		t.Errorf("reviewer warnings = %+v, want one naming %s", warnings, id)
	}
	if !f.timers.isStopped(t, 0) {
		t.Error("the request's timeout is still armed")
	}
}

// A verdict — on any request — gives the reviewer its nudges back.
func TestTurnEnded_VerdictResetsNudges(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	f.raise(t, bashRequest("req-2", "b"))
	reviewerID, reviewer := f.reviewer(t, 2)
	completed := session.TurnEnd{SessionID: reviewerID, Outcome: session.OutcomeCompleted}

	for range MaxNudges {
		f.service.HandleTurnEnded(completed)
	}
	if _, err := f.service.Verdict(context.Background(), reviewerID, Verdict{RequestID: f.reviewID(t, reviewerID, "req-1"), Allow: true}); err != nil {
		t.Fatalf("Verdict: %v", err)
	}
	f.service.HandleTurnEnded(completed)

	if got := len(reviewer.sentPrompts()); got != 2+MaxNudges+1 {
		t.Errorf("reviewer has %d prompts, want a fresh nudge after the verdict", got)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 1 || answers[0] != "allow:req-1" {
		t.Errorf("main CLI got %q, want the verdict alone", answers)
	}
}

// A reviewer turn that will not be followed by a verdict — it failed, was
// stopped, or could not sign in — ends its open requests at once.
func TestTurnEnded_FailureDenies(t *testing.T) {
	for _, outcome := range []session.TurnOutcome{session.OutcomeFailed, session.OutcomeAuthFailed, session.OutcomeAborted} {
		t.Run(string(outcome), func(t *testing.T) {
			f := newFixture(t, session.ModeUnattended)
			f.raise(t, bashRequest("req-1", "a"))
			reviewerID, reviewer := f.reviewer(t, 1)

			f.service.HandleTurnEnded(session.TurnEnd{SessionID: reviewerID, Outcome: outcome})

			f.wantAutoDeny(t, "req-1", reviewerID, agent.AutoDenyReviewerFailed)
			if got := len(reviewer.sentPrompts()); got != 1 {
				t.Errorf("reviewer has %d prompts, want no nudge", got)
			}
		})
	}
}

// No verdict within the timeout of the request arriving: Pockode denies it.
func TestTimeout_Denies(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, _ := f.reviewer(t, 1)

	timer := f.timers.get(t, 0)
	if timer.wait <= DefaultTimeout-time.Minute || timer.wait > DefaultTimeout {
		t.Errorf("timeout armed for %v, want about %v", timer.wait, DefaultTimeout)
	}
	timer.fn()

	f.wantAutoDeny(t, "req-1", reviewerID, agent.AutoDenyTimeout)
	// The verdict that comes too late is told so, not refused.
	outcome, err := f.service.Verdict(context.Background(), reviewerID, Verdict{RequestID: f.timedOutID(t), Allow: true})
	if err != nil || outcome != NoLongerPending {
		t.Errorf("late Verdict = %v, %v; want no longer pending", outcome, err)
	}
}

// timedOutID is the review id the reviewer was sent first, read off its
// first review message.
func (f *fixture) timedOutID(t *testing.T) string {
	t.Helper()
	reviewer, _, _ := session.FindPermissionReviewer(f.store, "main")
	prompt := f.agent.startsOf(reviewer.ID)[0].sess.sentPrompts()[0]
	var got struct {
		RequestID string `json:"request_id"`
	}
	if err := json.Unmarshal([]byte(prompt[strings.Index(prompt, "{"):]), &got); err != nil {
		t.Fatalf("review message: %v", err)
	}
	return got.RequestID
}

// A person answering first takes the request off the reviewer's hands: its
// timeout stops, and nothing is nudged or denied about it later.
func TestPersonAnswering_ClearsTheReview(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, reviewer := f.reviewer(t, 1)

	if err := f.chat.SendPermissionResponse(context.Background(), "main", agent.PermissionRequestData{RequestID: "req-1"}, agent.PermissionAllow); err != nil {
		t.Fatalf("person's answer: %v", err)
	}
	waitFor(t, "the timeout to stop", func() bool { return f.timers.isStopped(t, 0) })

	f.service.HandleTurnEnded(session.TurnEnd{SessionID: reviewerID, Outcome: session.OutcomeCompleted})
	if got := len(reviewer.sentPrompts()); got != 1 {
		t.Errorf("reviewer has %d prompts, want no nudge", got)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 1 {
		t.Errorf("main CLI got %q, want the person's answer alone", answers)
	}
}

// A reviewer that cannot be reached denies the request instead of leaving it
// to a person nobody told.
func TestRoute_FailureDenies(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.agent.mu.Lock()
	f.agent.failReviewers = true
	f.agent.mu.Unlock()

	f.raise(t, bashRequest("req-1", "a"))

	waitFor(t, "the request to be denied", func() bool { return len(f.mainSession(t).sentAnswers()) > 0 })
	reviewer, found, _ := session.FindPermissionReviewer(f.store, "main")
	if !found {
		t.Fatal("no reviewer was created")
	}
	f.wantAutoDeny(t, "req-1", reviewer.ID, agent.AutoDenyReviewerFailed)
}

// A reviewer deleted while it holds a request will give no verdict on it.
func TestReviewerDeleted_Denies(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, _ := f.reviewer(t, 1)

	f.pm.Close(reviewerID)
	if err := f.store.Delete(context.Background(), reviewerID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	f.wantAutoDeny(t, "req-1", reviewerID, agent.AutoDenyReviewerFailed)
	if !f.timers.isStopped(t, 0) {
		t.Error("the request's timeout is still armed")
	}
}

// A reviewer removed by the store alone — the cascade of a main session's
// delete that raced the reviewer's creation — has its process stopped too.
func TestReviewerDeleted_StopsItsProcess(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, _ := f.reviewer(t, 1)

	if err := f.store.Delete(context.Background(), reviewerID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	waitFor(t, "the reviewer's process to stop", func() bool { return f.pm.GetProcess(reviewerID) == nil })
	f.wantAutoDeny(t, "req-1", reviewerID, agent.AutoDenyReviewerFailed)
}

// What a reviewer asks permission for itself is refused by Pockode without
// stopping its turn, and recorded in the reviewer's own session.
func TestRoute_DeniesTheReviewersOwnRequest(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, reviewer := f.reviewer(t, 1)

	reviewer.events <- bashRequest("own-1", "cat /etc/hosts")
	waitFor(t, "the reviewer's request to be denied", func() bool { return len(reviewer.sentAnswers()) > 0 })

	answers := reviewer.sentAnswers()
	if len(answers) != 1 || !strings.HasPrefix(answers[0], "deny:own-1:Pockode denied this call: ") {
		t.Errorf("reviewer CLI got %q", answers)
	}
	responses := f.records(t, reviewerID, agent.EventTypePermissionResponse)
	if len(responses) != 1 || responses[0].By != agent.RespondedByPockode || responses[0].Review == nil ||
		responses[0].Review.Automatic != agent.AutoDenyReviewerRequest || responses[0].Review.SessionID != reviewerID {
		t.Errorf("reviewer's responses = %+v", responses)
	}
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 0 {
		t.Errorf("main CLI got %q", answers)
	}
}

// A request id is the raising process's own: after the main session's process
// is replaced, a verdict or timeout for the old request cannot answer the
// new process's request that happens to share its id.
func TestReview_IsTiedToTheRaisingProcess(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("approval-1", "a"))
	reviewerID, _ := f.reviewer(t, 1)
	oldID := f.reviewID(t, reviewerID, "approval-1")

	f.pm.Close("main")
	if err := f.chat.SendSystemMessage(context.Background(), "main", "again", "kickoff", nil); err != nil {
		t.Fatalf("restart the main session: %v", err)
	}
	f.raise(t, bashRequest("approval-1", "b"))
	f.reviewer(t, 2)
	if newID := f.reviewID(t, reviewerID, "approval-1"); newID == oldID {
		t.Fatalf("the new request was given the old review id")
	}

	outcome, err := f.service.Verdict(context.Background(), reviewerID, Verdict{RequestID: oldID, Allow: true})
	if err != nil || outcome != NoLongerPending {
		t.Errorf("verdict on the old request = %v, %v; want no longer pending", outcome, err)
	}
	// Synchronous: the timeout finds its request already settled.
	f.timers.get(t, 0).fn()
	if answers := f.mainSession(t).sentAnswers(); len(answers) != 0 {
		t.Errorf("the new process got %q for the old request", answers)
	}
}

// Close stops every timeout: nothing fires into a worktree being stopped.
func TestClose_StopsTimeouts(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	f.reviewer(t, 1)

	f.service.Close()
	if !f.timers.isStopped(t, 0) {
		t.Error("the timeout is still armed after Close")
	}
}

// A review that reaches a reviewer held by a request of its own waits for
// that hold to clear — Pockode's deny of the request — instead of failing,
// and is not denied for a reviewer turn that ended before it arrived.
func TestRoute_WaitsOutTheReviewersOwnRequest(t *testing.T) {
	f := newFixture(t, session.ModeUnattended)
	f.raise(t, bashRequest("req-1", "a"))
	reviewerID, reviewer := f.reviewer(t, 1)

	f.holdRequests.Store(true)
	own := bashRequest("own-1", "ls /")
	reviewer.events <- own
	waitFor(t, "the reviewer to be held", func() bool {
		return f.pm.GetProcess(reviewerID).TurnState().AwaitingAnswerTo("own-1")
	})
	f.raise(t, bashRequest("req-2", "b"))
	// Offered and refused at least once while the hold stands.
	waitFor(t, "req-2 to be routed", func() bool {
		for _, p := range f.service.Pending(reviewerID) {
			if p.Data.RequestID == "req-2" {
				return true
			}
		}
		return false
	})
	if got := len(reviewer.sentPrompts()); got != 1 {
		t.Fatalf("reviewer has %d prompts while held, want 1", got)
	}

	// A turn ending now is about what the reviewer was sent, not about req-2,
	// which it has not seen.
	f.service.HandleTurnEnded(session.TurnEnd{SessionID: reviewerID, Outcome: session.OutcomeFailed})
	waitFor(t, "req-1 to be denied", func() bool { return len(f.mainSession(t).sentAnswers()) > 0 })

	f.holdRequests.Store(false)
	f.service.HandlePermissionRequest(f.pm.GetProcess(reviewerID), own).Route()
	f.reviewer(t, 2)

	if answers := f.mainSession(t).sentAnswers(); len(answers) != 1 || !strings.HasPrefix(answers[0], "deny:req-1:") {
		t.Errorf("main CLI got %q, want req-1 denied and req-2 still under review", answers)
	}
}
