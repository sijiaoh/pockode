// Package rpc defines JSON-RPC 2.0 wire format types for WebSocket communication.
// These types are the params and results that have a shape of their own.
//
// Where a wire type is a deliberate narrowing of a domain type rather than a
// copy of it, the narrowing lives here too (NewSessionListItem), so that what a
// client is told is decided in one place instead of at each handler.
//
// The converse is why several methods have params here and no result: a handler
// that replies with a domain value as it stands (git.show, work.create) defines
// no result type. An alias for one would not be a type — it narrows nothing and
// checks nothing — and aliasing some such methods but not others would read as
// a distinction between them that does not exist. The domain package the
// handler returns from is the definition of those results; the namespace's own
// document describes them (docs/git.md, docs/file.md, docs/projects/api.md).
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

// AuthParams carries exactly one credential: the password the user typed, or
// the session token a previous auth issued in exchange for it. Sending both is
// refused rather than resolved by precedence, so that a client cannot end up
// authenticated by a credential it did not think it was using.
type AuthParams struct {
	Password string `json:"password"`
	// Token is the pre-rename name of Password, accepted for one deprecation
	// period because a PWA cached on a phone may still be sending it.
	Token        string `json:"token"`
	SessionToken string `json:"session_token"`
	Worktree     string `json:"worktree,omitempty"` // empty = main worktree
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
	// SessionToken is what the client stores in place of the password. It is a
	// freshly issued token when the client authenticated with a password, and
	// the very same token it sent when it authenticated with one — never a
	// rotation, because two concurrent connections from one tab would then
	// invalidate each other's credential. So a client can store it
	// unconditionally without tracking how it logged in.
	SessionToken string `json:"session_token"`
}

// The reasons an auth request is refused. Clients branch on these rather than
// on the message, which is prose and free to change.
const (
	// AuthReasonInvalidPassword: the password is wrong. The user stays on the
	// password screen and is told so.
	AuthReasonInvalidPassword = "invalid_password"
	// AuthReasonSessionExpired: the stored session token is unknown or past its
	// idle window. The client drops it and asks for the password again — with
	// no error shown, because nothing the user did was wrong.
	AuthReasonSessionExpired = "session_expired"
	// AuthReasonNotAuthenticated: some other method arrived before auth.
	AuthReasonNotAuthenticated = "not_authenticated"
	// AuthReasonWorktreeNotFound: the credential was accepted but the worktree
	// the request asked to bind to is gone — a client holding a stale name, for
	// instance. The client retries against the main worktree. Stated rather than
	// left as "a refusal with no reason", so that the retry is triggered by this
	// case being present and not by the credential cases being absent.
	AuthReasonWorktreeNotFound = "worktree_not_found"
)

// AuthErrorData is the `data` member of the JSON-RPC error an auth refusal
// replies with.
type AuthErrorData struct {
	Reason string `json:"reason"`
}

// OrLegacy picks the current spelling of a renamed request field, falling back
// to the deprecated one. Three fields were renamed together — `auth`'s
// credential in both the server and the cluster, and `node.start`'s — and all
// three honour the old name for the same deprecation period, so the rule lives
// in one place rather than once per call site.
func OrLegacy(current, deprecated string) string {
	if current != "" {
		return current
	}
	return deprecated
}

type MessageParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
	// Answering are the posted questions this message answers. Absent for an
	// ordinary message.
	//
	// The whole message is refused if any entry names a question that is no
	// longer waiting for an answer (chat.ErrQuestionNotPending, reported as
	// CodeInvalidParams with every such request id named). Content is one
	// string written for all of them together, so there is no half of it to
	// deliver — see chat.Client.SendMessageAnswering.
	Answering []QuestionAnswerParams `json:"answering,omitempty"`
}

// QuestionAnswerParams is one question answered by the message carrying it.
// Either Declined, or something in Answers or Text: a question is answered, or
// deliberately not answered, and "answered with nothing" is neither.
type QuestionAnswerParams struct {
	RequestID string `json:"request_id"`
	// Answers are option labels the question offered, and only those. Each one
	// is checked against the question.
	Answers []string `json:"answers,omitempty"`
	// Text is what the user wrote themselves: the whole answer to a question
	// that offered no options, or the "Other" beside ones it did. It is
	// recorded apart from Answers so the agent can tell its own options from
	// the user's own words.
	Text string `json:"text,omitempty"`
	// Declined says the user will not answer this one. The agent is told.
	Declined bool `json:"declined,omitempty"`
	// Note is the optional line the user added beside a decline.
	Note string `json:"note,omitempty"`
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

// AttachmentGetParams reads content a chat event references by id. See
// package attachments.
type AttachmentGetParams struct {
	SessionID string `json:"session_id"`
	ID        string `json:"id"`
}

// AttachmentGetResult describes the content the same way file.get describes a
// file, so a client renders both with one code path.
type AttachmentGetResult struct {
	File *contents.FileContent `json:"file"`
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

// FileRenameParams renames the entry at Path to NewName within the directory it
// already sits in. NewName is a bare name rather than a destination path
// because renaming is not moving; see contents.Rename.
type FileRenameParams struct {
	Path    string `json:"path"`
	NewName string `json:"new_name"`
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

// Git namespace

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

// GitShowDiffParams is the params for git.show.diff request.
type GitShowDiffParams struct {
	Hash           string `json:"hash"`
	Path           string `json:"path"`
	HideWhitespace bool   `json:"hide_whitespace"`
}

// GitShowFileParams is the params for git.show.file request.
type GitShowFileParams struct {
	Hash string `json:"hash"`
	Path string `json:"path"`
}

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

// CodeGitBusy answers a git request refused because another git operation is
// already running in the same worktree (git.BusyError). It is not an internal
// error: nothing failed, the request was never started, and repeating it once
// the named operation ends will work.
//
// The value is in JSON-RPC's implementation-defined range (-32000 to -32099),
// avoiding -32000 itself because that is where libraries put their own
// unspecified "server error". A code of its own, rather than a message a client
// would have to pattern-match, is what lets the panel say which operation to
// wait for in the user's language.
const CodeGitBusy = -32001

// GitBusyData is the data member of a CodeGitBusy error.
type GitBusyData struct {
	// Operation is what holds the worktree, in git.BusyError's vocabulary:
	// "stage", "unstage", "discard", "commit", "checkout", "branch-create",
	// "fetch", "pull", "push".
	Operation string `json:"operation"`
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
// Three fields appear on both sides, and none of them can drift: Turn and
// ForkedFrom are both read straight off the stored SessionMeta, so the list and
// the detail are two narrowings of one record rather than two accounts of it,
// and WorkID is resolved on both sides from work.Work.SessionID, which is the
// relation itself.
type SessionListItem struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// WorkID names the work item this session runs, absent for a plain chat
	// session. It is the row's link to the work page, and the only thing that
	// tells a client the session belongs to work at all.
	//
	// Derived, never stored: work.Work.SessionID is the relation, and a copy of
	// it on the session would be a second one — left behind by every rollback
	// and every deletion that missed it.
	//
	// SessionDetail carries the same field, for the session a client has open,
	// which under the "hide task sessions" filter has no row here to read.
	WorkID string `json:"work_id,omitempty"`
	// UpdatedAt is the row's subtitle, and what the list is ordered by.
	UpdatedAt time.Time `json:"updated_at"`
	// Turn is what the session is doing, whole: the client derives everything a
	// row draws from it (web/src/lib/activity.ts). It replaced a process state
	// and a needs_input flag, which were two lossy views of this one value —
	// and, being volatile process state, arrived on their own schedule. This one
	// is persisted with the session, so a row is drawn the same whether or not a
	// process exists.
	Turn session.TurnState `json:"turn"`
	// UnansweredQuestions is how many questions this session is waiting on
	// answers to. It is `len(turn.unanswered)` and nothing else — derived here,
	// at the one place a row is built, so it cannot drift from the list it
	// counts.
	//
	// It is spelled out rather than left to the client because a row only ever
	// needs the number: it draws a glyph and a count beside the activity
	// indicator, and every surface that does that should be reading one field
	// rather than measuring an array it otherwise ignores. Work rows, which
	// carry no turn at all, have the same field for the same reason
	// (WorkListItem.UnansweredQuestions).
	UnansweredQuestions int                 `json:"unanswered_questions,omitempty"`
	Unread              bool                `json:"unread"`
	ForkedFrom          *session.ForkOrigin `json:"forked_from,omitempty"`
}

// NewSessionListItem builds the row for a session. Every producer of a row goes
// through here so that narrowing SessionMeta down to a row is decided in one
// place.
//
// workID is the work item the session runs, empty for a plain chat session. It
// is passed in rather than looked up here because resolving it reads the work
// layer — see watch.SessionListWatcher.
func NewSessionListItem(meta session.SessionMeta, workID string) SessionListItem {
	return SessionListItem{
		ID:                  meta.ID,
		WorkID:              workID,
		Title:               meta.Title,
		UpdatedAt:           meta.UpdatedAt,
		Turn:                meta.Turn,
		UnansweredQuestions: len(meta.Turn.Unanswered),
		Unread:              meta.Unread,
		ForkedFrom:          meta.ForkedFrom,
	}
}

// Cursor is this row's position in the list's sort order, and what a client
// hands back to ask for the rows after it. The row and the session it was built
// from produce the same cursor, because both read the same two fields.
func (i SessionListItem) Cursor() session.ListCursor {
	return session.ListCursor{UpdatedAt: i.UpdatedAt, ID: i.ID}
}

// SessionListSubscribeParams is a session list subscription, plus the narrowing
// that holds for as long as it lives: the snapshot it returns and every
// notification it is sent afterwards obey the same filter.
type SessionListSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID string `json:"id"`
	// ExcludeWorkSessions drops every session that belongs to a work item.
	//
	// The filter is the server's because a client cannot do it: deciding it
	// client-side means holding the whole work list, which makes the session
	// list wrong for as long as that list is incomplete — and a paged work list
	// is never complete.
	//
	// Absent means "send everything", which is what this list always was.
	ExcludeWorkSessions bool `json:"exclude_work_sessions,omitempty"`
}

// SessionListSubscribeResult is the first page of the list, plus the two facts
// a page cannot be asked for: where it ends, and whether anything outside it is
// unread.
type SessionListSubscribeResult struct {
	Sessions []SessionListItem `json:"sessions"`
	// NextCursor is the position to ask for the next page from, and is empty
	// when there is no next page. Opaque: hand it back unread
	// (session.ListCursor).
	NextCursor string `json:"next_cursor,omitempty"`
	HasMore    bool   `json:"has_more,omitempty"`
	// HasUnread is over the whole list, narrowed by the same filter, and never
	// over the page. The sidebar's tab badge is an "is there any", so deriving
	// it from a page is not a smaller answer but a wrong one — a list that has
	// simply not been read that far telling the user there is nothing waiting
	// (docs/list-paging-ui.md §2.1).
	HasUnread bool `json:"has_unread"`
}

// SessionListPageParams asks for the rows after the one the client can see at
// the bottom of what it has.
//
// It names a subscription rather than repeating its narrowing: a page fetched
// under a different filter from the snapshot is a page of a different list, and
// the filter is already held for the life of the subscription
// (SessionListSubscribeParams.ExcludeWorkSessions).
type SessionListPageParams struct {
	// ID is the subscription to page, as returned to the client by its own
	// subscribe call.
	ID string `json:"id"`
	// Cursor is what the previous page reported as NextCursor. Empty asks for
	// the first page again.
	Cursor string `json:"cursor,omitempty"`
	// Limit is the page size; zero takes the server's default and anything
	// above its cap is clamped (session.ClampListLimit).
	Limit int `json:"limit,omitempty"`
}

type SessionListPageResult struct {
	Sessions   []SessionListItem `json:"sessions"`
	NextCursor string            `json:"next_cursor,omitempty"`
	HasMore    bool              `json:"has_more,omitempty"`
}

// Session detail watch (subscription for a single session's metadata)

type SessionDetailSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID        string `json:"id"`
	SessionID string `json:"session_id"`
}

// SessionDetail is the whole of one session's stored metadata plus the one
// thing that is not stored on it: the work item it runs.
//
// Embedded rather than copied field by field, so that a field added to
// SessionMeta reaches the client without being listed again here — the detail
// is deliberately everything the list narrows away, and a narrowing here would
// leave a session's own settings with no subscription that carries them.
type SessionDetail struct {
	session.SessionMeta
	// WorkID names the work item this session runs, absent for a plain chat
	// session. Same field, same source and same rule as SessionListItem.WorkID:
	// derived from work.Work.SessionID, never stored on the session.
	//
	// It is on both because the list and the detail answer for different
	// sessions: the sidebar's filter hides exactly the work sessions, so the one
	// session whose work id a client most needs — the open one — is the one with
	// no row to read it off.
	WorkID string `json:"work_id,omitempty"`
}

func NewSessionDetail(meta session.SessionMeta, workID string) SessionDetail {
	return SessionDetail{SessionMeta: meta, WorkID: workID}
}

type SessionDetailSubscribeResult struct {
	Session SessionDetail `json:"session"`
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
	// Turn is what the session is doing at the moment of subscribing. The
	// transcript's own subscription reports it because the transcript is what it
	// governs: a turn that is not running is what tells the client that every
	// message still streaming has stopped, which is the only thing that closes
	// out a transcript whose server died mid-stream (docs/lifecycle-ui.md §2.4).
	Turn session.TurnState `json:"turn"`
	// ToolActivity is what each tool call still in flight last reported doing,
	// by tool_use_id. It is here rather than in History because a tool_activity
	// event is the latest value of something still changing and is never
	// recorded (see agent.EventType.Persisted) — so a client that subscribes
	// mid-run would otherwise have missed every one of them, which on a phone is
	// the normal case. Absent when nothing is in flight.
	ToolActivity map[string]string `json:"tool_activity,omitempty"`
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

// WorkListItem is one row of the work list: what drawing a row needs, and
// nothing more.
//
// The rest of a work item — Body above all, but also CurrentStep and CreatedAt —
// is reported by work.detail.subscribe, for the one item a client has open. Every
// subscriber holds the whole project's list, and a change to any one work item
// pushes that item's row to all of them, so a field here is paid for by clients
// that are not looking at that work item at all. Body is the one that makes this
// expensive rather than merely untidy:
// it is unbounded user-authored prose, it is the field most often edited, and no
// row renders it.
//
// Several fields that stayed are not drawn on the row they arrive on. ParentID
// and Status build the story/task tree and answer whether a work's worktree is
// still free to change, which is what decides if its badge may be shown at all.
// That rule needs the *whole* list to resolve one item, so it can only be
// answered here (web/src/lib/workStore.ts, docs/projects/api.md#work-list-rows-vs-work-detail).
// SessionID is the row's Chat shortcut and nothing else now: the session list
// carries its own work id (SessionListItem.WorkID), so it no longer reads this
// list to find out which of its sessions belong to work.
type WorkListItem struct {
	ID          string          `json:"id"`
	Type        work.WorkType   `json:"type"`
	ParentID    string          `json:"parent_id,omitempty"`
	AgentRoleID string          `json:"agent_role_id,omitempty"`
	Title       string          `json:"title"`
	Status      work.WorkStatus `json:"status"`
	// Activity is what the work is doing, derived on the server from this item
	// and the turn of the session it runs in. It is the one thing a row draws
	// that the row cannot compute: a work list spans worktrees while a session
	// list is scoped to one, so a client does not hold the turn state of a
	// session in a worktree it has not opened (docs/lifecycle-ui.md §1.3).
	Activity work.Activity `json:"activity"`
	// UnansweredQuestions is how many questions this work's session is waiting
	// on answers to — the second dimension of "needs you", beside Activity.
	// Zero is absent.
	//
	// A count, not the questions: see work.RowState. The list itself is on
	// work.detail.
	UnansweredQuestions int `json:"unanswered_questions,omitempty"`
	// Wait is what an active work is waiting for; the reason the agent gave for
	// it belongs to the detail, where there is room to show it.
	Wait      work.WorkWait `json:"wait,omitempty"`
	SessionID string        `json:"session_id,omitempty"`
	Worktree  string        `json:"worktree,omitempty"`
	// UpdatedAt is what every list of work is ordered by, newest first — both
	// segments and every group of `Current` — and what each row prints so that
	// the order can be read off the screen (docs/project-ui.md §2.3, §3).
	UpdatedAt time.Time `json:"updated_at"`
}

// NewWorkListItem builds the row for a work item. Every producer of a row goes
// through here so that narrowing work.Work down to a row is decided in one
// place. The activity is passed in rather than derived here, because deriving
// it reads the session layer — see watch.WorkListWatcher.
func NewWorkListItem(w work.Work, state work.RowState) WorkListItem {
	return WorkListItem{
		ID:                  w.ID,
		Type:                w.Type,
		ParentID:            w.ParentID,
		AgentRoleID:         w.AgentRoleID,
		Title:               w.Title,
		Status:              w.Status,
		Activity:            state.Activity,
		UnansweredQuestions: state.UnansweredQuestions,
		Wait:                w.Wait,
		SessionID:           w.SessionID,
		Worktree:            w.Worktree,
		UpdatedAt:           w.UpdatedAt,
	}
}

// Cursor is this row's position in the list's sort order, and what a client
// hands back to ask for the page after it.
//
// Only the archive *pages*, so only the archive hands one back. The order it
// names is every list's, though: `Current` is drawn in it too, and its cap is
// cut along it (currentSegment), which is why both sides of that cut agree on
// a tie.
func (i WorkListItem) Cursor() session.ListCursor {
	return session.ListCursor{UpdatedAt: i.UpdatedAt, ID: i.ID}
}

// WorkListSubscribeResult is the `Current` segment of the project list: every
// row it draws plus everything those rows make claims about, and nothing
// closed. The archive is fetched a page at a time (WorkListArchiveParams).
//
// `Current` itself is not paged, and must not be: its group counts and the
// Project tab's attention dot are read off it, and an "is there any" asked of a
// page answers no for a list nobody has read that far
// (docs/list-paging-ui.md §2.1, §4.1).
type WorkListSubscribeResult struct {
	Items []WorkListItem `json:"items"`
	// StoppedHidden and OpenHidden are how many rows of the *Stopped* and *Not
	// running* groups were held back by their caps. Each group's heading adds
	// its own to the rows it received, so the count it shows is the whole
	// group's; zero means that group arrived whole. One number per group
	// because one number spanning two headings would make at least one of them
	// wrong. Fetch the rest — of both groups at once — with work.list.earlier.
	StoppedHidden int `json:"stopped_hidden,omitempty"`
	OpenHidden    int `json:"open_hidden,omitempty"`
}

// WorkListArchiveParams asks for one page of closed work.
//
// It names a subscription for the same reason SessionListPageParams does: a
// page is served against the list the subscription is following, and an id the
// server no longer holds is the client's signal to subscribe afresh rather than
// to retry.
type WorkListArchiveParams struct {
	// ID is the work list subscription, as returned to the client by its own
	// subscribe call.
	ID string `json:"id"`
	// Cursor is what a previous page reported as NextCursor. Empty asks for the
	// first page. Opaque: hand it back unread (session.ListCursor).
	//
	// There is no cursor for the page *before* this one, and none is needed:
	// walking back is the client handing back a cursor it already used. That is
	// also why the pager can say `Page 2` and never `Page 2 of 7`.
	Cursor string `json:"cursor,omitempty"`
	// Limit is the page size; zero takes the server's default (20) and anything
	// above its cap is clamped.
	Limit int `json:"limit,omitempty"`
}

// WorkListArchiveResult is one page of the archive: the closed stories on it,
// followed by the tasks those rows speak for, which get no rows of their own.
type WorkListArchiveResult struct {
	Items      []WorkListItem `json:"items"`
	NextCursor string         `json:"next_cursor,omitempty"`
	HasMore    bool           `json:"has_more,omitempty"`
}

// WorkListEarlierParams asks for the `Current` segment with nothing held back,
// which is what "Show earlier work" presses. A cap is not a page: there is no
// cursor and no second request.
type WorkListEarlierParams struct {
	ID string `json:"id"`
}

// WorkListEarlierResult is the whole `Current` segment, replacing what the
// subscription's snapshot sent rather than extending it.
type WorkListEarlierResult struct {
	Items []WorkListItem `json:"items"`
}

type WorkCommentListParams struct {
	WorkID string `json:"work_id"`
}

type WorkCommentListResult struct {
	Comments []work.Comment `json:"comments"`
}

type WorkDetailSubscribeParams struct {
	// ID is the subscription id; see SubscribeParams.
	ID     string `json:"id"`
	WorkID string `json:"work_id"`
}

type WorkDetailSubscribeResult struct {
	Work     work.Work      `json:"work"`
	Comments []work.Comment `json:"comments"`
	// Usage is the detail's alone, never Work's — see work.Usage.
	Usage work.Usage `json:"usage"`
	// Activity rides here for the same reason Usage does: it is derived from
	// something the work record knows nothing about — the turn of its session.
	Activity work.Activity `json:"activity"`
	// PendingQuestions are the questions this work's session has asked and
	// nobody has answered, oldest first. The list itself and not a count,
	// because the detail is the one surface with room to show what is being
	// asked — a row gets WorkListItem.UnansweredQuestions instead.
	PendingQuestions []session.PendingQuestion `json:"pending_questions,omitempty"`
	// Children is every task under this item, and Parent the story above it.
	//
	// They are here rather than read out of the work list because that list is
	// the `Current` segment and holds no closed work: a closed story opened from
	// the archive, or reloaded on, would otherwise look childless — while its
	// own row states `{closed}/{total} tasks` over exactly these
	// (docs/list-paging-ui.md §2.2). The detail is the one place a story's tasks
	// are listed, so it answers for them itself.
	Children []WorkListItem `json:"children"`
	Parent   *WorkListItem  `json:"parent,omitempty"`
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

// SessionView namespace
//
// A worktree's sessions outlive the worktree: deleting one leaves its
// conversations, attachments and all, exactly where they were. This namespace
// is how they are read afterwards — and, more generally, how a client sitting
// in one worktree reads the sessions stored under another.
//
// Every method here names the worktree it reads from, and all but one of them
// only read. Nothing here changes a conversation, and that is the whole of how
// "these sessions are read-only" is enforced: writing goes through the
// worktree-scoped namespaces, which act on the worktree the connection is bound
// to and refuse a session id they do not own. Continuing a conversation in a
// worktree that no longer exists is not a thing the wire can express.
//
// The exception is session_view.delete, and it is not a hole in that rule.
// Read-only describes what can be said to a session, not whether the record has
// to be kept: a deleted worktree's sessions are kept on purpose, so there has to
// be a way to throw them away, and the delete every other session reaches
// through (session.delete) acts only on the bound worktree.
//
// App scope: the methods are about a worktree the connection is not in, so
// binding one says nothing about which of them may be called.

// SessionViewWorktreesResult lists every worktree that still has session data.
type SessionViewWorktreesResult struct {
	Worktrees []SessionViewWorktree `json:"worktrees"`
}

// SessionViewWorktree is one worktree a client may read sessions from.
type SessionViewWorktree struct {
	// Worktree is the name; "" is the main worktree. It is what every other
	// session_view method's Worktree field takes.
	Worktree string `json:"worktree"`
	// Exists reports whether the worktree itself is still there. It is what
	// tells a client which of the two things to do with a row: a worktree that
	// exists is switched to and used normally, one that does not can only be
	// read. A worktree recreated under a deleted one's name exists again and
	// carries the old sessions with it — the data is keyed by name.
	Exists bool `json:"exists"`
	// SessionCount is how many sessions are stored. A worktree with none is not
	// listed at all, so deleting the last session of a deleted worktree takes it
	// out of the list.
	SessionCount int `json:"session_count"`
}

// SessionViewListParams asks for a page of one worktree's session list.
//
// Unlike session.list.subscribe there is no subscription behind it: what is
// read here belongs to another worktree, and a client watching it from outside
// would be watching a conversation it cannot take part in. So the narrowing
// travels with each request rather than being held for a subscription's life.
type SessionViewListParams struct {
	// Worktree names the worktree to read from; "" is the main worktree.
	Worktree string `json:"worktree"`
	// ExcludeWorkSessions drops every session that belongs to a work item, the
	// same narrowing SessionListSubscribeParams carries and for the same reason.
	ExcludeWorkSessions bool `json:"exclude_work_sessions,omitempty"`
	// Cursor is what the previous page reported as NextCursor; empty asks for
	// the first page. Opaque (session.ListCursor).
	Cursor string `json:"cursor,omitempty"`
	// Limit is the page size; zero takes the server's default and anything above
	// its cap is clamped (session.ClampListLimit).
	Limit int `json:"limit,omitempty"`
}

type SessionViewListResult struct {
	Sessions   []SessionListItem `json:"sessions"`
	NextCursor string            `json:"next_cursor,omitempty"`
	HasMore    bool              `json:"has_more,omitempty"`
}

// SessionViewGetParams reads one session's metadata out of another worktree.
type SessionViewGetParams struct {
	Worktree  string `json:"worktree"`
	SessionID string `json:"session_id"`
}

type SessionViewGetResult struct {
	Session SessionDetail `json:"session"`
}

// SessionViewHistoryParams asks for a page of one session's transcript out of
// another worktree. It pages exactly as ChatMessagesHistoryParams does, so a
// client scrolls a read-only transcript with the code it already has.
type SessionViewHistoryParams struct {
	Worktree  string `json:"worktree"`
	SessionID string `json:"session_id"`
	// BeforeSeq is exclusive; zero asks for the newest page. See
	// ChatMessagesHistoryParams.BeforeSeq.
	BeforeSeq session.HistorySeq `json:"before_seq,omitempty"`
	// Limit follows ChatMessagesSubscribeParams.Limit.
	Limit int `json:"limit,omitempty"`
}

type SessionViewHistoryResult struct {
	History       []json.RawMessage  `json:"history"`
	HasMore       bool               `json:"has_more"`
	NextBeforeSeq session.HistorySeq `json:"next_before_seq,omitempty"`
}

// SessionViewAttachmentParams reads content a chat event references by id, out
// of another worktree's session. Same content, same result shape and the same
// confinement as AttachmentGetParams — only the directory it resolves in is
// named by the request rather than by the bound worktree.
type SessionViewAttachmentParams struct {
	Worktree  string `json:"worktree"`
	SessionID string `json:"session_id"`
	ID        string `json:"id"`
}

type SessionViewAttachmentResult struct {
	File *contents.FileContent `json:"file"`
}

// SessionViewDeleteParams discards one session stored under another worktree,
// including one whose worktree no longer exists.
//
// It removes what session.delete removes — the record, its transcript and its
// attachments — and differs only in that the worktree travels with the request,
// because the connection cannot be bound to one that is gone.
//
// There is no notification: what is read through this namespace is read without
// a subscription, so a client that deletes a session asks again for what it is
// showing.
type SessionViewDeleteParams struct {
	Worktree  string `json:"worktree"`
	SessionID string `json:"session_id"`
}
