package codex

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pockode/server/agent"
)

func TestExtractFilePath(t *testing.T) {
	tests := []struct {
		name    string
		changes json.RawMessage
		want    string
	}{
		{
			"single file",
			json.RawMessage(`[{"path":"/w/src/main.go","kind":{"type":"add"},"diff":"x\n"}]`),
			"/w/src/main.go",
		},
		{
			"several files",
			json.RawMessage(`[{"path":"/w/a.go","kind":{"type":"add"},"diff":""},{"path":"/w/b.go","kind":{"type":"delete"},"diff":""}]`),
			"",
		},
		{"empty", json.RawMessage(`[]`), ""},
		{"invalid JSON", json.RawMessage(`not json`), ""},
		{"null", json.RawMessage(`null`), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := extractFilePath(tt.changes); got != tt.want {
				t.Errorf("extractFilePath() = %q, want %q", got, tt.want)
			}
		})
	}
}

// --- Resume state ---

func TestResumeStateStore_RoundTrip(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1"}
	store := newResumeStateStore(opts, testLogger())

	if _, found := store.load(); found {
		t.Fatal("expected no state before anything was recorded")
	}

	store.record("thread-1")

	reopened := newResumeStateStore(opts, testLogger())
	state, found := reopened.load()
	if !found || state.ThreadID != "thread-1" {
		t.Fatalf("load() = %+v, %v; want the recorded thread", state, found)
	}
}

// A session with no id has no directory of its own, so writing would land in a
// path every anonymous session shares.
func TestResumeStateStore_AnonymousSessionWritesNothing(t *testing.T) {
	dir := t.TempDir()
	store := newResumeStateStore(agent.StartOptions{DataDir: dir}, testLogger())

	store.record("thread-1")

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("expected nothing to be written, got %v", entries)
	}
}

// A state file we cannot read is not a reason to refuse to run: the session
// starts a new thread, which is the same answer as having no state at all.
func TestResumeStateStore_CorruptStateIsIgnored(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1"}
	path := resumeStatePath(opts.DataDir, opts.SessionID)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{not json"), 0644); err != nil {
		t.Fatal(err)
	}

	if state, found := newResumeStateStore(opts, testLogger()).load(); found {
		t.Errorf("load() = %+v, %v; want it treated as absent", state, found)
	}
}

// --- Opening a thread ---

// scriptedSession drives openThread against canned replies, keyed by method.
type scriptedSession struct {
	sess    *appSession
	writer  *recordingWriteCloser
	replies map[string]*rpcResponse
}

func newScriptedSession(t *testing.T, opts agent.StartOptions, replies map[string]*rpcResponse) *scriptedSession {
	t.Helper()
	sess := newTestSession()
	sess.opts = opts
	sess.opts.DisableMCP = true
	sess.resume = newResumeStateStore(sess.opts, testLogger())
	writer := &recordingWriteCloser{}
	sess.stdin = writer

	s := &scriptedSession{sess: sess, writer: writer, replies: replies}

	// Answer whatever is written, as the read loop would.
	go func() {
		answered := map[int64]bool{}
		for sess.procCtx.Err() == nil {
			for _, req := range writer.requests() {
				if req.ID == nil || answered[*req.ID] {
					continue
				}
				reply, ok := s.replies[req.Method]
				if !ok {
					continue
				}
				answered[*req.ID] = true
				sess.handleResponse(rpcMessage{ID: req.ID, Result: reply.Result, Error: reply.Error})
			}
			time.Sleep(time.Millisecond)
		}
	}()

	t.Cleanup(sess.cancel)
	return s
}

func (s *scriptedSession) methodsSent() []string {
	var methods []string
	for _, req := range s.writer.requests() {
		methods = append(methods, req.Method)
	}
	return methods
}

func threadReply(id string) *rpcResponse {
	return &rpcResponse{Result: json.RawMessage(`{"thread":{"id":"` + id + `"}}`)}
}

func TestOpenThread_StartsFreshWithoutRecordedState(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		"thread/start": threadReply("thread-new"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if got := s.methodsSent(); len(got) != 1 || got[0] != "thread/start" {
		t.Errorf("methods = %v, want only thread/start", got)
	}
	if s.sess.currentThreadID() != "thread-new" {
		t.Errorf("thread id = %q", s.sess.currentThreadID())
	}
	// Recorded, or the next process would start over.
	if state, _ := s.sess.resume.load(); state.ThreadID != "thread-new" {
		t.Errorf("recorded state = %+v, want the new thread", state)
	}
}

// A new thread must be classified as Pockode's, and told where to run.
func TestOpenThread_StartNamesItsSource(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		"thread/start": threadReply("thread-new"),
	})
	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	var params map[string]interface{}
	if err := json.Unmarshal(s.writer.waitForRequest(t, "thread/start").Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["threadSource"] != threadSource {
		t.Errorf("threadSource = %v, want %q", params["threadSource"], threadSource)
	}
	if params["cwd"] != "/tmp/work" {
		t.Errorf("cwd = %v", params["cwd"])
	}
}

// The whole point of this channel: a recorded thread is reopened instead of
// being started over.
func TestOpenThread_ResumesTheRecordedThread(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work", Resume: true}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-old"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		"thread/resume": threadReply("thread-old"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if got := s.methodsSent(); len(got) != 1 || got[0] != "thread/resume" {
		t.Errorf("methods = %v, want only thread/resume", got)
	}
	if s.sess.currentThreadID() != "thread-old" {
		t.Errorf("thread id = %q, want the recorded one", s.sess.currentThreadID())
	}

	var params map[string]interface{}
	if err := json.Unmarshal(s.writer.waitForRequest(t, "thread/resume").Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["threadId"] != "thread-old" {
		t.Errorf("threadId = %v", params["threadId"])
	}
	// Pockode renders from its own transcript, so hydrating the thread's turns
	// into the reply would only cost the time to serialise them.
	if params["excludeTurns"] != true {
		t.Errorf("excludeTurns = %v, want true", params["excludeTurns"])
	}
	if events := drainEvents(s.sess.events); len(events) != 0 {
		t.Errorf("a successful resume should say nothing, got %v", events)
	}
}

// A thread whose rollout is gone would otherwise make the session permanently
// unusable. It degrades to a new thread — and the user is told, because the
// agent no longer remembers the transcript they are looking at.
func TestOpenThread_UnresumableThreadDegradesWithAWarning(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work", Resume: true}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-gone"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		// Verbatim from codex-cli 0.153.0.
		"thread/resume": {Error: &rpcError{Code: -32600, Message: "no rollout found for thread id thread-gone"}},
		"thread/start":  threadReply("thread-new"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if got := s.methodsSent(); len(got) != 2 || got[0] != "thread/resume" || got[1] != "thread/start" {
		t.Errorf("methods = %v, want resume then start", got)
	}
	if s.sess.currentThreadID() != "thread-new" {
		t.Errorf("thread id = %q, want the replacement", s.sess.currentThreadID())
	}
	// The dead id must not survive, or every restart would repeat this.
	if state, _ := s.sess.resume.load(); state.ThreadID != "thread-new" {
		t.Errorf("recorded state = %+v, want the replacement thread", state)
	}

	events := drainEvents(s.sess.events)
	if len(events) != 1 {
		t.Fatalf("expected one warning, got %v", events)
	}
	warning, ok := events[0].(agent.WarningEvent)
	if !ok {
		t.Fatalf("expected a WarningEvent, got %T", events[0])
	}
	if warning.Code != "session_not_resumable" {
		t.Errorf("Code = %q", warning.Code)
	}
	if !strings.Contains(warning.Message, "no rollout found") {
		t.Errorf("Message = %q, want it to carry Codex's reason", warning.Message)
	}
}

// Another process still holding the thread is refused by name, and the same
// degradation applies — Pockode runs one process per session, so this is a
// leaked process rather than a rollout that vanished, and the user has to be
// told either way.
func TestOpenThread_ThreadHeldByAnotherProcessDegrades(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work", Resume: true}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-busy"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		// Verbatim from codex-cli 0.153.0.
		"thread/resume": {Error: &rpcError{Code: -32600, Message: "thread thread-busy already has an active writer"}},
		"thread/start":  threadReply("thread-new"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	warning := drainEvents(s.sess.events)[0].(agent.WarningEvent)
	if !strings.Contains(warning.Message, "already has an active writer") {
		t.Errorf("Message = %q, want it to say what stopped the resume", warning.Message)
	}
}

// Running out of the startup budget says nothing about whether the thread is
// usable, so it must not burn the recorded id on a replacement.
func TestOpenThread_ExpiredBudgetKeepsTheRecordedThread(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work", Resume: true}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-old"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := s.sess.openThread(ctx); err == nil {
		t.Fatal("expected openThread to fail")
	}

	if got := s.methodsSent(); len(got) != 1 || got[0] != "thread/resume" {
		t.Errorf("methods = %v, want the resume alone", got)
	}
	if state, _ := s.sess.resume.load(); state.ThreadID != "thread-old" {
		t.Errorf("recorded state = %+v, want the recorded thread untouched", state)
	}
}

// --- Forking a thread ---

// The point of stage two: a session created by a fork opens its thread by
// forking the source's, cut at the turn the fork was taken at.
func TestOpenThread_ForkIntentForksTheSourceThread(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-source", ForkAtTurnID: "turn-7"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		"thread/fork": threadReply("thread-fork"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if got := s.methodsSent(); len(got) != 1 || got[0] != "thread/fork" {
		t.Errorf("methods = %v, want only thread/fork", got)
	}

	var params map[string]interface{}
	if err := json.Unmarshal(s.writer.waitForRequest(t, "thread/fork").Params, &params); err != nil {
		t.Fatal(err)
	}
	if params["threadId"] != "thread-source" {
		t.Errorf("threadId = %v, want the source's thread", params["threadId"])
	}
	// Inclusive, so the fork keeps the turn its anchor sits in; see forkThread.
	if params["lastTurnId"] != "turn-7" {
		t.Errorf("lastTurnId = %v, want the recorded anchor", params["lastTurnId"])
	}
	if params["beforeTurnId"] != nil {
		t.Errorf("beforeTurnId = %v, want it absent: the two selectors cannot be combined", params["beforeTurnId"])
	}
	// A forked thread is as much Pockode's as a started one, and runs in the
	// same worktree.
	if params["threadSource"] != threadSource {
		t.Errorf("threadSource = %v, want %q", params["threadSource"], threadSource)
	}
	if params["cwd"] != "/tmp/work" {
		t.Errorf("cwd = %v", params["cwd"])
	}

	if s.sess.currentThreadID() != "thread-fork" {
		t.Errorf("thread id = %q, want the thread the fork produced", s.sess.currentThreadID())
	}
	// The intent is spent: this session now has a thread of its own, and a
	// second launch must resume it rather than fork the source over again.
	state, _ := s.sess.resume.load()
	if state != (codexResumeState{ThreadID: "thread-fork"}) {
		t.Errorf("recorded state = %+v, want the forked thread alone", state)
	}
	if events := drainEvents(s.sess.events); len(events) != 0 {
		t.Errorf("a successful fork should say nothing, got %v", events)
	}
}

// A fork Codex refuses — a withdrawn `lastTurnId`, a rollout that is gone, an
// anchor turn still running — must not take the whole session down with it. It
// degrades to a new thread, and above all not to resuming the source's: two
// sessions writing into one conversation is what forking exists to prevent.
func TestOpenThread_UnforkableThreadDegradesToANewThread(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
	writeResumeState(t, opts, codexResumeState{ThreadID: "thread-source", ForkAtTurnID: "turn-7"})

	s := newScriptedSession(t, opts, map[string]*rpcResponse{
		// Verbatim from codex-cli 0.153.0, for a request sent without the
		// experimental capability — which is how the field being withdrawn would
		// read too.
		"thread/fork":  {Error: &rpcError{Code: -32602, Message: "thread/fork.lastTurnId requires experimentalApi capability"}},
		"thread/start": threadReply("thread-new"),
	})

	if err := s.sess.openThread(context.Background()); err != nil {
		t.Fatalf("openThread error: %v", err)
	}

	if got := s.methodsSent(); len(got) != 2 || got[0] != "thread/fork" || got[1] != "thread/start" {
		t.Errorf("methods = %v, want fork then start", got)
	}
	if state, _ := s.sess.resume.load(); state != (codexResumeState{ThreadID: "thread-new"}) {
		t.Errorf("recorded state = %+v, want the new thread alone", state)
	}

	events := drainEvents(s.sess.events)
	if len(events) != 1 {
		t.Fatalf("expected one warning, got %v", events)
	}
	warning, ok := events[0].(agent.WarningEvent)
	if !ok {
		t.Fatalf("expected a WarningEvent, got %T", events[0])
	}
	if warning.Code != "session_not_resumable" {
		t.Errorf("Code = %q", warning.Code)
	}
	if !strings.Contains(warning.Message, "forked from") || !strings.Contains(warning.Message, "experimentalApi") {
		t.Errorf("Message = %q, want it to say the fork failed and why", warning.Message)
	}
}

// Running out of the startup budget says nothing about whether the fork is
// possible, so it must not spend the intent on a replacement.
func TestOpenThread_ExpiredBudgetKeepsTheForkIntent(t *testing.T) {
	opts := agent.StartOptions{DataDir: t.TempDir(), SessionID: "s1", WorkDir: "/tmp/work"}
	seeded := codexResumeState{ThreadID: "thread-source", ForkAtTurnID: "turn-7"}
	writeResumeState(t, opts, seeded)

	s := newScriptedSession(t, opts, map[string]*rpcResponse{})

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if err := s.sess.openThread(ctx); err == nil {
		t.Fatal("expected openThread to fail")
	}

	if got := s.methodsSent(); len(got) != 1 || got[0] != "thread/fork" {
		t.Errorf("methods = %v, want the fork alone", got)
	}
	if state, _ := s.sess.resume.load(); state != seeded {
		t.Errorf("recorded state = %+v, want the fork intent untouched", state)
	}
}
