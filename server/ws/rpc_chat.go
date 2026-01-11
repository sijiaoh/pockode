package ws

import (
	"context"
	"fmt"
	"log/slog"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/rpc"
	"github.com/sourcegraph/jsonrpc2"
)

func (h *rpcMethodHandler) handleAttach(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.AttachParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	// Verify session exists
	_, found, err := h.sessionStore.Get(params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, "failed to get session")
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	// Subscribe to session events
	h.state.subscribe(params.SessionID, conn)

	// Return whether process is running
	processRunning := h.manager.HasProcess(params.SessionID)
	result := rpc.AttachResult{ProcessRunning: processRunning}

	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send attach response", "error", err)
		return
	}

	log.Info("subscribed to session", "processRunning", processRunning)
}

func (h *rpcMethodHandler) handleMessage(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.MessageParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	h.recordCommandIfSlash(params.Content)

	log.Info("received prompt", "length", len(params.Content))

	// Persist user message to history
	event := agent.MessageEvent{Content: params.Content}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(event)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	// Send message to agent
	if err := sess.SendMessage(params.Content); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send message response", "error", err)
	}
}

func (h *rpcMethodHandler) handleInterrupt(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.InterruptParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	if err := sess.SendInterrupt(); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	log.Info("sent interrupt")

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send interrupt response", "error", err)
	}
}

func (h *rpcMethodHandler) handlePermissionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.PermissionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
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

	if err := sess.SendPermissionResponse(data, choice); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist permission response to history
	permEvent := agent.PermissionResponseEvent{RequestID: params.RequestID, Choice: params.Choice}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(permEvent)); err != nil {
		log.Error("failed to append to history", "error", err)
	}

	log.Info("sent permission response", "choice", params.Choice)

	if err := conn.Reply(ctx, req.ID, struct{}{}); err != nil {
		log.Error("failed to send permission response", "error", err)
	}
}

func (h *rpcMethodHandler) handleQuestionResponse(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request) {
	var params rpc.QuestionResponseParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	sess, err := h.getOrCreateProcess(ctx, log, params.SessionID)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	data := agent.QuestionRequestData{
		RequestID: params.RequestID,
		ToolUseID: params.ToolUseID,
	}

	if err := sess.SendQuestionResponse(data, params.Answers); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInternalError, err.Error())
		return
	}

	// Persist question response to history
	qEvent := agent.QuestionResponseEvent{RequestID: params.RequestID, Answers: params.Answers}
	if err := h.sessionStore.AppendToHistory(ctx, params.SessionID, agent.NewHistoryRecord(qEvent)); err != nil {
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

func (h *rpcMethodHandler) getOrCreateProcess(ctx context.Context, log *slog.Logger, sessionID string) (agent.Session, error) {
	meta, found, err := h.sessionStore.Get(sessionID)
	if err != nil {
		return nil, fmt.Errorf("failed to get session: %w", err)
	}
	if !found {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}

	resume := meta.Activated
	proc, created, err := h.manager.GetOrCreateProcess(ctx, sessionID, resume)
	if err != nil {
		return nil, err
	}

	// Mark as activated on first process creation
	if created && !resume {
		if err := h.sessionStore.Activate(ctx, sessionID); err != nil {
			log.Error("failed to activate session", "error", err)
		}
	}

	if created {
		log.Info("process created", "resume", resume)
	}

	return proc.AgentSession(), nil
}
