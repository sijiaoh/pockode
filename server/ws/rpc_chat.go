package ws

import (
	"context"
	"errors"
	"time"
	"unicode"

	"github.com/pockode/server/agent"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/command"
	"github.com/pockode/server/process"
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

	// The session's turn is read here; its settings are not, because those belong
	// to session.detail.subscribe, which the client runs alongside this one.
	meta, found, err := wt.SessionStore.Get(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
		return
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return
	}

	notifier := h.state.getNotifier()
	page, err := wt.ChatMessagesWatcher.Subscribe(params.ID, notifier, params.SessionID, params.Limit)
	if err != nil {
		// An unusable subscription id or a limit the client cannot ask for are its
		// mistakes; anything else Subscribe fails on is a history the server could
		// not read.
		if h.replySubscriptionIDError(ctx, conn, req.ID, err) {
			return
		}
		if errors.Is(err, session.ErrInvalidHistoryLimit) {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		h.replyInternalError(ctx, conn, req.ID, "failed to read session history", err, "sessionId", params.SessionID)
		return
	}
	h.state.trackSubscription(params.ID, wt.ChatMessagesWatcher)

	wt.SessionListWatcher.MarkRead(params.SessionID)

	result := rpc.ChatMessagesSubscribeResult{
		History:       page.Records,
		HasMore:       page.HasMore,
		NextBeforeSeq: page.NextBeforeSeq,
		// From the store, not from the process manager: the turn is what the
		// session is doing, and it is recorded whether or not a process is still
		// there to be asked.
		Turn:         rpc.NewTurn(meta.Turn, time.Now()),
		ToolActivity: wt.ProcessManager.GetToolActivity(params.SessionID),
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send subscribe response", "error", err)
		return
	}

	log.Info("subscribed to chat messages",
		"subscriptionId", params.ID, "phase", result.Turn.Phase,
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

	// A message answering questions is written by the server from the answers
	// (chat.Client.SendAnswers), so content beside them has nowhere to go.
	// Refused rather than dropped: it is something the user typed — a command,
	// or a word to the agent — and which of the two messages they meant is not
	// the server's to guess.
	if len(params.Answering) > 0 && params.Content != "" {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams,
			"Answers are sent on their own: the message the agent reads is written from them. Send the answers first, then the rest as a message of its own. If you did not type anything beside them, reload the page — this client is out of date.")
		return
	}

	if len(params.Answering) > 0 && len(params.Attachments) > 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams,
			"Answers are sent on their own: send the answers first, then the files as a message of their own.")
		return
	}

	if params.Content == "" && len(params.Answering) == 0 && len(params.Attachments) == 0 {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "the message is empty")
		return
	}

	// Resolved before anything is sent, like a command below, so a message
	// naming a file the session does not have leaves no trace.
	var attached []agent.Attachment
	if len(params.Attachments) > 0 {
		// The session id picks the directory the ids are resolved in, so one this
		// worktree does not have must not become a path at all — the rule
		// attachment.get keeps for the same reason.
		_, found, err := wt.SessionStore.Get(params.SessionID)
		if err != nil {
			h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", params.SessionID)
			return
		}
		if !found {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
			return
		}
		refs := make([]chat.AttachmentRef, len(params.Attachments))
		for i, a := range params.Attachments {
			refs[i] = chat.AttachmentRef{ID: a.ID, Name: a.Name}
		}
		attached, err = chat.ResolveAttachments(log, wt.DataDir, params.SessionID, refs)
		if err != nil {
			if errors.Is(err, chat.ErrAttachmentNotFound) {
				h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			} else {
				h.replyInternalError(ctx, conn, req.ID, "failed to read attachments", err, "sessionId", params.SessionID)
			}
			return
		}
	}

	// Expanded before anything is sent, so a command that cannot be expanded
	// leaves no trace: it is refused, and never reaches the agent as the text the
	// user typed.
	content := params.Content
	cmd, isCommand := command.ParsePockode(params.Content)
	if isCommand {
		expanded, err := command.ExpandPockode(cmd, command.PockodeEnv{
			WorkDir:   wt.WorkDir,
			IsGitRepo: h.worktreeManager.Registry().IsGitRepo(),
		})
		if err != nil {
			if command.IsRefusal(err) {
				h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			} else {
				h.replyInternalError(ctx, conn, req.ID, "failed to expand /"+cmd.Name, err, "sessionId", params.SessionID)
			}
			return
		}
		content = expanded
	}

	if isCommand {
		log.Info("received Pockode command", "command", cmd.Name, "length", len(content))
	} else {
		log.Info("received prompt", "length", len(content), "attachments", len(attached))
	}

	var sent chat.Sent
	var err error
	if isCommand {
		sent, err = wt.ChatClient.SendCommandExcluding(ctx, params.SessionID, content, cmd, attached, h.state.getNotifier())
	} else if len(params.Answering) > 0 {
		sent, content, err = wt.ChatClient.SendAnswers(ctx, params.SessionID,
			chatAnswers(params.Answering), h.state.getNotifier())
	} else {
		sent, err = wt.ChatClient.SendMessageExcluding(ctx, params.SessionID, content, attached, h.state.getNotifier())
	}
	if err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	// Only once the message is with the agent: the palette offers what was
	// used, and a command that was refused or never delivered was not.
	h.recordCommandIfSlash(params.Content)

	// After the send, and so in all three of these handlers: what resumes a work
	// is the agent having been handed something to go on. A send that failed —
	// no session, a CLI that would not start, an answer to a prompt nobody is
	// waiting on any more — handed it nothing, and a work resumed for it would
	// be left active with no turn coming to end it.
	//
	// A message that answers posted questions is the narrower of the two inputs:
	// it gives the work its nudge allowance back but leaves a wait on subtasks
	// alone, because answering what the agent asked is not a subtask closing.
	// Which one this is depends on what the *client sent*, not on what the send
	// resolved: an empty `answering` is a person typing, and that redirects the
	// work as any message does (see Engine.HandleAnswer).
	if len(params.Answering) > 0 {
		h.workEngine.HandleAnswer(params.SessionID)
	} else {
		h.workEngine.HandleUserMessage(params.SessionID)
	}

	// This connection is the one excluded from the broadcast, so the reply is
	// where it learns its own message's seq and id (see rpc.MessageResult).
	result := rpc.MessageResult{Seq: sent.Seq, MessageID: sent.MessageID}
	if isCommand {
		result.Content, result.Command = content, &cmd
	} else if len(params.Answering) > 0 {
		result.Content = content
	}
	for _, a := range attached {
		result.Attachments = append(result.Attachments, a.File)
	}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send response", "error", err)
	}
}

// chatAnswers narrows the wire shape of an answer to the one the chat client
// takes. The two are separate types for the reason rpc.MessageParams is not
// chat's own: what a client may send is decided at the boundary, not by
// whatever the domain type happens to hold.
func chatAnswers(answering []rpc.QuestionAnswerParams) []chat.Answer {
	if len(answering) == 0 {
		return nil
	}
	out := make([]chat.Answer, len(answering))
	for i, a := range answering {
		out[i] = chat.Answer{
			RequestID: a.RequestID,
			Answers:   a.Answers,
			Text:      a.Text,
			Declined:  a.Declined,
			Note:      a.Note,
		}
	}
	return out
}

func (h *rpcMethodHandler) handleInterrupt(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.InterruptParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	// No HandleUserMessage here, and that is the answer to "was interrupt
	// forgotten?" — it was not. Interrupt takes the turn away instead of handing
	// the session something to go on, and the aborted turn it produces stops the
	// work, so resuming a waiting work first would only walk it into stopped. The
	// session's own side needs nothing: the InterruptedEvent ends the turn
	// through the reducer, and every blocker it was holding expires with it.
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

	if err := wt.ChatClient.SendPermissionResponse(ctx, params.SessionID, data, choice); err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	// After the send; see handleMessage.
	h.workEngine.HandleUserMessage(params.SessionID)

	log.Info("sent permission response", "choice", params.Choice)

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
		errors.Is(err, chat.ErrTurnAwaitingAnswer) ||
		errors.Is(err, chat.ErrQuestionNotPending) ||
		errors.Is(err, chat.ErrAnswerShape) ||
		errors.Is(err, process.ErrRequestNotPending) ||
		errors.Is(err, chat.ErrForkAnchorOutOfRange) ||
		errors.Is(err, chat.ErrForkAnchorNoHistory) ||
		errors.Is(err, chat.ErrForkUnsupported) ||
		errors.Is(err, chat.ErrAttachmentsUnsupported) {
		// The request does not fit the session's history, state or agent — a prompt
		// whose process is gone or which is no longer being waited on, a message
		// answering a question somebody already resolved (the text names every
		// such request id and what became of it, which is what lets a client grey
		// those answers out and keep the rest of the draft), a message
		// sent into a turn that is holding a request open, a fork anchored past
		// the end of the history or at the very first message, a fork of a
		// session whose agent cannot be forked, files for an agent that cannot
		// receive them.
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
