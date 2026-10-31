package ws

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"unicode"
	"unicode/utf8"

	"github.com/pockode/server/canvas"
	"github.com/pockode/server/chat"
	"github.com/pockode/server/rpc"
	"github.com/pockode/server/worktree"
	"github.com/sourcegraph/jsonrpc2"
)

// canvasSession answers whether sessionID is a canvas session the request may
// read the canvas of, replying itself when it is not.
func (h *rpcMethodHandler) canvasSession(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree, sessionID string) bool {
	meta, found, err := wt.SessionStore.Get(sessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to get session", err, "sessionId", sessionID)
		return false
	}
	if !found {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "session not found")
		return false
	}
	if !meta.Canvas {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "this session is not a canvas session")
		return false
	}
	return true
}

func (h *rpcMethodHandler) handleChatCanvasHistory(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.ChatCanvasHistoryParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.canvasSession(ctx, conn, req, wt, params.SessionID) {
		return
	}

	snapshots, err := wt.CanvasStore.History(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read the canvas history", err, "sessionId", params.SessionID)
		return
	}
	if err := conn.Reply(ctx, req.ID, rpc.ChatCanvasHistoryResult{Snapshots: snapshots}); err != nil {
		h.log.Error("failed to send canvas history response", "error", err)
	}
}

func (h *rpcMethodHandler) handleChatCanvasSnapshot(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.ChatCanvasSnapshotParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.canvasSession(ctx, conn, req, wt, params.SessionID) {
		return
	}

	snap, err := wt.CanvasStore.Snapshot(params.SessionID, params.Revision)
	if errors.Is(err, canvas.ErrNoRevision) {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read the canvas revision", err, "sessionId", params.SessionID, "revision", params.Revision)
		return
	}
	if err := conn.Reply(ctx, req.ID, snap); err != nil {
		h.log.Error("failed to send canvas snapshot response", "error", err)
	}
}

// The bounds of chat.canvas_action and of a canvas_size (docs/canvas-ui.md
// §6.4).
const (
	maxCanvasActionRunes = 128
	maxCanvasActionData  = 64 * 1024
	maxCanvasSide        = 10000
)

// checkCanvasSize turns a canvas size a client sent into one the server keeps,
// or refuses it with the words of the contract.
func checkCanvasSize(p *rpc.CanvasSizeParams) (canvas.Size, error) {
	for _, v := range []float64{p.Width, p.Height} {
		if v != math.Trunc(v) || v < 1 || v > maxCanvasSide {
			return canvas.Size{}, errors.New("canvas_size must be whole CSS pixels between 1 and 10000")
		}
	}
	return canvas.Size{Width: int(p.Width), Height: int(p.Height)}, nil
}

// checkCanvasAction turns chat.canvas_action's params into the action its
// record will carry, or refuses them with the words of the contract. The
// revision is checked against the canvas by the caller.
func checkCanvasAction(params rpc.CanvasActionParams) (canvas.Action, error) {
	n := utf8.RuneCountInString(params.Action)
	hasControl := false
	for _, r := range params.Action {
		if unicode.IsControl(r) {
			hasControl = true
			break
		}
	}
	if n < 1 || n > maxCanvasActionRunes || hasControl {
		return canvas.Action{}, errors.New("action must be 1–128 characters with no control characters")
	}

	// Compacted, so that the agent reads and the record holds one line of it
	// whatever whitespace the page's JSON.stringify left in.
	data := json.RawMessage("{}")
	if len(params.Data) > 0 {
		var buf bytes.Buffer
		if err := json.Compact(&buf, params.Data); err != nil {
			return canvas.Action{}, fmt.Errorf("data is not JSON: %w", err)
		}
		data = buf.Bytes()
	}
	if len(data) > maxCanvasActionData {
		return canvas.Action{}, fmt.Errorf("data is %d bytes, over the 64KB limit", len(data))
	}

	// Revision 0 is the canvas before anything was drawn, which has no page
	// to act on.
	if params.Revision < 1 {
		return canvas.Action{}, fmt.Errorf("revision must be 1 or higher: an action comes from a page that was drawn, and revision %d was not", params.Revision)
	}
	return canvas.Action{Action: params.Action, Data: data, Revision: params.Revision}, nil
}

// handleChatCanvasAction delivers something the user did on a canvas page to
// the agent, as a message of its own (docs/canvas-ui.md §6.4).
func (h *rpcMethodHandler) handleChatCanvasAction(ctx context.Context, conn *jsonrpc2.Conn, req *jsonrpc2.Request, wt *worktree.Worktree) {
	var params rpc.CanvasActionParams
	if err := unmarshalParams(req, &params); err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, "invalid params")
		return
	}
	if !h.canvasSession(ctx, conn, req, wt, params.SessionID) {
		return
	}

	log := h.log.With("sessionId", params.SessionID)

	action, err := checkCanvasAction(params)
	if err != nil {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
		return
	}
	// Only newer is refused. An older revision is the ordinary case of a press
	// on a page that was being redrawn, and the agent is told which one it was.
	current, err := wt.CanvasStore.Current(params.SessionID)
	if err != nil {
		h.replyInternalError(ctx, conn, req.ID, "failed to read the session's canvas", err, "sessionId", params.SessionID)
		return
	}
	if action.Revision > current.Revision {
		h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams,
			fmt.Sprintf("revision %d does not exist yet: the canvas is at %d", action.Revision, current.Revision))
		return
	}

	from := chat.Sender{Exclude: h.state.getNotifier()}
	if params.CanvasSize != nil {
		size, err := checkCanvasSize(params.CanvasSize)
		if err != nil {
			h.replyError(ctx, conn, req.ID, jsonrpc2.CodeInvalidParams, err.Error())
			return
		}
		from.CanvasSize = &size
	}

	log.Info("received canvas action", "revision", action.Revision, "dataBytes", len(action.Data))

	sent, content, err := wt.ChatClient.SendCanvasAction(ctx, params.SessionID, action, from)
	if err != nil {
		h.replyErrorForChat(ctx, conn, req, params.SessionID, err)
		return
	}

	// After the send; see handleMessage. A canvas action is the user's input
	// like any typed message.
	h.workEngine.HandleUserMessage(params.SessionID)

	result := rpc.MessageResult{Seq: sent.Seq, MessageID: sent.MessageID, Content: content, CanvasAction: &action}
	if err := conn.Reply(ctx, req.ID, result); err != nil {
		log.Error("failed to send response", "error", err)
	}
}
