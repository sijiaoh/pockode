// Package rpc defines JSON-RPC 2.0 wire format types for WebSocket communication.
// These types represent the params and result structures for all RPC methods.
//
// Where a wire type is a deliberate narrowing of a domain type rather than a
// copy of it, the narrowing lives here too (NewSessionListItem), so that what a
// client is told is decided in one place instead of at each handler.
//
// Subscribe results carry no subscription id: the client named the subscription
// in the request, and echoing it back would invite code that trusts the echo
// over the id it chose itself. A result left with nothing else to say is absent
// too — the handler replies with an empty object.
//
// Unsubscribe params are deliberately absent: every unsubscribe carries the
// same lone subscription id, so the ws package unmarshals them all with one
// internal type instead of one wire type per watcher.
package rpc

import (
	"encoding/json"
	"time"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/agentrole"
	"github.com/pockode/server/command"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
	"github.com/pockode/server/search"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
)

// Client → Server

// SubscribeParams is the whole of a *.subscribe request for a watcher that
// needs nothing but the subscription id, and the documentation of that id for
// the requests that carry more: it is chosen by the client, so that its
// notification callback is in place before the request goes out. See
// watch.BaseWatcher.AddSubscription for why it is not the server's to pick.
type SubscribeParams struct {
	ID string `json:"id"`
}

type AuthParams struct {
	Token    string `json:"token"`
	Worktree string `json:"worktree,omitempty"` // empty = main worktree
}

type AuthResult struct {
	Version      string `json:"version"`
	Title        string `json:"title"`
	WorkDir      string `json:"work_dir"`
	WorktreeName string `json:"worktree_name"`
	// MaxUploadSize is the ceiling on one HTTP upload request, in bytes, sent so
	// a client can refuse an oversized file before spending a slow link on it
	// instead of keeping its own copy of the number (see docs/file.md#transfer).
	// It is the same on every route: the relay tunnel streams a request body and
	// imposes no ceiling of its own.
	MaxUploadSize int64 `json:"max_upload_size"`
}

type MessageParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

// MessageResult tells the sender where its own message landed in the session's
// history, so it can name that record later — to fork from it, above all.
//
// The sender is deliberately left out of the broadcast that carries every other
// record's seq, because it has already echoed the message into its own
// transcript. This reply is therefore the only place it can learn the address of
// the one message it put there itself.
//
// Seq is omitted when the record was not persisted, and a server too old to send
// it omits it too. Both mean the same thing to a client — the message is not
// addressable — which is the state it was already in for every message it sent,
// so neither is an error.
type MessageResult struct {
	Seq session.HistorySeq `json:"seq,omitempty"`
}

type InterruptParams struct {
	SessionID string `json:"session_id"`
}

type PermissionResponseParams struct {
	SessionID             string                   `json:"session_id"`
	RequestID             string                   `json:"request_id"`
	Choice                string                   `json:"choice"` // "deny", "allow", "always_allow"
	ToolInput             json.RawMessage          `json:"tool_input,omitempty"`
	ToolUseID             string                   `json:"tool_use_id,omitempty"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type QuestionResponseParams struct {
	SessionID string            `json:"session_id"`
	RequestID string            `json:"request_id"`
	ToolUseID string            `json:"tool_use_id"`
	Answers   map[string]string `json:"answers"` // nil = cancel
}

// Session management

type SessionDeleteParams struct {
	SessionID string `json:"session_id"`
}

type SessionUpdateTitleParams struct {
	SessionID string `json:"session_id"`
	Title     string `json:"title"`
}

type SessionSetAgentTypeParams struct {
	SessionID string            `json:"session_id"`
	AgentType session.AgentType `json:"agent_type"`
}

type SessionSetModeParams struct {
	SessionID string       `json:"session_id"`
	Mode      session.Mode `json:"mode"`
}

// SessionForkParams asks for a new session holding this session's conversation
// up to the moment before one record of its history happened.
type SessionForkParams struct {
	SessionID string `json:"session_id"` // the session to fork
	// AnchorSeq is the seq of the message the user picked — the number the server
	// put on that record, in the replayed history or in the live notification that
	// delivered it, sent back unchanged.
	//
	// What the fork keeps is the server's to decide: an agent message is kept,
	// a message the user sent is not, because the fork returns to before they
	// sent it (see chat.Client.Fork). A client must not do that arithmetic
	// itself — the seq is an address the server handed out, not an index.
	// The cut need not be the end of a turn.
	AnchorSeq session.HistorySeq `json:"anchor_seq"`
	// Title names the new session. Empty copies the source's title.
	Title string `json:"title,omitempty"`
}

type SessionSetModelParams struct {
	SessionID string `json:"session_id"`
	// Model must be one of session.ModelsForAgent for the session's current
	// agent type, or "" to let the CLI pick.
	Model string `json:"model"`
}

// SessionModelsResult carries the selectable models of every agent type, keyed
// by agent type: switching a session's agent switches which list applies, so
// the UI needs them all.
type SessionModelsResult struct {
	Models map[session.AgentType][]session.AgentOption `json:"models"`
}

type SessionSetEffortParams struct {
	SessionID string `json:"session_id"`
	// Effort must be one of session.EffortsForAgent for the session's current
	// agent type, or "" to let the CLI keep its default.
	Effort string `json:"effort"`
}

// SessionEffortsResult carries the selectable effort levels of every agent
// type. An agent with no effort concept is absent from the map, which the UI
// reads as "nothing to offer" — the same as an empty list.
type SessionEffortsResult struct {
	Efforts map[session.AgentType][]session.AgentOption `json:"efforts"`
}

type SessionMarkReadParams struct {
	SessionID string `json:"session_id"`
}

// File namespace

type FileGetParams struct {
	Path string `json:"path"`
}

type FileGetResult struct {
	Type    string                `json:"type"` // "directory" or "file"
	Entries []contents.Entry      `json:"entries,omitempty"`
	File    *contents.FileContent `json:"file,omitempty"`
}

type FileWriteParams struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// FileCreateParams creates an empty file or directory. Kept apart from
// FileWrite because creation must fail on an existing path where a write must
// not.
type FileCreateParams struct {
	Path string             `json:"path"`
	Type contents.EntryType `json:"type"`
}

type FileDeleteParams struct {
	Path string `json:"path"`
}

type FileSearchParams struct {
	Query string `json:"query"`
	// Mode is "name" (default) or "content".
	Mode string `json:"mode"`
	// Path limits the search to a subdirectory of the work directory.
	Path string `json:"path"`
	// RespectGitignore defaults to true when omitted, so clients opt in to
	// searching ignored files rather than accidentally scanning build output.
	RespectGitignore *bool `json:"respect_gitignore"`
	CaseSensitive    bool  `json:"case_sensitive"`
	MaxResults       int   `json:"max_results"`
}

type FileSearchResult = search.Result

// Git namespace

type GitStatusResult = git.GitStatus

// Git diff watch (subscription for file-specific diff changes)

type GitDiffSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID             string `json:"id"`
	Path           string `json:"path"`
	Staged         bool   `json:"staged"`
	HideWhitespace bool   `json:"hide_whitespace"`
}

type GitDiffSubscribeResult struct {
	Diff       string `json:"diff"`
	OldContent string `json:"old_content"`
	NewContent string `json:"new_content"`
}

// GitPathsParams is used for git.add, git.reset and git.discard operations.
type GitPathsParams struct {
	Paths []string `json:"paths"`
}

// GitCommitParams is the params for git.commit request.
type GitCommitParams struct {
	Message string `json:"message"`
	// Amend replaces the previous commit rather than adding one.
	Amend bool `json:"amend"`
}

// GitLogParams is the params for git.log request.
type GitLogParams struct {
	Limit int `json:"limit,omitempty"` // default 50
}

// GitLogResult is the result of git.log request.
type GitLogResult struct {
	Commits []git.Commit `json:"commits"`
}

// GitShowParams is the params for git.show request.
type GitShowParams struct {
	Hash string `json:"hash"`
}

// GitShowResult is the result of git.show request.
type GitShowResult = git.ShowResult

// GitShowDiffParams is the params for git.show.diff request.
type GitShowDiffParams struct {
	Hash           string `json:"hash"`
	Path           string `json:"path"`
	HideWhitespace bool   `json:"hide_whitespace"`
}

// GitShowDiffResult is the result of git.show.diff request.
type GitShowDiffResult = git.DiffResult

// GitShowFileParams is the params for git.show.file request.
type GitShowFileParams struct {
	Hash string `json:"hash"`
	Path string `json:"path"`
}

// GitShowFileResult is the result of git.show.file request. It is the same
// shape file.get returns for a file, so the client renders both the same way.
type GitShowFileResult = contents.FileContent

// GitBranchesResult is the result of git.branches request.
type GitBranchesResult = git.BranchList

// GitCheckoutParams is the params for git.checkout request.
type GitCheckoutParams struct {
	Branch string `json:"branch"`
}

// GitBranchCreateParams is the params for git.branch.create request.
type GitBranchCreateParams struct {
	Name string `json:"name"`
}

// GitPullResult is the result of git.pull request.
type GitPullResult struct {
	// Commits is how many the fast-forward brought in, measured by the server:
	// pull fetches first, so the panel's behind count can be out of date.
	Commits int `json:"commits"`
}

// GitPushParams is the params for git.push request.
type GitPushParams struct {
	// Force pushes with --force-with-lease. The UI offers it only where a plain
	// push cannot succeed, behind a confirmation.
	Force bool `json:"force"`
}

// Command namespace

type CommandListResult struct {
	Commands []command.Command `json:"commands"`
}

// FS namespace

type FSSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID   string `json:"id"`
	Path string `json:"path"`
}

// Session list watch (subscription for session list changes)

// SessionListItem is one row of the session list: what drawing a row needs, and
// nothing more.
//
// The rest of a session's metadata — mode, agent type, model, effort, activated,
// CreatedAt — is reported by session.detail.subscribe, for the one session a
// client has open. It is not here because the list goes to every subscriber on
// every change, and a model chosen in one session is not news to a client
// reading another.
//
// Two fields appear on both sides, and neither can drift: State is volatile
// process state that the list owns outright and detail never carries
// (server/watch/session_detail.go), and ForkedFrom is fixed at the session's
// birth and never written again.
type SessionListItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// UpdatedAt is the row's subtitle, and what the list is ordered by.
	UpdatedAt  time.Time           `json:"updated_at"`
	State      string              `json:"state"` // "idle" | "running" | "ended"
	NeedsInput bool                `json:"needs_input"`
	Unread     bool                `json:"unread"`
	ForkedFrom *session.ForkOrigin `json:"forked_from,omitempty"`
}

// NewSessionListItem builds the row for a session in a given process state.
// Every producer of a row goes through here so that narrowing SessionMeta down
// to a row is decided in one place.
func NewSessionListItem(meta session.SessionMeta, state string) SessionListItem {
	return SessionListItem{
		ID:         meta.ID,
		Title:      meta.Title,
		UpdatedAt:  meta.UpdatedAt,
		State:      state,
		NeedsInput: meta.NeedsInput,
		Unread:     meta.Unread,
		ForkedFrom: meta.ForkedFrom,
	}
}

type SessionListSubscribeResult struct {
	Sessions []SessionListItem `json:"sessions"`
}

// Session detail watch (subscription for a single session's metadata)

type SessionDetailSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
}

type SessionDetailSubscribeResult struct {
	Session session.SessionMeta `json:"session"`
}

// Chat messages watch (subscription for chat messages)

type ChatMessagesSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
	// Limit caps how many of the newest history records come back. Zero asks for
	// session.DefaultHistoryPageSize; anything above session.MaxHistoryPageSize is
	// clamped to it.
	Limit int `json:"limit,omitempty"`
}

type ChatMessagesSubscribeResult struct {
	// History is the newest page of the session's history, oldest record first.
	// Earlier pages are fetched with chat.messages.history.
	History []json.RawMessage `json:"history"`
	// HasMore reports whether records older than History[0] exist.
	HasMore bool `json:"has_more"`
	// NextBeforeSeq is the cursor for the page before this one; absent when
	// HasMore is false. See ChatMessagesHistoryParams.BeforeSeq.
	NextBeforeSeq session.HistorySeq `json:"next_before_seq,omitempty"`
	State         string             `json:"state"` // "idle" | "running" | "ended"
}

// ChatMessagesHistoryParams asks for the page of history older than one the
// client already holds. It needs no subscription: an older page is settled
// history, so it can never change and can never collide with what the
// subscription streams, which is always newer than the page subscribing returned.
type ChatMessagesHistoryParams struct {
	SessionID string `json:"session_id"`
	// BeforeSeq is exclusive: the reply holds the records immediately older than
	// the record it names. It must be a cursor the server handed out
	// (next_before_seq) — a client cannot derive one, because a record the server
	// could not stamp carries no seq at all. Zero asks for the newest page.
	BeforeSeq session.HistorySeq `json:"before_seq,omitempty"`
	// Limit follows ChatMessagesSubscribeParams.Limit.
	Limit int `json:"limit,omitempty"`
}

type ChatMessagesHistoryResult struct {
	// History is the page, oldest record first. Empty when BeforeSeq already
	// named the first record of the session.
	History       []json.RawMessage  `json:"history"`
	HasMore       bool               `json:"has_more"`
	NextBeforeSeq session.HistorySeq `json:"next_before_seq,omitempty"`
}

// Worktree namespace

type WorktreeInfo struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	IsMain bool   `json:"is_main"`
}

// SetupHookSkip tells the client that the worktree setup hook does not run on
// this machine, and why. Absent means it runs.
type SetupHookSkip struct {
	Reason string `json:"reason"`
	Hint   string `json:"hint"`
}

type WorktreeListResult struct {
	Worktrees []WorktreeInfo `json:"worktrees"`
	// SetupHookSkip is set when creating a worktree *would* skip the hook, so
	// the client can say so before the user creates one.
	SetupHookSkip *SetupHookSkip `json:"setup_hook_skip,omitempty"`
}

type WorktreeCreateParams struct {
	Name       string `json:"name"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"base_branch,omitempty"`
}

type WorktreeCreateResult struct {
	Worktree WorktreeInfo `json:"worktree"`
	// SetupHookSkip is set when this worktree was created but its setup hook
	// did not run. Creation still succeeded, so this cannot be an RPC error.
	SetupHookSkip *SetupHookSkip `json:"setup_hook_skip,omitempty"`
}

type WorktreeDeleteParams struct {
	Name string `json:"name"`
}

// WorktreeDeletedParams is sent to clients when a worktree they are connected to is deleted.
type WorktreeDeletedParams struct {
	Name string `json:"name"`
}

// WorktreeSwitchParams is the params for the worktree.switch request.
type WorktreeSwitchParams struct {
	Name string `json:"name"` // empty = main worktree
}

// WorktreeSwitchResult is the result of the worktree.switch request.
type WorktreeSwitchResult struct {
	WorkDir      string `json:"work_dir"`
	WorktreeName string `json:"worktree_name"`
}

// Server → Client (used in tests for notification parsing)

type PermissionRequestParams struct {
	SessionID             string                   `json:"session_id"`
	RequestID             string                   `json:"request_id"`
	ToolName              string                   `json:"tool_name"`
	ToolInput             json.RawMessage          `json:"tool_input"`
	ToolUseID             string                   `json:"tool_use_id"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type AskUserQuestionParams struct {
	SessionID string                  `json:"session_id"`
	RequestID string                  `json:"request_id"`
	ToolUseID string                  `json:"tool_use_id"`
	Questions []agent.AskUserQuestion `json:"questions"`
}

// Agent namespace

// AgentInfo describes one registered agent type: what the server knows about it
// that a client cannot work out from its name.
type AgentInfo struct {
	Type session.AgentType `json:"type"`
	// ForkSupport is the agent's own declaration of whether it can follow a fork
	// of a conversation, and from where, sent so that the frontend asks what an
	// agent can do instead of keeping a second copy of the answer per agent name.
	ForkSupport agent.ForkSupport `json:"fork_support"`
}

type AgentListResult struct {
	Agents []AgentInfo `json:"agents"`
}

// Settings namespace

type SettingsSubscribeResult struct {
	Settings settings.Settings `json:"settings"`
}

type SettingsUpdateParams struct {
	Settings settings.Settings `json:"settings"`
}

// Work namespace

type WorkCreateParams struct {
	Type        work.WorkType `json:"type"`
	ParentID    string        `json:"parent_id,omitempty"`
	AgentRoleID string        `json:"agent_role_id"`
	Title       string        `json:"title"`
	Body        string        `json:"body,omitempty"`
}

type WorkUpdateParams struct {
	ID          string  `json:"id"`
	Title       *string `json:"title,omitempty"`
	Body        *string `json:"body,omitempty"`
	AgentRoleID *string `json:"agent_role_id,omitempty"`
}

type WorkDeleteParams struct {
	ID string `json:"id"`
}

type WorkStartParams struct {
	ID string `json:"id"`
}

type WorkStopParams struct {
	ID string `json:"id"`
}

type WorkReopenParams struct {
	ID string `json:"id"`
}

type WorkListSubscribeResult struct {
	Items []work.Work `json:"items"`
}

type WorkCommentListParams struct {
	WorkID string `json:"work_id"`
}

type WorkCommentListResult struct {
	Comments []work.Comment `json:"comments"`
}

type WorkCommentUpdateParams struct {
	ID   string `json:"id"`
	Body string `json:"body"`
}

type WorkDetailSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID     string `json:"id"`
	WorkID string `json:"work_id"`
}

type WorkDetailSubscribeResult struct {
	Work     work.Work      `json:"work"`
	Comments []work.Comment `json:"comments"`
}

// AgentRole namespace

type AgentRoleCreateParams struct {
	Name       string   `json:"name"`
	RolePrompt string   `json:"role_prompt"`
	Steps      []string `json:"steps,omitempty"`
}

type AgentRoleUpdateParams struct {
	ID         string    `json:"id"`
	Name       *string   `json:"name,omitempty"`
	RolePrompt *string   `json:"role_prompt,omitempty"`
	Steps      *[]string `json:"steps,omitempty"`
	// Changing agent_type clears model and effort, which are only valid next to
	// the agent they were chosen for — so a client switching agents sends this
	// field alone rather than three. Re-sending the agent a role already has
	// changes nothing and leaves both in place.
	AgentType *session.AgentType `json:"agent_type,omitempty"`
	Model     *string            `json:"model,omitempty"`
	Effort    *string            `json:"effort,omitempty"`
}

type AgentRoleDeleteParams struct {
	ID string `json:"id"`
}

type AgentRoleListSubscribeResult struct {
	Items []agentrole.AgentRole `json:"items"`
}
