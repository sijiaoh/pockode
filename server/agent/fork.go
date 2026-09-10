package agent

import (
	"context"
	"encoding/json"
)

// ForkSupport states how much of a conversation an agent can follow into a fork:
// it is the agent's own answer to "can you be forked, and from where".
//
// It exists so that nothing outside an agent's package has to know which agent it
// is talking to. Every difference between the agents on this subject is one of
// these two values, and the values are the two that are true today — an agent
// whose CLI cannot reopen a conversation, and one that can reopen one at a chosen
// point in it.
type ForkSupport string

const (
	// ForkUnsupported: the agent cannot reopen an earlier conversation at all.
	// Forking such a session could only ever produce one whose agent has never
	// seen the transcript the user is looking at, so Pockode does not offer it and
	// session.fork refuses it.
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

// ForkOptions describes a fork Pockode has already carried out on its own side:
// the new session exists and holds the source session's history, cut at the fork
// point. What is left is to give the new session the agent's own view of that
// same conversation.
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

	// Truncated reports that the source had records after the fork point, so
	// context past it must not carry over. False means the fork keeps the whole
	// conversation, which is the case an agent can serve by resuming it as it is.
	//
	// It constrains only a replay with no point pinned to stop at: with a point
	// pinned, everything past it falls outside the replay anyway. Claude reads it
	// for the fallback where the kept records name no message the CLI's
	// transcript can be cut at.
	Truncated bool

	// SourceProcessLive reports that the source session still has an agent process
	// running, so its own transcript can grow at any moment — during this call, and
	// after it.
	//
	// It is the reason Truncated alone is not enough to decide that resuming the
	// source is safe. A CLI asked to reopen a conversation reads whatever that
	// conversation's transcript holds when it gets there, not what it held when the
	// fork was taken: with a live process that is a moving target, and everything
	// past the fork point is precisely what must not come across. Like Truncated,
	// it constrains only a replay with no point pinned to stop at.
	SourceProcessLive bool
}

// SessionForker is the work behind a ForkSupport declaration: every agent whose
// ForkSupport is not ForkUnsupported implements it, and one that declares
// ForkUnsupported is never asked (chat.Client refuses the fork before there is
// anything to ask about).
//
// ForkSession is called once the new session and its history exist and before any
// process is started for it. An implementation may write session-scoped state (a
// resume mapping) but must not assume a live process on either side.
//
// It reports whether the agent will actually arrive in the new session
// remembering the conversation. Returning false is a normal answer, not a
// failure: the source may turn out to have no conversation worth reopening. The
// caller tells the user. Returning an error is different: the caller deletes the
// half-made session and reports it.
type SessionForker interface {
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
