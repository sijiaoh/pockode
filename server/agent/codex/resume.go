package codex

import (
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
)

const resumeStateFile = "codex_resume.json"

// codexResumeState maps a Pockode session to the Codex thread holding its
// conversation, so a restarted process can reopen it instead of starting over.
//
// No recovery ladder, unlike Claude's equivalent. That ladder exists because the
// Claude CLI *claims* a session id the moment it starts — reusing one is fatal,
// so a failed launch has to be told apart from a stale mapping. A Codex thread
// id is only ever a key into a rollout file on disk; `thread/resume` either
// finds it or answers "no rollout found for thread id" (codex-cli 0.153.0),
// which openThread reads at the one moment it matters and answers in one step.
type codexResumeState struct {
	// ThreadID is the thread this session's conversation lives in — unless
	// ForkAtTurnID is set, in which case it is the *source's* thread and this
	// session has no thread of its own yet.
	ThreadID string `json:"threadId"`

	// ForkAtTurnID is a fork that has not been taken yet: the turn in ThreadID's
	// conversation that this session was forked at, inclusive. It is written by
	// ForkSession and acted on by the first process this session ever starts,
	// which forks the thread rather than resuming it and records the new thread
	// the fork produced — which clears this field, since the state written then
	// names a thread of this session's own.
	//
	// Deferring the fork to that first launch, rather than taking it when the
	// user forks, is what keeps a fork from costing a process: the session may
	// never be typed into at all. It is also the same shape Claude's fork uses,
	// for the same reason.
	ForkAtTurnID string `json:"forkAtTurnId,omitempty"`
}

// resumeStatePath locates a session's resume state. It takes the directory and
// the id rather than a store, so a fork can read the state of the session it
// came from and seed the state of the one being created.
func resumeStatePath(dataDir, sessionID string) string {
	return filepath.Join(dataDir, "sessions", sessionID, resumeStateFile)
}

// resumeStateStore owns codex_resume.json for one session.
//
// No in-memory mirror of what is on disk, unlike Claude's equivalent: that one
// deduplicates because the CLI re-announces its session id at the start of every
// turn, while a Codex thread is opened once per process and recorded once with
// it. There is nothing here for a mirror to save.
type resumeStateStore struct {
	opts agent.StartOptions
	log  *slog.Logger
}

func newResumeStateStore(opts agent.StartOptions, log *slog.Logger) *resumeStateStore {
	return &resumeStateStore{opts: opts, log: log}
}

func (s *resumeStateStore) path() string {
	return resumeStatePath(s.opts.DataDir, s.opts.SessionID)
}

// load reads the recorded thread, reporting whether one was found.
func (s *resumeStateStore) load() (codexResumeState, bool) {
	if s.opts.SessionID == "" {
		return codexResumeState{}, false
	}
	return loadResumeState(s.path(), s.log)
}

func loadResumeState(path string, log *slog.Logger) (codexResumeState, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return codexResumeState{}, false
	}
	var state codexResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		log.Warn("failed to parse codex resume state", "error", err)
		return codexResumeState{}, false
	}
	return state, true
}

// record persists the thread this session's conversation now lives in.
//
// It writes the whole state, so recording a thread is also what retires a fork
// intent: once the fork has been taken the new thread stands on its own, and a
// second launch must resume it rather than fork its source over again.
//
// Failures are logged rather than returned: the thread is already open and the
// turn the user asked for can still run. What is lost is the ability to reopen
// this thread after a restart — the session then starts a new one, which is the
// same degradation openThread already has a path for.
func (s *resumeStateStore) record(threadID string) {
	if s.opts.SessionID == "" || threadID == "" {
		return
	}

	data, err := json.Marshal(codexResumeState{ThreadID: threadID})
	if err != nil {
		s.log.Error("failed to marshal codex resume state", "error", err)
		return
	}
	if err := filestore.WriteFileAtomic(s.path(), data, 0644); err != nil {
		s.log.Error("failed to write codex resume state", "error", err)
		return
	}
	s.log.Info("recorded codex thread for resume", "threadId", threadID)
}
