package session

import (
	"errors"
	"time"
)

var ErrSessionNotFound = errors.New("session not found")

// ErrSessionStarted refuses a change to something fixed when the first message
// was delivered (SessionMeta.Started).
var ErrSessionStarted = errors.New("session has already started")

// AgentType identifies which AI agent backend a session uses.
type AgentType string

const (
	AgentTypeClaude AgentType = "claude"
	AgentTypeCodex  AgentType = "codex"
)

// IsValid returns true if the agent type is a known valid type.
func (a AgentType) IsValid() bool {
	switch a {
	case AgentTypeClaude, AgentTypeCodex:
		return true
	default:
		return false
	}
}

// DisplayName is how the agent is named in text a user reads. Kept next to the
// type so a message written on the server and one written in the UI cannot end up
// calling the same agent two different things.
func (a AgentType) DisplayName() string {
	switch a {
	case AgentTypeClaude:
		return "Claude"
	case AgentTypeCodex:
		return "Codex"
	default:
		return string(a)
	}
}

// HasPermissionReviewer reports whether Pockode has permission reviewer logic
// for the agent, which is what decides whether its unattended sessions'
// requests are routed to a reviewer (permreview.Service).
//
// Unattended is defined the same way for every agent: YOLO, and any
// permission request the agent still raises under YOLO is answered by the
// permission reviewer. Claude still raises some (its own safety checks that
// bypassPermissions cannot skip), so it has a reviewer. Codex under YOLO
// (approvalPolicy "never") never raises one, so a reviewer could never be
// triggered, and Pockode provides no reviewer logic for it. The mode is still
// valid for Codex sessions; it simply never reaches a review.
func (a AgentType) HasPermissionReviewer() bool {
	return a == AgentTypeClaude
}

// Mode represents the agent mode for a session.
type Mode string

const (
	// Pockode overrides nothing: each agent CLI applies its user's own
	// permission settings, whatever prompts those lead to.
	ModeDefault Mode = "default"
	// Each agent gives up its own gate: Claude runs with
	// --permission-mode bypassPermissions, Codex with approval-policy "never"
	// and its sandbox at danger-full-access. See claude.buildArgs and
	// codex.appSession.buildThreadParams.
	ModeYolo Mode = "yolo"
	// ModeUnattended is more permissive than YOLO, not a restriction of it: the
	// agent runs exactly as under YOLO, and every permission request it still
	// raises under YOLO (Claude's own safety checks that bypassPermissions
	// cannot skip) is answered by the session's permission reviewer instead of
	// waiting for a person. Codex raises none under YOLO, so for it there is
	// nothing to review (AgentType.HasPermissionReviewer). See
	// docs/unattended-mode.md.
	ModeUnattended Mode = "unattended"
	// ModePlan Mode = "plan"    // Planning mode (future)
)

// IsValid returns true if the mode is a known valid mode.
func (m Mode) IsValid() bool {
	switch m {
	case ModeDefault, ModeYolo, ModeUnattended:
		return true
	default:
		return false
	}
}

// BypassesAgentGate reports whether the agent CLI is launched with its own
// permission gate given up (see ModeYolo). Unattended launches exactly as YOLO
// does; what it adds happens in Pockode, after a request has been raised.
func (m Mode) BypassesAgentGate() bool {
	return m == ModeYolo || m == ModeUnattended
}

// HistorySeq names one record of a session's history. It is stored in the
// record (see historyFormatVersion) and unique and increasing within the
// session. A record stored without one is numbered one past the record before
// it (HistorySeqs), so in a file written before seqs were stored it is the
// 1-based position among readable records such a record was always given.
//
// It is not promised to be dense. Appends are not fsynced, so a power loss can
// drop records a client was already told about, and the counter goes on from
// what survived on disk. A client therefore never does arithmetic on one: it
// quotes back a seq it was handed.
//
// It exists because a client cannot count history records for itself. It is
// never told about every record that is stored — a permission or question answer
// is appended without being broadcast, and a client's own message comes back to
// it only as its own local echo — so a counter kept on the client drifts, and
// silently: nothing about a fork cut one record off looks wrong. A number the
// server hands out and the client only ever quotes back cannot drift. The
// numbers a client knows are therefore sparse, which is harmless, because the
// only records it ever names are ones it has seen.
type HistorySeq int

// NoHistorySeq is the zero value, meaning "no record": what an append that
// failed reports, and what a notification carries for an event that was never
// persisted. Sequence numbers start at 1 so that this stays distinguishable from
// the first record on the wire, where an absent field reads as zero.
const NoHistorySeq HistorySeq = 0

// Valid reports whether the sequence number names a record at all.
func (s HistorySeq) Valid() bool { return s > 0 }

// ForkOrigin records the session a session was forked from.
//
// The parent's ID only, deliberately: a copy of its title here would go stale
// the moment the parent is renamed, and a record that reports a name the parent
// no longer has is worse than one the client resolves against the session list
// it already holds — where a parent that is gone is simply absent.
type ForkOrigin struct {
	SessionID string `json:"session_id"`
}

// CreateSpec is the engine a new session is born with. One struct rather than
// four parameters because the four are validated against each other: a model or
// effort only means anything next to the agent type it was chosen for.
//
// Every field may be empty. An empty AgentType or Mode falls back to the
// server's built-in default; an empty Model or Effort means the CLI is passed
// no flag and decides for itself.
type CreateSpec struct {
	AgentType AgentType
	Mode      Mode
	Model     string
	Effort    string
}

// ForkSpec describes a session created as a copy of another one. Everything a
// fork inherits is decided here, in one place, and written in one index update:
// a fork that flickered through three states on its way into the session list
// would be visible to every client watching.
type ForkSpec struct {
	// Source is the session being forked.
	Source SessionMeta
	// Title names the fork. Empty copies the source's title.
	Title string
	// Activated reports whether the copied history already holds agent output,
	// which makes the fork a session that has run — see SessionMeta.Activated.
	Activated bool
	// Unanswered are the questions still open at the point the copy was cut,
	// derived from the copied records themselves (projection.State.Unanswered).
	// Their request ids are unchanged: the fork inherits the questions, it does
	// not ask them again.
	Unanswered []PendingQuestion
	// PagesThrough is the highest html page the copied records name
	// (htmlpage.HighestInRecords). The fork is given the source's pages up to
	// it, and numbers its own past every page the source has (htmlpage.Clone).
	PagesThrough int
}

// SessionMeta holds metadata for a chat session.
// These fields represent the conversation's state, not the process's state.
// A process may be created, reaped, and recreated many times within a single
// session, but Turn and Unread persist across those process lifecycles.
type SessionMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Activated bool      `json:"activated"`  // true once the agent has produced output
	AgentType AgentType `json:"agent_type"` // which AI backend (claude, codex)
	Mode      Mode      `json:"mode"`       // agent mode (default, yolo, unattended)
	// Model is agent-specific (see model.go). Empty — the value every session
	// created before this field existed carries — means no model flag is passed
	// and the CLI picks for itself.
	Model string `json:"model"`
	// Effort is agent-specific (see effort.go). Empty — the value every session
	// created before this field existed carries — means the CLI is passed no
	// effort level and keeps its own default.
	Effort string `json:"effort"`
	// HTMLFirst is how the agent is set up: false is an ordinary chat, true adds
	// agent.HTMLFirstGuidance to its system prompt after the environment
	// statement every session has, telling it to say things with pages.
	// It is a draft until Started and fixed from then on — see SetHTMLFirst.
	HTMLFirst bool `json:"html_first,omitempty"`
	// Started is set immediately before the first message is delivered to the
	// agent, and never cleared. It is what fixes HTMLFirst, and it cannot be
	// Activated: that is set when the agent first *answers*, so between the
	// first delivery and the first output a switch would still be accepted for
	// an agent already told the other guidance. A fork is started from birth.
	Started bool `json:"started"`
	// Turn is what this session is doing, and the only place that is recorded.
	// It is written by nothing but the reducer (see turn.go), and everything that
	// used to be a flag of its own — the session's needs_input, the process's
	// "a prompt is pending" and "the turn has ended" — is now read off it.
	//
	// Persisted because the question it answers outlives any process: a session
	// whose CLI was killed with the server still has to be able to say that the
	// turn it was in the middle of was aborted, and the CLI's own transcript
	// cannot be asked (it may not even hold the message that raised the question).
	Turn   TurnState `json:"turn"`
	Unread bool      `json:"unread"` // true when session has unread changes
	// ForkedFrom is set on a session created by forking another, and never
	// changes afterwards: where a conversation came from is a fact about its
	// birth, not a live relationship.
	ForkedFrom *ForkOrigin `json:"forked_from,omitempty"`
	// PermissionReviewerOf is set on a permission reviewer session and names the
	// main session whose permission requests it answers; empty on every other
	// session. Like ForkedFrom it is fixed at birth (CreatePermissionReviewer):
	// a reviewer belongs to one main session for life, is deleted with it, and
	// takes no input from a person.
	PermissionReviewerOf string `json:"permission_reviewer_of,omitempty"`
	// Usage is what this session has consumed, accumulated from what its agent
	// reported (see usage.go). A fork starts it empty rather than copying the
	// source's: the tokens behind the copied history were spent by the source,
	// and counting them in both would make any sum over sessions wrong.
	//
	// It can span two agents. A session that burned tokens on a first turn the
	// agent never answered is still unactivated, and that is exactly the session
	// whose agent type the user is allowed to change (see
	// ws.handleSessionSetAgentType) — the spent tokens stay counted, so a cost
	// recorded before the switch covers only the part the pricing agent ran.
	Usage Usage `json:"usage"`
}

// IsPermissionReviewer reports whether this session is some main session's
// permission reviewer (see PermissionReviewerOf).
func (m SessionMeta) IsPermissionReviewer() bool {
	return m.PermissionReviewerOf != ""
}

// Cursor is this session's position in the list's sort order. See ListCursor.
func (m SessionMeta) Cursor() ListCursor {
	return ListCursor{UpdatedAt: m.UpdatedAt, ID: m.ID}
}

// Operation represents the type of change to the session list.
type Operation string

const (
	OperationCreate Operation = "create"
	OperationUpdate Operation = "update"
	OperationDelete Operation = "delete"
)

// SessionChangeEvent represents a change to one session.
// For create/update: Session is fully populated.
// For delete: only Session.ID is valid.
type SessionChangeEvent struct {
	Op      Operation
	Session SessionMeta
}

// OnChangeListener receives notifications when a session changes.
//
// OnSessionChange is called with the store's lock held, so an implementation
// must neither block nor call back into the store — do what SessionListWatcher
// and SessionDetailWatcher do and queue the event. The lock is held on purpose:
// it is what makes listeners see changes in the order they were written, which
// the watchers' incremental notifications depend on.
type OnChangeListener interface {
	OnSessionChange(event SessionChangeEvent)
}
