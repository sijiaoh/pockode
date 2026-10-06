package mcp

import "github.com/pockode/server/work"

// Caller identifies the agent session a tool call came from. The CLI is spawned
// with it (see agent/claude and agent/codex), the stdio proxy carries it on
// every forwarded call, and the executor uses it to act on the caller's own
// session without the model having to name it.
//
// It is self-reported, not a credential: the local API is loopback-only and its
// token already authorizes everything, so there is nothing an agent could gain
// by claiming another session's id. Do not build authorization on it.
type Caller struct {
	// SessionID is the session whose CLI process made the call. Empty when the
	// proxy was started without an identity — a call from outside a session.
	SessionID string `json:"session_id,omitempty"`
	// Worktree is the name of the worktree that session lives in. Empty means
	// the main worktree, so it is only meaningful together with SessionID.
	Worktree string `json:"worktree,omitempty"`
}

// watcher is the caller as a story's watcher: the one place story_start,
// story_unwatch and story_list agree on who "this chat" is, so a watch one of
// them sets is the watch the others recognise. Only meaningful with a SessionID.
func (c Caller) watcher() work.Watcher {
	return work.Watcher{SessionID: c.SessionID, Worktree: c.Worktree}
}
