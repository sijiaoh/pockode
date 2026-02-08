package ws

import (
	"context"
	"fmt"
	"log/slog"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/process"
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

	proc := wt.ProcessManager.GetProcess(params.SessionID)
	var state process.ProcessState
	if proc == nil {
		state = process.ProcessStateEnded
	} else {
		state = proc.State()
	}

	result := rpc.ChatMessagesSubscribeResult{
		ID:      id,
		History: history,
		State:   string(state),
		Mode:    meta.Mode,
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send subscribe response", "error", err)
		return
	}

	log.Info("subscribed to chat messages", "subscriptionId", id, "state", state, "mode", meta.Mode)
}

func (h *rpcMethodHandler) handleMessage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.MessageParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	proc, err := h.getOrCreateProcess(ctx, log, wt, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.recordCommandIfSlash(params.Content)

	log.Info("received prompt", "length", len(params.Content))

	// Persist user message to history
	event := agent.MessageEvent{Content: params.Content}
	if err := wt.SessionStore.AppendToHistory(ctx, params.SessionID, agent.NewEventRecord(event)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	proc.SetRunning()
	if err := proc.AgentSession().SendMessage(params.Content); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send message response", "error", err)
	}
}

func (h *rpcMethodHandler) handleInterrupt(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.InterruptParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	proc, err := h.getOrCreateProcess(ctx, log, wt, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := proc.AgentSession().SendInterrupt(); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	log.Info("sent interrupt")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send interrupt response", "error", err)
	}
}

func (h *rpcMethodHandler) handlePermissionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.PermissionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	proc, err := h.getOrCreateProcess(ctx, log, wt, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	data := agent.PermissionRequestData{
		RequestID:             params.RequestID,
		ToolInput:             params.ToolInput,
		ToolUseID:             params.ToolUseID,
		PermissionSuggestions: params.PermissionSuggestions,
	}
	choice := parsePermissionChoice(params.Choice)
	proc.SetRunning()

	if err := proc.AgentSession().SendPermissionResponse(data, choice); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist permission response to history
	permEvent := agent.PermissionResponseEvent{RequestID: params.RequestID, Choice: params.Choice}
	if err := wt.SessionStore.AppendToHistory(ctx, params.SessionID, agent.NewEventRecord(permEvent)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	log.Info("sent permission response", "choice", params.Choice)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send permission response", "error", err)
	}
}

func (h *rpcMethodHandler) handleQuestionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.QuestionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	proc, err := h.getOrCreateProcess(ctx, log, wt, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	data := agent.QuestionRequestData{
		RequestID: params.RequestID,
		ToolUseID: params.ToolUseID,
	}
	proc.SetRunning()

	if err := proc.AgentSession().SendQuestionResponse(data, params.Answers); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist question response to history
	qEvent := agent.QuestionResponseEvent{RequestID: params.RequestID, Answers: params.Answers}
	if err := wt.SessionStore.AppendToHistory(ctx, params.SessionID, agent.NewEventRecord(qEvent)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	log.Info("sent question response", "cancelled", params.Answers == nil)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send question response", "error", err)
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

func (h *rpcMethodHandler) getOrCreateProcess(ctx context.Context, log *slog.Logger, wt *worktree.Worktree, sessionID string) (*process.Process, error) {
	meta, found, err := wt.SessionStore.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}

	resume := meta.Activated
	proc, created, err := wt.ProcessManager.GetOrCreateProcess(ctx, sessionID, resume, meta.Mode)
	if err != nil {
		return nil, err
	}

	// Mark as activated on first process creation
	if created && !resume {
		if err := wt.SessionStore.Activate(ctx, sessionID); err != nil {
			log.Error("failed to activate session", "error", err)
		}
	}

	if created {
		log.Info("process created", "resume", resume, "mode", meta.Mode)
	}

	return proc, nil
}
