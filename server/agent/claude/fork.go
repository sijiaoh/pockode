package claude

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/filestore"
)

// process.Manager reaches ForkSession through a type assertion whose failure
// means "this agent cannot fork", and that fallback is silent: a signature
// drifting out of the interface would not break the build, it would quietly
// stop every Claude fork from carrying its conversation.
var _ agent.SessionForker = (*Agent)(nil)

// ForkSupport implements agent.Agent: Claude can reopen a conversation at a
// chosen message in it, so a fork taken anywhere in one can carry the agent's
// side of it — `--resume-session-at <uuid>` is the capability, ForkSession is how
// it is used.
//
// This is the declaration for what the CLI can do. An individual fork can still
// come back carrying nothing — a source whose records predate Pockode storing
// the CLI's message uuids, or one that never ran Claude — which is a fact about
// that source, not about the agent, and ForkSession reports it per fork.
func (a *Agent) ForkSupport() agent.ForkSupport {
	return agent.ForkFromAnyMessage
}

// ForkSession points the forked session at the source's provider session, cut at
// the fork point, so the CLI reopens the conversation no further than the copied
// transcript shows and forks it there (forkAnchorMessage says when "no further"
// is short of the transcript's own end).
//
// The cut is what makes this work for a fork taken in the middle: --resume
// replays a conversation in full, but --resume-session-at <uuid> drops
// everything after that transcript message first. Because the point is pinned
// by message and not by time, it also makes a source with a live process safe —
// whatever the source adds to its own conversation, before this call or long
// after it, falls past the cut and never reaches the new session.
//
// Naming the cut needs the CLI's own uuid for the message, which Pockode only
// has for records written since it started keeping them. Without one the fork
// falls back to what a plain --resume can serve: the whole conversation, from a
// source that cannot be adding to it. Anything else is reported as
// carried == false, which is an answer and not a failure.
//
// The source session is left exactly as it was. Resuming with --fork-session
// makes the CLI mint a new provider session ID for the replayed conversation, so
// the new session's turns never land in the source's transcript, and the source's
// own resume state still names its own provider session.
func (a *Agent) ForkSession(_ context.Context, opts agent.ForkOptions) (bool, error) {
	log := slog.With("sessionId", opts.SessionID, "sourceSessionId", opts.SourceSessionID)

	providerID, resumeAt, ok := carriableProviderSession(opts, log)
	if !ok {
		// The fork still has to say that this session starts its own provider
		// conversation: it was born activated, which would otherwise send the
		// first launch off to resume a provider session that never existed.
		if err := seedResumeState(opts, claudeResumeState{Unstarted: true}); err != nil {
			return false, err
		}
		return false, nil
	}

	// The fork stage, rather than a plain resume, is what keeps the source's
	// transcript out of reach: every launch of this session until one reports a
	// provider ID of its own passes --fork-session, and the ladder only ever
	// escalates away from resuming (fork -> fresh). A plain resume here would
	// write this session's turns into the source's conversation — and with a cut
	// in place it would write them into a conversation it had just shortened.
	state := claudeResumeState{SessionID: providerID, Recovery: recoveryFork, ResumeAt: resumeAt}
	if err := seedResumeState(opts, state); err != nil {
		return false, err
	}
	log.Info("forked claude session will resume the source's provider session",
		"claudeSessionId", providerID, "resumeAt", resumeAt)
	return true, nil
}

// carriableProviderSession returns the provider session the fork can be replayed
// from and the transcript message to stop that replay at, or false when there is
// nothing to replay. An empty resumeAt with ok == true means replay it whole.
func carriableProviderSession(opts agent.ForkOptions, log *slog.Logger) (providerID, resumeAt string, ok bool) {
	resumeAt = forkAnchorMessage(opts.History)
	if resumeAt == "" {
		// No message to cut at: history written before Pockode recorded the CLI's
		// uuids, or a fork taken before the agent had said anything. Only a fork
		// that wants the whole conversation is left, and only from a source that
		// will not be adding to it — the CLI reads the source's transcript when it
		// gets there, not as it was when the fork was taken.
		if opts.Truncated {
			log.Info("fork keeps no claude context: the conversation is cut before its end and holds no message id to cut at")
			return "", "", false
		}
		if opts.SourceProcessLive {
			log.Info("fork keeps no claude context: the source session's transcript can still grow and the fork holds no message id to pin it at")
			return "", "", false
		}
	}

	state, found := loadResumeState(resumeStatePath(opts.DataDir, opts.SourceSessionID), log)
	if !found || state.SessionID == "" {
		log.Info("fork keeps no claude context: the source has no provider session recorded")
		return "", "", false
	}
	if state.Recovery == recoveryFresh {
		// The source gave up on this ID after resuming it failed twice; its own
		// next launch starts a new conversation. Replaying it here would fail
		// the same way, only after telling the user it would not.
		log.Info("fork keeps no claude context: the source's provider session is unusable",
			"claudeSessionId", state.SessionID)
		return "", "", false
	}
	if resumeAt == "" {
		// The source can be a fork that has not launched yet, in which case the
		// session named here is its own source's and is already cut short. With
		// no cut of our own to apply, inherit that one: this fork kept a prefix
		// of what the source kept, so it must not reach further than the source
		// does either.
		resumeAt = state.ResumeAt
	}
	return state.SessionID, resumeAt, true
}

// forkAnchorMessage finds the CLI transcript message the replayed conversation
// should stop at: the last one any record in the forked history came from.
// Empty when no record names one.
//
// It lands at or before the fork point, never past it, which is the direction
// that matters: only records the fork kept are searched. It lands strictly
// before it whenever the last kept records name no message — a fork anchored on
// the user's own message stops at the agent's previous one, because the CLI
// never streams the prompts Pockode sends it and so Pockode has no uuid for
// them. The new session then shows a last message its agent does not have in
// context. Carrying less than the transcript shows is the safe side of that
// mismatch, and it is the only side available.
//
// The message is kept whole. One CLI message can become several Pockode records
// — an assistant turn with text and then a tool call — so a cut between them
// still names the message they share, and the tool call comes across even though
// Pockode's own transcript drops it as dangling. That is the better of the two
// mismatches: the CLI reports a tool call whose result was cut away as failed
// (measured on 2.1.263), whereas stepping back to the previous message would
// take away the very message the user forked at.
func forkAnchorMessage(history []json.RawMessage) string {
	for i := len(history) - 1; i >= 0; i-- {
		var rec agent.EventRecord
		if err := json.Unmarshal(history[i], &rec); err != nil {
			continue
		}
		if rec.ProviderMessageID != "" {
			return rec.ProviderMessageID
		}
	}
	return ""
}

// seedResumeState writes the state the forked session's first launch reads.
//
// Unlike the manager's save it reports failure: nothing has resolved this
// session yet, so an unwritten file is not a stale mapping that the next launch
// repairs — it is the whole answer to how this session opens, and a fork whose
// answer was lost would silently open the wrong conversation or none.
func seedResumeState(opts agent.ForkOptions, state claudeResumeState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal claude resume state: %w", err)
	}
	if err := filestore.WriteFileAtomic(resumeStatePath(opts.DataDir, opts.SessionID), data, 0644); err != nil {
		return fmt.Errorf("write claude resume state: %w", err)
	}
	return nil
}
