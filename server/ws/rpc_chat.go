package ws

import (
	"context"
	"errors"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/session"
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

	// Verify the session exists. Its settings are not read here: they belong to
	// session.detail.subscribe, which the client runs alongside this one.
	_, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	notifier := h.state.getNotifier()
	id, page, err := wt.ChatMessagesWatcher.Subscribe(notifier, params.SessionID, params.Limit)
	if err != nil {
		// A limit the client cannot ask for is its mistake; anything else Subscribe
		// fails on is a history the server could not read.
		if errors.Is(err, session.ErrInvalidHistoryLimit) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyInternalError(ctx, conn, req.ID, "failed to read session history", err, "sessionId", params.SessionID)
		return
	}
	h.state.trackSubscription(id, wt.ChatMessagesWatcher)

	wt.SessionListWatcher.MarkRead(params.SessionID)

	result := rpc.ChatMessagesSubscribeResult{
		ID:            id,
		History:       page.Records,
		HasMore:       page.HasMore,
		NextBeforeSeq: page.NextBeforeSeq,
		State:         wt.ProcessManager.GetProcessState(params.SessionID),
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send subscribe response", "error", err)
		return
	}

	log.Info("subscribed to chat messages",
		"subscriptionId", id, "state", result.State,
		"records", len(page.Records), "hasMore", page.HasMore)
}

// handleChatMessagesHistory serves the page of history older than a cursor the
// client already holds — how a chat scrolled back past the page it subscribed
// with reaches the rest of the conversation.
func (h *rpcMethodHandler) handleChatMessagesHistory(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.ChatMessagesHistoryParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	_, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	records, err := wt.SessionStore.GetHistory(ctx, params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read session history", err, "sessionId", params.SessionID)
		return
	}

	page, err := session.PageHistory(records, params.BeforeSeq, params.Limit)
	if err != nil {
		// Both failures name what the client asked for and what the history can
		// answer, so the cause is the reply.
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}

	result := rpc.ChatMessagesHistoryResult{
		History:       page.Records,
		HasMore:       page.HasMore,
		NextBeforeSeq: page.NextBeforeSeq,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send history response", "error", err)
		return
	}

	log.Debug("served chat history page",
		"beforeSeq", params.BeforeSeq, "records", len(page.Records), "hasMore", page.HasMore)
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

	wt.SessionListWatcher.ClearNeedsInput(params.SessionID)

	seq, err := wt.ChatClient.SendMessageExcluding(ctx, params.SessionID, params.Content, h.state.getNotifier())
	if err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	// This connection is the one excluded from the broadcast, so the reply is
	// where it learns its own message's seq (see rpc.MessageResult).
	if err := conn.Reply(ctx, req.ID, rpc.MessageResult{Seq: seq}); err != nil {
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
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
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

	wt.SessionListWatcher.ClearNeedsInput(params.SessionID)

	if err := wt.ChatClient.SendPermissionResponse(ctx, params.SessionID, data, choice); err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
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

	wt.SessionListWatcher.ClearNeedsInput(params.SessionID)

	if err := wt.ChatClient.SendQuestionResponse(ctx, params.SessionID, data, params.Answers); err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	log.Info("sent question response", "cancelled", params.Answers == nil)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

// replyErrorForChat maps the errors chat.Client returns to RPC codes. Used by the
// chat methods and by session.fork, which goes through the same client.
func (h *rpcMethodHandler) replyErrorForChat(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, sessionID string, err error) {
	if errors.Is(err, chat.ErrSessionNotFound) {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
	} else if errors.Is(err, chat.ErrSessionNotRunning) ||
		errors.Is(err, chat.ErrForkAnchorOutOfRange) ||
		errors.Is(err, chat.ErrForkAnchorNoHistory) ||
		errors.Is(err, chat.ErrForkUnsupported) {
		// The request does not fit the session's history, state or agent — a prompt
		// whose process is gone, a fork anchored past the end of the history or at
		// the very first message, a fork of a session whose agent cannot be forked.
		// The message names what was wrong, and none of them is a server fault.
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
	} else {
		// The reply carries the cause, but this is the branch a failing agent
		// startup takes and the client may give up on its own clock first. The
		// log is the trace that does not depend on that; it names the method
		// because the dispatcher only logs that at Debug.
		h.log.With("sessionId", sessionID).Error("chat request failed", "method", req.Method, "error", err)
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
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
