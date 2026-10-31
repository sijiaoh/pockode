package mcp

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pockode/server/canvas"
	"github.com/pockode/server/chat"
)

// The refusals of docs/canvas-ui.md §3.4, worded there: what a canvas session
// does instead, and that the canvas tools belong to one.
const (
	refuseHTMLRenderInCanvas = "This is a canvas session: show it in the canvas with canvas_render or canvas_update instead."
	refuseQuestionInCanvas   = "This is a canvas session: draw the question into the canvas — buttons for choices, a form for input — instead of posting it."
	refuseCanvasOutside      = "canvas tools are only available in a canvas session"
)

// refuseInCanvas refuses, with refusal, an ordinary tool called from a canvas
// session. The session's stored property decides, not the proxy's --canvas
// flag, which only decides what is listed.
//
// A call without a session, or from a session the worktree does not have (one
// deleted while its process finished a turn, a proxy started by hand), is from
// no canvas session and goes on to the tool as it did before canvas sessions
// existed; the tool reports a missing session itself where that matters.
func (e *Executor) refuseInCanvas(caller Caller, refusal string) error {
	if caller.SessionID == "" {
		return nil
	}
	_, isCanvas, release, err := e.sessions.ResolveCanvas(caller.Worktree, caller.SessionID)
	if errors.Is(err, chat.ErrSessionNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	release()
	if isCanvas {
		return userErrorf("%s", refusal)
	}
	return nil
}

func (e *Executor) canvasRender(caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		HTML string `json:"html"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	return e.drawCanvas(caller, func(b canvas.Base) (canvas.Page, canvas.Change, error) {
		page, err := canvas.CheckRender(params.HTML, width(b))
		return page, canvas.Change{Kind: canvas.ChangeRender}, err
	})
}

func (e *Executor) canvasUpdate(caller Caller, args json.RawMessage) (string, error) {
	var params struct {
		Ops []canvas.Op `json:"ops"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", userErrorf("invalid arguments: %w", err)
	}
	return e.drawCanvas(caller, func(b canvas.Base) (canvas.Page, canvas.Change, error) {
		page, err := canvas.ApplyUpdate(b.HTML, params.Ops, width(b))
		return page, canvas.Change{Kind: canvas.ChangeUpdate, Ops: params.Ops}, err
	})
}

// drawCanvas stores the revision build makes from the canvas as it is, and
// answers with the result text the agent reads (docs/canvas-ui.md §9.4).
//
// build runs under the session's canvas lock (canvas.Store.Apply), so it only
// parses and lints: it must not reach back into the canvas or the session
// store.
func (e *Executor) drawCanvas(caller Caller, build func(canvas.Base) (canvas.Page, canvas.Change, error)) (string, error) {
	if caller.SessionID == "" {
		return "", userErrorf("%s", refuseCanvasOutside)
	}
	store, isCanvas, release, err := e.sessions.ResolveCanvas(caller.Worktree, caller.SessionID)
	if err != nil {
		return "", err
	}
	defer release()
	if !isCanvas {
		return "", userErrorf("%s", refuseCanvasOutside)
	}

	var base int
	var warnings []string
	snap, err := store.Apply(caller.SessionID, func(b canvas.Base) (canvas.Draft, error) {
		base = b.Revision
		page, change, err := build(b)
		if err != nil {
			return canvas.Draft{}, err
		}
		warnings = page.Warnings
		return canvas.Draft{HTML: page.HTML, Change: change}, nil
	})
	if err != nil {
		var rejection *canvas.Rejection
		if errors.As(err, &rejection) {
			return "", &resultError{text: canvas.FailureText(base, rejection.Problems)}
		}
		return "", fmt.Errorf("draw the canvas: %w", err)
	}
	return canvas.ResultText(snap, warnings), nil
}

// width is the canvas width the next revision is drawn for, 0 when no message
// has reported one (which skips lint's width check).
func width(b canvas.Base) int {
	if b.ReportedSize == nil {
		return 0
	}
	return b.ReportedSize.Width
}
