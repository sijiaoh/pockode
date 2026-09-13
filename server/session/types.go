package session

import (
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

var ErrSessionNotFound = errors.New("session not found")

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

// Mode represents the agent mode for a session.
type Mode string

const (
	ModeDefault Mode = "default" // Normal mode with permission prompts
	// Each agent gives up its own gate: Claude runs with
	// --permission-mode bypassPermissions, Codex with approval-policy "never"
	// and its sandbox at danger-full-access. See agent/claude/claude.go and
	// agent/codex/codex.go buildStartConfig.
	ModeYolo Mode = "yolo"
	// ModePlan Mode = "plan"    // Planning mode (future)
)

// IsValid returns true if the mode is a known valid mode.
func (m Mode) IsValid() bool {
	switch m {
	case ModeDefault, ModeYolo:
		return true
	default:
		return false
	}
}

// HistorySeq names one record of a session's history: its 1-based position in
// the sequence GetHistory returns.
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

// Index converts to a 0-based index into the records GetHistory returned. Only
// meaningful for a Valid sequence number.
func (s HistorySeq) Index() int { return int(s) - 1 }

// stampHistorySeq returns the records with their sequence numbers written into
// them, which is how a client learns what to quote back — see HistorySeq. The
// stored records are left alone: a sequence number is a record's address in the
// history, not part of the event that was recorded.
//
// firstSeq is where records[0] sits in the whole history, which is what makes
// this usable on a page as well as on the whole of it: a record's address is its
// position in the session's history, not in the slice it happens to be sent in,
// so numbering a page from 1 would hand out the addresses of the oldest records
// instead. PageHistory is the only caller; it is the one place that knows where
// a page starts.
//
// Records are rewritten field by field rather than through a typed struct so
// that a record written by another version of Pockode keeps every field it
// arrived with.
func stampHistorySeq(records []json.RawMessage, firstSeq HistorySeq) []json.RawMessage {
	stamped := make([]json.RawMessage, len(records))
	for i, raw := range records {
		fields := make(map[string]json.RawMessage)
		if err := json.Unmarshal(raw, &fields); err != nil {
			// Not a JSON object, so there is nothing to hang a field on. Passed
			// through unchanged: the client still sees the record, it just cannot
			// name it.
			stamped[i] = raw
			continue
		}

		if _, addressed := fields["seq"]; addressed {
			// Already answered for: a record the store synthesized rather than read
			// from the file says so by carrying seq 0, and must not be given the
			// address of a record that does exist. See historyWarning.
			stamped[i] = raw
			continue
		}

		fields["seq"] = json.RawMessage(strconv.Itoa(int(firstSeq) + i))
		out, err := json.Marshal(fields)
		if err != nil {
			stamped[i] = raw
			continue
		}
		stamped[i] = out
	}
	return stamped
}

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
}

// SessionMeta holds metadata for a chat session.
// These fields represent the conversation's state, not the process's state.
// A process may be created, reaped, and recreated many times within a single
// session, but NeedsInput and Unread persist across those process lifecycles.
type SessionMeta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	Activated bool      `json:"activated"`  // true once the agent has produced output
	AgentType AgentType `json:"agent_type"` // which AI backend (claude, codex)
	Mode      Mode      `json:"mode"`       // agent mode (default, yolo, plan)
	// Model is agent-specific (see model.go). Empty — the value every session
	// created before this field existed carries — means no model flag is passed
	// and the CLI picks for itself.
	Model string `json:"model"`
	// Effort is agent-specific (see effort.go). Empty — the value every session
	// created before this field existed carries — means the CLI is passed no
	// effort level and keeps its own default.
	Effort     string `json:"effort"`
	NeedsInput bool   `json:"needs_input"` // true when waiting for user input (permission/question)
	Unread     bool   `json:"unread"`      // true when session has unread changes
	// ForkedFrom is set on a session created by forking another, and never
	// changes afterwards: where a conversation came from is a fact about its
	// birth, not a live relationship.
	ForkedFrom *ForkOrigin `json:"forked_from,omitempty"`
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
