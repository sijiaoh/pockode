package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/pockode/server/canvas"
	"github.com/pockode/server/chat"
)

const canvasPage = `<button data-pk-send="go">Go</button><ul data-pk-region="results"><li>old</li></ul>`

// newCanvasExec is an executor whose session "c1" is a canvas session and every
// other session an ordinary one. Every worktree a test's calls took is checked
// to have been released when the test ends.
func newCanvasExec(t *testing.T) (*Executor, *canvas.Store) {
	exec, _, store := newCanvasExecWithSessions(t)
	return exec, store
}

func newCanvasExecWithSessions(t *testing.T) (*Executor, *stubSessions, *canvas.Store) {
	t.Helper()
	exec, sessions, _, _ := newQuestionExec(t)
	sessions.canvasSessions = map[string]bool{"c1": true}
	sessions.canvas = canvas.NewStore(t.TempDir())
	t.Cleanup(func() {
		if sessions.canvasHeld != 0 {
			t.Errorf("%d worktree(s) taken for the canvas were never released", sessions.canvasHeld)
		}
	})
	return exec, sessions, sessions.canvas
}

var canvasCaller = Caller{SessionID: "c1"}

func TestCanvasRender_DrawsTheWholePage(t *testing.T) {
	exec, store := newCanvasExec(t)

	text, err := callAs(t, exec, canvasCaller, canvas.RenderTool, map[string]string{"html": canvasPage})
	if err != nil {
		t.Fatalf("canvas_render: %v", err)
	}
	if !strings.HasPrefix(text, "Canvas revision 1 · drawn for an unknown size") {
		t.Errorf("result = %q, want revision 1 drawn for an unknown size", text)
	}
	// The first line is what the revision is read back from (§13.4).
	if rev, ok := canvas.RevisionFromResult(text); !ok || rev != 1 {
		t.Errorf("RevisionFromResult = %d, %v; want 1", rev, ok)
	}

	state, err := store.Current("c1")
	if err != nil {
		t.Fatal(err)
	}
	if state.Revision != 1 || !strings.Contains(state.HTML, `data-pk-send="go"`) || state.Change.Kind != canvas.ChangeRender {
		t.Errorf("stored state = %+v, want revision 1 rendered from the page", state)
	}
	// Stored serialized, so a fragment comes back as a document.
	if !strings.Contains(state.HTML, "<body>") {
		t.Errorf("stored html = %q, want the normalized document", state.HTML)
	}
}

func TestCanvasUpdate_ChangesTheCurrentPage(t *testing.T) {
	exec, store := newCanvasExec(t)
	if _, err := callAs(t, exec, canvasCaller, canvas.RenderTool, map[string]string{"html": canvasPage}); err != nil {
		t.Fatal(err)
	}

	text, err := callAs(t, exec, canvasCaller, canvas.UpdateTool, map[string]any{
		"ops": []map[string]string{{"op": "replace", "region": "results", "html": "<li>new</li>"}},
	})
	if err != nil {
		t.Fatalf("canvas_update: %v", err)
	}
	if !strings.HasPrefix(text, "Canvas revision 2 · ") {
		t.Errorf("result = %q, want revision 2", text)
	}

	state, err := store.Current("c1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(state.HTML, "<li>new</li>") || strings.Contains(state.HTML, "old") {
		t.Errorf("stored html = %q, want the region replaced", state.HTML)
	}
	// An update carries its ops, for a client patching the live page.
	if state.Change.Kind != canvas.ChangeUpdate || state.Change.FromRevision != 1 || len(state.Change.Ops) != 1 {
		t.Errorf("change = %+v, want the update from revision 1 with its op", state.Change)
	}
}

// The size the user reported is what the revision is drawn for and linted
// against, and the result says both.
func TestCanvasRender_DrawsForTheReportedSize(t *testing.T) {
	exec, store := newCanvasExec(t)
	if err := store.ReportSize("c1", canvas.Size{Width: 390, Height: 664}); err != nil {
		t.Fatal(err)
	}

	text, err := callAs(t, exec, canvasCaller, canvas.RenderTool, map[string]string{
		"html": canvasPage + `<style>.a { width: 480px }</style>`,
	})
	if err != nil {
		t.Fatalf("canvas_render: %v", err)
	}
	if !strings.HasPrefix(text, "Canvas revision 1 · drawn for 390×664.") {
		t.Errorf("result = %q, want it drawn for 390×664", text)
	}
	if !strings.Contains(text, "\nWarnings:\n- Fixed widths wider than the canvas (390px): 480px.") {
		t.Errorf("result = %q, want the width warning", text)
	}
}

// A refused call leaves the canvas where it was and reaches the agent as the
// failure text itself, with an is_error flag and no "Error:" in front of it.
func TestCanvasCalls_RefusedCallsLeaveTheCanvas(t *testing.T) {
	tests := []struct {
		name  string
		first bool // render canvasPage before the call
		tool  string
		args  any
		want  string
	}{
		{
			name: "update with nothing drawn",
			tool: canvas.UpdateTool,
			args: map[string]any{"ops": []map[string]string{{"op": "remove", "region": "results"}}},
			want: "Canvas not changed (still revision 0):\n- There is no canvas yet: draw the whole page with canvas_render first.",
		},
		{
			name:  "update of a missing region",
			first: true,
			tool:  canvas.UpdateTool,
			args:  map[string]any{"ops": []map[string]string{{"op": "remove", "region": "resluts"}}},
			want:  "Canvas not changed (still revision 1):\n- There is no region \"resluts\". Regions on the page: results.",
		},
		{
			name:  "render of an empty page",
			first: true,
			tool:  canvas.RenderTool,
			args:  map[string]string{"html": "<!-- nothing -->"},
			want:  "Canvas not changed (still revision 1):\n- ",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			exec, store := newCanvasExec(t)
			if tt.first {
				if _, err := callAs(t, exec, canvasCaller, canvas.RenderTool, map[string]string{"html": canvasPage}); err != nil {
					t.Fatal(err)
				}
			}
			before, _ := store.Current("c1")

			_, err := callAs(t, exec, canvasCaller, tt.tool, tt.args)
			var re *resultError
			if !errors.As(err, &re) {
				t.Fatalf("err = %v, want the failure text as the whole result", err)
			}
			if !strings.HasPrefix(re.text, tt.want) {
				t.Errorf("result = %q, want it to start %q", re.text, tt.want)
			}
			if !isUserError(err) {
				t.Error("a refused draw is logged as a server fault")
			}
			if after, _ := store.Current("c1"); after.Revision != before.Revision {
				t.Errorf("revision moved from %d to %d on a refused call", before.Revision, after.Revision)
			}
		})
	}
}

func TestCanvasCalls_OnlyInACanvasSession(t *testing.T) {
	exec, store := newCanvasExec(t)
	for _, caller := range []Caller{{SessionID: "ordinary"}, {}} {
		for _, tool := range []string{canvas.RenderTool, canvas.UpdateTool} {
			_, err := callAs(t, exec, caller, tool, map[string]string{"html": canvasPage})
			if err == nil || err.Error() != refuseCanvasOutside || !isUserError(err) {
				t.Errorf("%s from %+v: err = %v, want %q", tool, caller, err, refuseCanvasOutside)
			}
		}
	}
	if state, _ := store.Current("ordinary"); state.Revision != 0 {
		t.Errorf("an ordinary session got a canvas: %+v", state)
	}
}

// What a canvas session asks and shows with instead, and the tools that stay.
func TestCanvasSession_RefusesTheToolsItDoesNotUse(t *testing.T) {
	exec, _ := newCanvasExec(t)
	for tool, want := range map[string]string{
		"html_render":     refuseHTMLRenderInCanvas,
		"question_post":   refuseQuestionInCanvas,
		"question_cancel": refuseQuestionInCanvas,
	} {
		_, err := callAs(t, exec, canvasCaller, tool, map[string]string{"title": "T", "html": "<p>x</p>", "request_id": "r"})
		if err == nil || err.Error() != want {
			t.Errorf("%s in a canvas session: err = %v, want %q", tool, err, want)
		}
	}

	// The same call from an ordinary session is still served.
	if _, err := callAs(t, exec, Caller{SessionID: "ordinary"}, "html_render", map[string]string{"title": "T", "html": "<p>x</p>"}); err != nil {
		t.Errorf("html_render in an ordinary session: %v", err)
	}
}

// A session the worktree does not have is no canvas session: the ordinary
// tools go on as they did before canvas sessions existed, and a draw is refused
// as a caller's mistake. Any other failure to read the session is a fault, and
// says so.
func TestCanvasCalls_WhenTheSessionCannotBeRead(t *testing.T) {
	exec, sessions, _ := newCanvasExecWithSessions(t)

	sessions.canvasErr = fmt.Errorf("%w: gone", chat.ErrSessionNotFound)
	if _, err := callAs(t, exec, Caller{SessionID: "gone"}, "html_render", map[string]string{"title": "T", "html": "<p>x</p>"}); err != nil {
		t.Errorf("html_render from a session the worktree does not have: %v", err)
	}
	if _, err := callAs(t, exec, Caller{SessionID: "gone"}, canvas.RenderTool, map[string]string{"html": canvasPage}); !errors.Is(err, chat.ErrSessionNotFound) || !isUserError(err) {
		t.Errorf("canvas_render from a session the worktree does not have: err = %v, want ErrSessionNotFound", err)
	}

	sessions.canvasErr = errors.New("disk on fire")
	for _, tool := range []string{"html_render", canvas.RenderTool} {
		_, err := callAs(t, exec, canvasCaller, tool, map[string]string{"title": "T", "html": canvasPage})
		if err == nil || !strings.Contains(err.Error(), "disk on fire") || isUserError(err) {
			t.Errorf("%s with an unreadable session: err = %v, want the fault, as a fault", tool, err)
		}
	}
}

// The handler sends a refused draw as written; any other tool error keeps its
// "Error:" prefix.
func TestAPIHandler_ResultErrorIsTheWholeText(t *testing.T) {
	for _, tc := range []struct {
		err  error
		want string
	}{
		{err: &resultError{text: "Canvas not changed (still revision 3):\n- x"}, want: "Canvas not changed (still revision 3):\n- x"},
		{err: userErrorf("bad"), want: "Error: bad"},
	} {
		h := NewAPIHandler(failingExecutor{err: tc.err}, "secret")
		req := httptest.NewRequest(http.MethodPost, APIPath, bytes.NewBufferString(`{"name":"canvas_render"}`))
		req.Header.Set("Authorization", "Bearer secret")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		var resp toolCallResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if !resp.IsError || resp.Text != tc.want {
			t.Errorf("response = %+v, want is_error with %q", resp, tc.want)
		}
	}
}

type failingExecutor struct{ err error }

func (e failingExecutor) Execute(context.Context, Caller, string, json.RawMessage) (string, error) {
	return "", e.err
}
