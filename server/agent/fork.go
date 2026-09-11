package agent

import (
	"context"
	"encoding/json"
)

// ForkSupport states how much of a conversation an agent can follow into a fork.
// It is what everything outside an agent's package reads instead of asking which
// agent it is holding, and it is what the frontend is sent (rpc.AgentInfo's
// fork_support) so that it does not keep a table of its own.
//
// It stays a named string rather than collapsing into a bool, even though the
// only question asked of it today is CanFork. The values are not "yes" and "no"
// but distinct capabilities, and a third is already in sight: `codex exec fork`
// reopens a whole session and nothing finer, so an agent reachable only that way
// would fork from the end of a conversation and from nowhere else — a value the
// frontend has to tell apart from both of today's, since it decides which
// messages offer the row and what a disabled row says. A bool would have to grow
// back into this the day that happens, and it is a wire field, so growing it
// back costs a synchronised change on both sides.
type ForkSupport string

const (
	// ForkUnsupported: the agent cannot reopen an earlier conversation at all.
	// Forking such a session could only ever produce one whose agent has never
	// seen the transcript the user is looking at, so Pockode does not offer it and
	// session.fork refuses it.
	//
	// No agent returns this value. It is what ForkSupportOf answers for an agent
	// that implements no SessionForker, which is how an agent says it cannot be
	// forked.
	ForkUnsupported ForkSupport = "none"

	// ForkFromAnyMessage: the agent can reopen a conversation at a chosen point in
	// it, so a fork can carry the agent's memory of everything it kept wherever
	// the anchor sits. Whether a given fork does is still ForkSession's answer —
	// the source itself may have nothing reopenable.
	ForkFromAnyMessage ForkSupport = "any_message"
)

// CanFork reports whether a fork of this agent's session is worth creating at all.
//
// Written as "the one that can" rather than "not the one that cannot", so that a
// ForkSupport nobody set reads as the answer that refuses rather than the one
// that forks.
func (s ForkSupport) CanFork() bool {
	return s == ForkFromAnyMessage
}

// ForkSupportOf reports what an agent says about being forked.
//
// Implementing SessionForker is the declaration, so this is the only way to ask
// the question: an agent that does not implement it cannot be forked, and
// implementing nothing is the whole of what opting out takes (see agent/codex).
func ForkSupportOf(a Agent) ForkSupport {
	forker, ok := a.(SessionForker)
	if !ok {
		return ForkUnsupported
	}
	return forker.ForkSupport()
}

// ForkOptions describes a fork Pockode has already carried out on its own side:
// the new session exists and holds the source session's history, cut at the fork
// point. What is left is to give the new session the agent's own view of that
// same conversation.
//
// It deliberately says nothing about the source's current state — whether records
// exist past the fork point, whether a process is still writing them. The fork
// point is in History and nowhere else, so whatever the source does afterwards
// falls past it by construction. Anything sampled from the source here would be
// stale by the time it mattered: see SessionForker for when that is.
type ForkOptions struct {
	// WorkDir and DataDir belong to the forked session and therefore to the
	// source as well: a fork always lands in the worktree it was forked from.
	WorkDir string
	DataDir string

	SourceSessionID string
	// SessionID is the new session. Its directory under DataDir may not exist yet.
	SessionID string

	// History is the forked session's entire history — the source's records up to
	// and including the fork point, with the events the cut left unpaired already
	// removed. The agent reads it to find, in its own transcript, the point the
	// fork was taken at.
	History []json.RawMessage
}

// SessionForker is an agent's whole answer on being forked: the capability and
// the work behind it are one declaration, so an agent that cannot be forked
// implements nothing at all, and one that can cannot promise a capability it has
// no code for. Ask ForkSupportOf whether an agent can be forked; assert for this
// interface only when there is a fork to carry out.
type SessionForker interface {
	// ForkSupport says where in a conversation a fork of this agent's sessions may
	// be taken from. It never answers ForkUnsupported: that is said by not
	// implementing this interface.
	ForkSupport() ForkSupport

	// ForkSession gives an already-forked session the agent's own view of the
	// conversation it inherited. It is called once the new session and its history
	// exist and before any process is started for it. An implementation may write
	// session-scoped state (a resume mapping) but must not assume a live process on
	// either side.
	//
	// What it writes is acted on at the forked session's first launch, which is
	// when the user first types into it — possibly days later, and possibly after
	// they have gone back to talking to the source. An implementation therefore
	// cannot resolve anything against how either session looks right now; it can
	// only leave behind an instruction that stays correct however long it waits.
	//
	// It reports whether the agent will actually arrive in the new session
	// remembering the conversation. Returning false is a normal answer, not a
	// failure: the source may turn out to have no conversation worth reopening. The
	// caller tells the user. Returning an error is different: the caller deletes
	// the half-made session and reports it.
	ForkSession(ctx context.Context, opts ForkOptions) (carried bool, err error)
}

// TruncateHistory returns the history records up to and including keepThrough,
// dropping those the cut left dangling: a tool call whose result came after the
// fork point, and a permission or question prompt whose answer did. keepThrough
// must be a valid index into records.
//
// Dropping is the only option that keeps the transcript honest. Keeping a
// dangling call would show a tool that never returns, and would hand the next
// agent a conversation claiming a call is still outstanding; extending the cut
// forward to the answer instead would copy back part of the very turn the user
// forked away from.
//
// A record that does not parse as an event is kept as it is: it cannot be
// paired, and losing history over a parse failure is the larger harm.
func TruncateHistory(records []json.RawMessage, keepThrough int) []json.RawMessage {
	kept := records[:keepThrough+1]

	settledTools := make(map[string]struct{})
	settledRequests := make(map[string]struct{})
	parsed := make([]*EventRecord, len(kept))

	for i, raw := range kept {
		var rec EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		parsed[i] = &rec

		switch rec.Type {
		case EventTypeToolResult:
			settledTools[rec.ToolUseID] = struct{}{}
		case EventTypePermissionResponse, EventTypeQuestionResponse, EventTypeRequestCancelled:
			settledRequests[rec.RequestID] = struct{}{}
		}
	}

	result := make([]json.RawMessage, 0, len(kept))
	for i, raw := range kept {
		if rec := parsed[i]; rec != nil && danglesAfterCut(*rec, settledTools, settledRequests) {
			continue
		}
		result = append(result, raw)
	}
	return result
}

// danglesAfterCut reports whether rec opens a pair that nothing in the kept
// records closes.
//
// An event with no ID to pair on is never dangling: it could not have been
// paired before the fork either, so dropping it would remove history the source
// session still shows.
func danglesAfterCut(rec EventRecord, settledTools, settledRequests map[string]struct{}) bool {
	switch rec.Type {
	case EventTypeToolCall:
		if rec.ToolUseID == "" {
			return false
		}
		_, settled := settledTools[rec.ToolUseID]
		return !settled
	case EventTypePermissionRequest, EventTypeAskUserQuestion:
		if rec.RequestID == "" {
			return false
		}
		_, settled := settledRequests[rec.RequestID]
		return !settled
	default:
		return false
	}
}

// HistoryActivatesSession reports whether these records put anything on the
// agent's side of the conversation, which is what makes a session "started" —
// see EventType.ActivatesSession. A session created from copied history is
// therefore activated at birth, without an agent having run for it yet.
func HistoryActivatesSession(records []json.RawMessage) bool {
	for _, raw := range records {
		var rec EventRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		if rec.Type.ActivatesSession() {
			return true
		}
	}
	return false
}
