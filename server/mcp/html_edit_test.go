package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/pockode/server/htmlpage"
)

func render(t *testing.T, e *Executor, title, html string) {
	t.Helper()
	if _, err := e.Execute(context.Background(), pageCaller, "html_render", json.RawMessage(renderArgs(title, html))); err != nil {
		t.Fatalf("html_render: %v", err)
	}
}

func editArgs(t *testing.T, base, title string, edits ...htmlpage.Edit) json.RawMessage {
	t.Helper()
	wire := make([]map[string]any, len(edits))
	for i, edit := range edits {
		wire[i] = map[string]any{"old": edit.Old, "new": edit.New, "replace_all": edit.ReplaceAll}
	}
	b, err := json.Marshal(map[string]any{"base": base, "title": title, "edits": wire})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The HTML comes back raw after the marker, so the text the agent reads is the
// text html_edit's old has to match.
func TestHTMLGetReturnsThePageVerbatimAndListsThePages(t *testing.T) {
	e, _ := pageExecutor(t)
	html := "<p class=\"a\">\n\t\"quoted\" \\ back</p>"
	render(t, e, "One", html)
	render(t, e, "Two", "<p>2</p>")

	reply, err := e.Execute(context.Background(), pageCaller, "html_get", json.RawMessage(`{"id":"p1"}`))
	if err != nil {
		t.Fatalf("html_get: %v", err)
	}
	head, got, ok := strings.Cut(reply, htmlSourceMarker+"\n")
	if !ok {
		t.Fatalf("reply %q has no marker line", reply)
	}
	if got != html {
		t.Errorf("html = %q, want %q", got, html)
	}
	if !strings.HasPrefix(head, `p1 "One"`) || !strings.Contains(head, `p1 "One", p2 "Two"`) {
		t.Errorf("head %q should name the page and list both", head)
	}
	// Not a page tool's result: it must not read as one that stored a page.
	if _, ok := htmlpage.IDFromResult(reply); ok {
		t.Errorf("reply %q reads as naming a stored page", reply)
	}
}

func TestHTMLEditDerivesANewPageAndLeavesTheBase(t *testing.T) {
	e, dataDir := pageExecutor(t)
	render(t, e, "Plans", "<td>a</td><td>a</td><h1>Plans</h1>")

	reply, err := e.Execute(context.Background(), pageCaller, "html_edit", editArgs(t, "p1", "",
		htmlpage.Edit{Old: "<td>a</td>", New: "<td>b</td>", ReplaceAll: true},
		htmlpage.Edit{Old: "<h1>Plans</h1>", New: "<h1>New plans</h1>"},
	))
	if err != nil {
		t.Fatalf("html_edit: %v", err)
	}
	if id, ok := htmlpage.IDFromResult(reply); !ok || id != "p2" {
		t.Errorf("reply %q names page %q, want p2", reply, id)
	}
	derived, err := htmlpage.Get(dataDir, "s1", "p2")
	if err != nil {
		t.Fatal(err)
	}
	if derived.HTML != "<td>b</td><td>b</td><h1>New plans</h1>" || derived.Base != "p1" || derived.Title != "Plans" {
		t.Errorf("derived page = %+v; want the edits applied, base p1 and the base's title", derived)
	}
	base, err := htmlpage.Get(dataDir, "s1", "p1")
	if err != nil {
		t.Fatal(err)
	}
	if base.HTML != "<td>a</td><td>a</td><h1>Plans</h1>" {
		t.Errorf("base changed to %q", base.HTML)
	}

	if _, err := e.Execute(context.Background(), pageCaller, "html_edit", editArgs(t, "p2", "Renamed", htmlpage.Edit{Old: "b", New: "c", ReplaceAll: true})); err != nil {
		t.Fatalf("html_edit: %v", err)
	}
	if p3, err := htmlpage.Get(dataDir, "s1", "p3"); err != nil || p3.Title != "Renamed" || p3.Base != "p2" {
		t.Errorf("p3 = %+v, %v; want the given title and base p2", p3, err)
	}
}

func TestHTMLPageToolsRefuse(t *testing.T) {
	tests := []struct {
		name      string
		tool      string
		noSession bool
		args      string
		wantErr   string
	}{
		{name: "get: missing id", tool: "html_get", args: `{}`, wantErr: "id is required"},
		{name: "get: unknown id lists the pages", tool: "html_get", args: `{"id":"p9"}`, wantErr: `page "p9" not found in this chat; its pages, oldest first: p1 "Base"`},
		{name: "get: not an id", tool: "html_get", args: `{"id":"../x"}`, wantErr: "not found"},
		{name: "get: no session", tool: "html_get", noSession: true, args: `{"id":"p1"}`, wantErr: "Pockode session"},
		{name: "edit: missing base", tool: "html_edit", args: `{"edits":[{"old":"a","new":"b"}]}`, wantErr: "base is required"},
		{name: "edit: unknown base", tool: "html_edit", args: `{"base":"p2","edits":[{"old":"a","new":"b"}]}`, wantErr: `page "p2" not found`},
		{name: "edit: no edits", tool: "html_edit", args: `{"base":"p1"}`, wantErr: "edits is required"},
		{name: "edit: not unique", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"<td>","new":"<th>"}]}`, wantErr: "edit 1: old matches 2 places"},
		{name: "edit: not found", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"<b>","new":"<i>"}]}`, wantErr: "edit 1: old was not found"},
		{name: "edit: one bad edit stores nothing", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"x","new":"y","replace_all":true},{"old":"<b>","new":"<i>"}]}`, wantErr: "edit 2: old was not found"},
		{name: "edit: empties the page", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"<td>x</td>","new":" ","replace_all":true}]}`, wantErr: "the edits leave the page empty"},
		{name: "edit: new missing", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"x","new_string":"y","replace_all":true}]}`, wantErr: "edit 1: new is missing"},
		{name: "edit: old missing", tool: "html_edit", args: `{"base":"p1","edits":[{"old_string":"x","new":"y"}]}`, wantErr: "edit 1: old is missing or empty"},
		{name: "edit: over the limit", tool: "html_edit", args: `{"base":"p1","edits":[{"old":"x","new":"` + strings.Repeat("a", htmlpage.MaxHTMLBytes) + `","replace_all":true}]}`, wantErr: "256KB"},
		{name: "edit: edits not a list", tool: "html_edit", args: `{"base":"p1","edits":"x"}`, wantErr: "invalid arguments"},
		{name: "edit: no session", tool: "html_edit", noSession: true, args: `{"base":"p1","edits":[{"old":"x","new":"y"}]}`, wantErr: "Pockode session"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, dataDir := pageExecutor(t)
			render(t, e, "Base", "<td>x</td><td>x</td>")
			caller := pageCaller
			if tt.noSession {
				caller = Caller{}
			}
			_, err := e.Execute(context.Background(), caller, tt.tool, json.RawMessage(tt.args))
			if err == nil || !isUserError(err) {
				t.Fatalf("err = %v, want a user error", err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %q, want it to mention %q", err, tt.wantErr)
			}
			if list, _ := htmlpage.List(dataDir, "s1"); len(list) != 1 {
				t.Errorf("a refused call left pages %+v", list)
			}
		})
	}
}
