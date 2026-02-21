// Package rpc defines JSON-RPC 2.0 wire format types for WebSocket communication.
// These types represent the params and result structures for all RPC methods.
package rpc

import (
	"encoding/json"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/command"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
	"github.com/pockode/server/session"
	"github.com/pockode/server/settings"
	"github.com/pockode/server/work"
)

// Client → Server

type AuthParams struct {
	Token    string `json:"token"`
	Worktree string `json:"worktree,omitempty"` // empty = main worktree
}

type AuthResult struct {
	Version      string `json:"version"`
	Title        string `json:"title"`
	WorkDir      string `json:"work_dir"`
	WorktreeName string `json:"worktree_name"`
}

type MessageParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
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

type SessionSetModeParams struct {
	SessionID string       `json:"session_id"`
	Mode      session.Mode `json:"mode"`
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

// Git namespace

type GitStatusResult = git.GitStatus

// Git diff watch (subscription for file-specific diff changes)

type GitDiffSubscribeParams struct {
	Path   string `json:"path"`
	Staged bool   `json:"staged"`
}

type GitDiffSubscribeResult struct {
	ID         string `json:"id"`
	Diff       string `json:"diff"`
	OldContent string `json:"old_content"`
	NewContent string `json:"new_content"`
}

type GitDiffUnsubscribeParams struct {
	ID string `json:"id"`
}

// GitPathsParams is used for git.add and git.reset operations.
type GitPathsParams struct {
	Paths []string `json:"paths"`
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
	Hash string `json:"hash"`
	Path string `json:"path"`
}

// GitShowDiffResult is the result of git.show.diff request.
type GitShowDiffResult = git.DiffResult

// Command namespace

type CommandListResult struct {
	Commands []command.Command `json:"commands"`
}

// FS namespace

type FSSubscribeParams struct {
	Path string `json:"path"`
}

type FSSubscribeResult struct {
	ID string `json:"id"`
}

type FSUnsubscribeParams struct {
	ID string `json:"id"`
}

// Git namespace

type GitSubscribeResult struct {
	ID string `json:"id"`
}

type GitUnsubscribeParams struct {
	ID string `json:"id"`
}

// Worktree watch (subscription for worktree list changes)

type WorktreeSubscribeResult struct {
	ID string `json:"id"`
}

type WorktreeUnsubscribeParams struct {
	ID string `json:"id"`
}

// Session list watch (subscription for session list changes)

type SessionListItem struct {
	session.SessionMeta
	State string `json:"state"` // "idle" | "running" | "ended"
}

type SessionListSubscribeResult struct {
	ID       string            `json:"id"`
	Sessions []SessionListItem `json:"sessions"`
}

type SessionListUnsubscribeParams struct {
	ID string `json:"id"`
}

// Chat messages watch (subscription for chat messages)

type ChatMessagesSubscribeParams struct {
	SessionID string `json:"session_id"`
}

type ChatMessagesSubscribeResult struct {
	ID      string            `json:"id"`
	History []json.RawMessage `json:"history"`
	State   string            `json:"state"` // "idle" | "running" | "ended"
	Mode    session.Mode      `json:"mode"`
}

type ChatMessagesUnsubscribeParams struct {
	ID string `json:"id"`
}

// Worktree namespace

type WorktreeInfo struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Branch string `json:"branch"`
	IsMain bool   `json:"is_main"`
}

type WorktreeListResult struct {
	Worktrees []WorktreeInfo `json:"worktrees"`
}

type WorktreeCreateParams struct {
	Name       string `json:"name"`
	Branch     string `json:"branch"`
	BaseBranch string `json:"base_branch,omitempty"`
}

type WorktreeCreateResult struct {
	Worktree WorktreeInfo `json:"worktree"`
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

// Settings namespace

type SettingsSubscribeResult struct {
	ID       string            `json:"id"`
	Settings settings.Settings `json:"settings"`
}

type SettingsUpdateParams struct {
	Settings settings.Settings `json:"settings"`
}

// Work namespace

type WorkCreateParams struct {
	Type     work.WorkType `json:"type"`
	ParentID string        `json:"parent_id,omitempty"`
	Title    string        `json:"title"`
	Body     string        `json:"body,omitempty"`
}

type WorkUpdateParams struct {
	ID     string           `json:"id"`
	Title  *string          `json:"title,omitempty"`
	Body   *string          `json:"body,omitempty"`
	Status *work.WorkStatus `json:"status,omitempty"`
}

type WorkDeleteParams struct {
	ID string `json:"id"`
}

type WorkStartParams struct {
	ID string `json:"id"`
}

type WorkListSubscribeResult struct {
	ID    string      `json:"id"`
	Items []work.Work `json:"items"`
}
