package codex

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
)

// Implementing agent.SessionForker is what declares Codex forkable, and nothing
// else requires it: a method drifting out of that interface would not break the
// build, it would leave *Agent no longer satisfying it and quietly take the fork
// icon off every message in every Codex session. This line is the only thing
// that notices.
var _ agent.SessionForker = (*Agent)(nil)

// ForkSupport implements agent.SessionForker: `thread/fork` reopens a
// conversation through a chosen turn in it, so a fork taken anywhere in one can
// carry the agent's side of it — `lastTurnId` is the anchor, forkThread is how
// it is used.
//
// This is the declaration for what the CLI can do, and it is answered without
// asking the CLI anything: it is read on every agent.list call, and probing
// would mean spawning a process to answer a question about the installation
// rather than about this session. `lastTurnId`, the anchor forkThread sends,
// could be renamed or withdrawn by a Codex release; what that costs is bounded
// and visible rather than silent.
// Forks would still be offered, the fork would fail when the session is first
// opened, and openRecordedThread degrades it to a new thread and tells the user
// the conversation was not carried — the same answer, one step later, as a
// source that has nothing to reopen.
//
// An individual fork can come back carrying nothing for reasons of its own — a
// source whose records predate Pockode storing turn ids, or one that never ran
// Codex — which is a fact about that source, not about the agent, and
// ForkSession reports it per fork.
func (a *Agent) ForkSupport() agent.ForkSupport {
	return agent.ForkFromAnyMessage
}

// ForkSession leaves the forked session an instruction to open its thread by
// forking the source's, cut at the fork point, rather than by starting a fresh
// one.
//
// Nothing is forked here. A fork of a Codex thread is a `thread/fork` call, and
// making it now would mean starting an app-server process for a session the user
// may never type into; leaving the intent behind instead costs nothing and is
// carried out by the first process this session does start (see
// codexResumeState.ForkAtTurnID). It also keeps this correct however long the
// wait is: the anchor is a turn id, which names the same point in the source's
// conversation whatever the source goes on to do.
//
// Naming the cut needs Codex's own id for the turn, which Pockode only has for
// records written since it started keeping them. A fork whose kept history names
// none — a session that predates that, or one the agent never spoke in — carries
// nothing, reported as carried == false, which is an answer and not a failure.
// There is no uncut fallback for it: see carriableThread.
//
// The source session is left exactly as it was. `thread/fork` mints a new thread
// carrying a copy of the conversation (`forkedFromId` points back at the source,
// and the source still answers from its own, verified on codex-cli 0.153.0), so
// the new session's turns never land in the source's rollout.
func (a *Agent) ForkSession(_ context.Context, opts agent.ForkOptions) (bool, error) {
	log := slog.With("sessionId", opts.SessionID, "sourceSessionId", opts.SourceSessionID)

	threadID, turnID, ok := carriableThread(opts, log)
	if !ok {
		// Nothing is written: a session with no recorded state starts a new
		// thread, which is exactly what a fork that carries nothing should do.
		// (Claude has to write one here because its resume state also records
		// whether a session has ever run; Codex's records only where its
		// conversation is, so its absence already says "nowhere".)
		return false, nil
	}

	state := codexResumeState{ThreadID: threadID, ForkAtTurnID: turnID}
	if err := seedForkIntent(opts, state); err != nil {
		return false, err
	}
	log.Info("forked codex session will fork the source's thread",
		"codexThreadId", threadID, "lastTurnId", turnID)
	return true, nil
}

// carriableThread returns the thread the fork can be taken from and the turn to
// take it through, or false when there is nothing the fork can reopen.
//
// A cut is not optional. The fork is taken when the new session first launches,
// not when the user asked for it, and nothing keeps them from talking to the
// source in between: an uncut copy would carry whatever the source has grown to
// by then, which is precisely the conversation they forked away from. Only a
// point pinned by turn id makes the copy independent of when it is made.
func carriableThread(opts agent.ForkOptions, log *slog.Logger) (threadID, turnID string, ok bool) {
	turnID = agent.LastProviderMessageID(opts.History)
	if turnID == "" {
		// History written before Pockode recorded Codex's turn ids, or a session
		// the agent never spoke in — in which case there is no memory to carry in
		// the first place, however long the source went on.
		log.Info("fork keeps no codex context: the kept history names no turn to cut the conversation at")
		return "", "", false
	}

	state, found := loadResumeState(resumeStatePath(opts.DataDir, opts.SourceSessionID), log)
	if !found || state.ThreadID == "" {
		log.Info("fork keeps no codex context: the source has no thread recorded")
		return "", "", false
	}
	// Not checked against the thread: a session that once degraded to a new
	// thread has history naming turns of the old one, and an anchor that lands
	// there is a fork Codex will refuse. Nothing here can tell those turn ids
	// apart — only the thread knows which turns are its own — so the answer comes
	// from the one place that can ask: the fork is attempted at first launch and
	// degrades to a new thread, with the user told, exactly as an unreopenable
	// source does.
	//
	// The source can itself be a fork that has not launched yet, in which case
	// the thread named here is its own source's and state.ForkAtTurnID is where
	// it will be cut. Forking that thread directly is still right, and our own
	// cut still wins: this fork kept a prefix of what the source kept, so every
	// turn in our history is a turn of that same thread, at or before the
	// source's own anchor.
	return state.ThreadID, turnID, true
}

// seedForkIntent writes the state the forked session's first launch reads.
//
// Unlike the store's record it reports failure: nothing has opened a thread for
// this session yet, so an unwritten file is not a stale mapping that the next
// launch repairs — it is the whole answer to how this session opens, and a fork
// whose answer was lost would silently start an empty conversation after telling
// the user it had carried one.
func seedForkIntent(opts agent.ForkOptions, state codexResumeState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal codex resume state: %w", err)
	}
	if err := filestore.WriteFileAtomic(resumeStatePath(opts.DataDir, opts.SessionID), data, 0644); err != nil {
		return fmt.Errorf("write codex resume state: %w", err)
	}
	return nil
}
