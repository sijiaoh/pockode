// Package canvas holds a canvas session's page: the current document as session
// state, and every revision it ever had as a snapshot of its own.
//
// The two are kept apart on purpose (AGENTS.md: events are events, state is
// state). The page on screen now is state — owned by Store, pushed to whoever
// shows the session. That a call drew revision 8 is a fact, recorded once on
// that call's tool_result as canvas_revision and kept as the revision's
// snapshot forever. Nothing reads the current page back out of the transcript.
//
// The design, and the contract with the frontend, is docs/canvas-ui.md.
package canvas

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Size is a canvas area in whole CSS pixels.
type Size struct {
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Op is one step of a canvas_update. HTML is absent for a remove and may be
// empty for a replace, which is why it is a pointer: an empty replace still
// says `"html": ""` on the wire, where a remove says nothing.
type Op struct {
	Op     string  `json:"op"`
	Region string  `json:"region"`
	HTML   *string `json:"html,omitempty"`
}

// The op names of canvas_update (docs/canvas-ui.md §3.2).
const (
	OpReplace = "replace"
	OpAppend  = "append"
	OpRemove  = "remove"
)

// ChangeKind says how a revision came from the one before it.
type ChangeKind string

const (
	ChangeRender ChangeKind = "render"
	ChangeUpdate ChangeKind = "update"
)

// Change is how a revision came from the previous one. An update carries its
// ops, so a client showing FromRevision can patch the live page instead of
// drawing it again (docs/canvas-ui.md §8.3).
type Change struct {
	Kind         ChangeKind `json:"kind"`
	FromRevision int        `json:"from_revision,omitempty"`
	Ops          []Op       `json:"ops,omitempty"`
}

// Snapshot is one revision, whole. It is written once and never changed: an old
// revision is read back as it was shown, never rebuilt by replaying ops.
type Snapshot struct {
	Revision int    `json:"revision"`
	HTML     string `json:"html"`
	// DrawnFor is the size the user had last reported when the revision was
	// drawn; absent when none had been reported yet.
	DrawnFor *Size     `json:"drawn_for,omitempty"`
	Change   Change    `json:"change"`
	DrawnAt  time.Time `json:"drawn_at"`
}

// State is the current canvas as it is pushed to a client: the snapshot the
// canvas is at, or revision 0 and nothing else before anything was drawn.
type State struct {
	Revision int        `json:"revision"`
	HTML     string     `json:"html,omitempty"`
	DrawnFor *Size      `json:"drawn_for,omitempty"`
	Change   *Change    `json:"change,omitempty"`
	DrawnAt  *time.Time `json:"drawn_at,omitempty"`
}

func (s Snapshot) state() State {
	change := s.Change
	drawnAt := s.DrawnAt
	return State{
		Revision: s.Revision,
		HTML:     s.HTML,
		DrawnFor: s.DrawnFor,
		Change:   &change,
		DrawnAt:  &drawnAt,
	}
}

// The tools' own names, as the MCP server lists them.
const (
	RenderTool = "canvas_render"
	UpdateTool = "canvas_update"
)

// IsTool reports whether a tool_call's name is one of the canvas tools, under
// either engine's name for an MCP tool: Claude prefixes the server
// (mcp__pockode__canvas_render), Codex joins server and tool with a colon
// (pockode:canvas_render). The client keeps its own copy of these names
// (docs/canvas-ui.md, Key Files).
func IsTool(toolName string) bool {
	for _, prefix := range []string{"mcp__pockode__", "pockode:"} {
		if name, ok := strings.CutPrefix(toolName, prefix); ok {
			return name == RenderTool || name == UpdateTool
		}
	}
	return false
}

// resultPrefix opens every successful canvas tool result. It is a contract
// (docs/canvas-ui.md §9.4): RevisionFromResult reads the revision back from it
// when the call's result is recorded, which is how a snapshot is linked to the
// call that drew it.
const resultPrefix = "Canvas revision "

// ResultText is what a successful canvas_render or canvas_update returns to
// the agent. warnings are lint warnings, each a sentence that says how to fix
// it.
func ResultText(s Snapshot, warnings []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s%d · ", resultPrefix, s.Revision)
	if s.DrawnFor != nil {
		fmt.Fprintf(&b, "drawn for %d×%d.", s.DrawnFor.Width, s.DrawnFor.Height)
	} else {
		b.WriteString("drawn for an unknown size (no message has reported one yet: design for a narrow phone screen, about 360px wide, that also works wider).")
	}
	b.WriteString("\nThe user sees it now; do not describe it in your reply.")
	if len(warnings) > 0 {
		b.WriteString("\nWarnings:")
		for _, w := range warnings {
			b.WriteString("\n- ")
			b.WriteString(w)
		}
	}
	return b.String()
}

// FailureText is what a refused canvas call returns, as an is_error result:
// the canvas is unchanged, and every problem is listed with its fix.
func FailureText(revision int, problems []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Canvas not changed (still revision %d):", revision)
	for _, p := range problems {
		b.WriteString("\n- ")
		b.WriteString(p)
	}
	return b.String()
}

// Action is what the user did on the page: a canvas action as its message
// record carries it (docs/canvas-ui.md §6.2). It is a fact about one moment and
// is never updated — Revision is the revision the frame was showing then, which
// may be older than the canvas by the time the agent reads it.
type Action struct {
	Action string `json:"action"`
	// Data is compact JSON; `{}` when the page sent none.
	Data     json.RawMessage `json:"data"`
	Revision int             `json:"revision"`
}

// ActionText is a canvas action as the agent reads it, and as its message
// record's content holds it (docs/canvas-ui.md §6.3).
func ActionText(a Action) string {
	return fmt.Sprintf("Canvas action %s from revision %d:\n%s", strconv.Quote(a.Action), a.Revision, a.Data)
}

// RevisionFromResult reads the revision a successful canvas call drew out of
// its result text, as ResultText wrote it.
func RevisionFromResult(text string) (int, bool) {
	rest, ok := strings.CutPrefix(text, resultPrefix)
	if !ok {
		return 0, false
	}
	digits, _, ok := strings.Cut(rest, " ")
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(digits)
	if err != nil || n < 1 {
		return 0, false
	}
	return n, true
}

// ForkPoint is what a fork's canvas is, read from the history records the fork
// keeps (docs/canvas-ui.md §13.6): the highest revision a kept tool_result
// drew, and the last size a kept message reported.
//
// The records are read for the two fields alone. Revisions are numbered in the
// order they were drawn, so the highest one kept is the canvas as it was at
// the cut, whichever record came last.
func ForkPoint(records []json.RawMessage) (revision int, reported *Size) {
	for _, raw := range records {
		var rec struct {
			CanvasRevision int   `json:"canvas_revision"`
			CanvasSize     *Size `json:"canvas_size"`
		}
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		revision = max(revision, rec.CanvasRevision)
		if rec.CanvasSize != nil {
			reported = rec.CanvasSize
		}
	}
	return revision, reported
}
