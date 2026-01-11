// Package rpc defines JSON-RPC 2.0 wire format types for WebSocket communication.
// These types represent the params and result structures for all RPC methods.
package rpc

import (
	"encoding/json"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/command"
	"github.com/pockode/server/contents"
	"github.com/pockode/server/git"
)

// Client → Server

type AuthParams struct {
	Token string `json:"token"`
}

type AuthResult struct {
	Version string `json:"version"`
	Title   string `json:"title"`
}

type AttachParams struct {
	SessionID string `json:"session_id"`
}

type AttachResult struct {
	ProcessRunning bool `json:"process_running"`
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

type SessionGetHistoryParams struct {
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

// Git namespace

type GitStatusResult = git.GitStatus

type GitDiffParams struct {
	Path   string `json:"path"`
	Staged bool   `json:"staged"`
}

type GitDiffResult struct {
	Diff       string `json:"diff"`
	OldContent string `json:"old_content"`
	NewContent string `json:"new_content"`
}

// Command namespace

type CommandListResult struct {
	Commands []command.Command `json:"commands"`
}

// Watch namespace

type WatchSubscribeParams struct {
	Path string `json:"path"`
}

type WatchSubscribeResult struct {
	ID string `json:"id"`
}

type WatchUnsubscribeParams struct {
	ID string `json:"id"`
}

// Git watch (subscription for git status changes)

type GitSubscribeResult struct {
	ID string `json:"id"`
}

type GitUnsubscribeParams struct {
	ID string `json:"id"`
}

// Server → Client

// SessionParams is the params for done, interrupted, and process_ended notifications.
type SessionParams struct {
	SessionID string `json:"session_id"`
}

type TextParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

type ToolCallParams struct {
	SessionID string          `json:"session_id"`
	ToolName  string          `json:"tool_name"`
	ToolInput json.RawMessage `json:"tool_input"`
	ToolUseID string          `json:"tool_use_id"`
}

type ToolResultParams struct {
	SessionID  string `json:"session_id"`
	ToolUseID  string `json:"tool_use_id"`
	ToolResult string `json:"tool_result"`
}

type WarningParams struct {
	SessionID string `json:"session_id"`
	Message   string `json:"message"`
	Code      string `json:"code"`
}

type ErrorParams struct {
	SessionID string `json:"session_id"`
	Error     string `json:"error"`
}

type PermissionRequestParams struct {
	SessionID             string                   `json:"session_id"`
	RequestID             string                   `json:"request_id"`
	ToolName              string                   `json:"tool_name"`
	ToolInput             json.RawMessage          `json:"tool_input"`
	ToolUseID             string                   `json:"tool_use_id"`
	PermissionSuggestions []agent.PermissionUpdate `json:"permission_suggestions,omitempty"`
}

type RequestCancelledParams struct {
	SessionID string `json:"session_id"`
	RequestID string `json:"request_id"`
}

type AskUserQuestionParams struct {
	SessionID string                  `json:"session_id"`
	RequestID string                  `json:"request_id"`
	ToolUseID string                  `json:"tool_use_id"`
	Questions []agent.AskUserQuestion `json:"questions"`
}

type SystemParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

type RawParams struct {
	SessionID string `json:"session_id"`
	Content   string `json:"content"`
}

// NewNotifyParams creates method-specific notification params from an AgentEvent.
func NewNotifyParams(sessionID string, event agent.AgentEvent) interface{} {
	switch e := event.(type) {
	case agent.TextEvent:
		return TextParams{SessionID: sessionID, Content: e.Content}
	case agent.ToolCallEvent:
		return ToolCallParams{SessionID: sessionID, ToolName: e.ToolName, ToolInput: e.ToolInput, ToolUseID: e.ToolUseID}
	case agent.ToolResultEvent:
		return ToolResultParams{SessionID: sessionID, ToolUseID: e.ToolUseID, ToolResult: e.ToolResult}
	case agent.WarningEvent:
		return WarningParams{SessionID: sessionID, Message: e.Message, Code: e.Code}
	case agent.ErrorEvent:
		return ErrorParams{SessionID: sessionID, Error: e.Error}
	case agent.DoneEvent:
		return SessionParams{SessionID: sessionID}
	case agent.InterruptedEvent:
		return SessionParams{SessionID: sessionID}
	case agent.PermissionRequestEvent:
		return PermissionRequestParams{
			SessionID:             sessionID,
			RequestID:             e.RequestID,
			ToolName:              e.ToolName,
			ToolInput:             e.ToolInput,
			ToolUseID:             e.ToolUseID,
			PermissionSuggestions: e.PermissionSuggestions,
		}
	case agent.RequestCancelledEvent:
		return RequestCancelledParams{SessionID: sessionID, RequestID: e.RequestID}
	case agent.AskUserQuestionEvent:
		return AskUserQuestionParams{SessionID: sessionID, RequestID: e.RequestID, ToolUseID: e.ToolUseID, Questions: e.Questions}
	case agent.SystemEvent:
		return SystemParams{SessionID: sessionID, Content: e.Content}
	case agent.ProcessEndedEvent:
		return SessionParams{SessionID: sessionID}
	case agent.RawEvent:
		return RawParams{SessionID: sessionID, Content: e.Content}
	default:
		return SessionParams{SessionID: sessionID}
	}
}
