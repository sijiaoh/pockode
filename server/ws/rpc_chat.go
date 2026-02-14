package ws

import (
	"context"
	"errors"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleChatMessagesSubscribe(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.ChatMessagesSubscribeParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	// Verify session exists and get mode
	meta, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get session")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	id, history, err := wt.ChatMessagesWatcher.Subscribe(conn, h.state.connID, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	result := rpc.ChatMessagesSubscribeResult{
		ID:      id,
		History: history,
		State:   wt.ProcessManager.GetProcessState(params.SessionID),
		Mode:    meta.Mode,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send subscribe response", "error", err)
		return
	}

	log.Info("subscribed to chat messages", "subscriptionId", id, "state", result.State, "mode", meta.Mode)
}

func (h *rpcMethodHandler) handleMessage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.MessageParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	h.recordCommandIfSlash(params.Content)

	log.Info("received prompt", "length", len(params.Content))

	if err := wt.ChatClient.SendMessage(ctx, params.SessionID, params.Content); err != nil {
		h.replyErrorForChat(ctx, conn, req.ID, err)
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

func (h *rpcMethodHandler) handleInterrupt(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.InterruptParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	if err := wt.ChatClient.Interrupt(ctx, params.SessionID); err != nil {
		h.replyErrorForChat(ctx, conn, req.ID, err)
		return
	}

	log.Info("sent interrupt")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

func (h *rpcMethodHandler) handlePermissionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.PermissionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	data := agent.PermissionRequestData{
		RequestID:             params.RequestID,
		ToolInput:             params.ToolInput,
		ToolUseID:             params.ToolUseID,
		PermissionSuggestions: params.PermissionSuggestions,
	}
	choice := parsePermissionChoice(params.Choice)

	if err := wt.ChatClient.SendPermissionResponse(ctx, params.SessionID, data, choice); err != nil {
		h.replyErrorForChat(ctx, conn, req.ID, err)
		return
	}

	log.Info("sent permission response", "choice", params.Choice)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

func (h *rpcMethodHandler) handleQuestionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.QuestionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	data := agent.QuestionRequestData{
		RequestID: params.RequestID,
		ToolUseID: params.ToolUseID,
	}

	if err := wt.ChatClient.SendQuestionResponse(ctx, params.SessionID, data, params.Answers); err != nil {
		h.replyErrorForChat(ctx, conn, req.ID, err)
		return
	}

	log.Info("sent question response", "cancelled", params.Answers == nil)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

// replyErrorForChat handles chat-specific errors with appropriate RPC codes.
func (h *rpcMethodHandler) replyErrorForChat(ctx context.Context, conn *jsonrpc2.Conn, id jsonrpc2.ID, err error) {
	if errors.Is(err, chat.ErrSessionNotFound) {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInvalidParams, "session not found")
	} else {
		h.replyError(ctx, conn, id, jsonrpc2.CodeInternalError, err.Error())
	}
}

func parsePermissionChoice(choice string) agent.PermissionChoice {
	switch choice {
	case "allow":
		return agent.PermissionAllow
	case "always_allow":
		return agent.PermissionAlwaysAllow
	default:
		return agent.PermissionDeny
	}
}

func (h *rpcMethodHandler) recordCommandIfSlash(content string) {
	if len(content) == 0 || content[0] != '/' {
		return
	}

	// Extract command name: "/help arg1 arg2" -> "help"
	name := content[1:]
	for i, r := range name {
		if isWhitespace(r) {
			name = name[:i]
			break
		}
	}

	if _, err := h.commandStore.Use(name); err != nil {
		h.log.Error("failed to record command usage", "command", name, "error", err)
	}
}

func isWhitespace(r rune) bool {
	return unicode.IsSpace(r)
}
