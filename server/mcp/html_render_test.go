package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pockode/server/htmlpage"
)

// fixedPageDirs answers every session with one data directory.
type fixedPageDirs string

func (d fixedPageDirs) PageDataDir(string, string) (string, error) { return string(d), nil }

func pageExecutor(t *testing.T) (*Executor, string) {
	t.Helper()
	dataDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", "s1"), 0o755); err != nil {
		t.Fatal(err)
	}
	e := &Executor{}
	e.SetPages(htmlpage.NewStore(), fixedPageDirs(dataDir))
	return e, dataDir
}

var pageCaller = Caller{SessionID: "s1"}

// The result is where the agent learns the page's id, and where the server
// reads it back to stamp the record (process.pageCalls), so both the wording and
// the stored page are the contract.
func TestHTMLRenderStoresThePageAndNamesIt(t *testing.T) {
	e, dataDir := pageExecutor(t)

	for i, title := range []string{"Plans", "Chart"} {
		reply, err := e.Execute(context.Background(), pageCaller, "html_render", json.RawMessage(renderArgs(title, "<p>"+title+"</p>")))
		if err != nil {
			t.Fatalf("html_render: %v", err)
		}
		want := htmlpage.FormatID(i + 1)
		if id, ok := htmlpage.IDFromResult(reply); !ok || id != want {
			t.Errorf("reply %q names page %q, want %s", reply, id, want)
		}
		if !strings.Contains(reply, `"`+title+`"`) {
			t.Errorf("reply %q does not name the title", reply)
		}
		page, err := htmlpage.Get(dataDir, "s1", want)
		if err != nil {
			t.Fatalf("Get(%s): %v", want, err)
		}
		if page.Title != title || page.HTML != "<p>"+title+"</p>" {
			t.Errorf("stored %+v", page)
		}
	}
}

func TestHTMLRenderRefuses(t *testing.T) {
	tests := []struct {
		name      string
		noSession bool
		args      string
		wantErr   string
	}{
		{name: "over the limit", args: renderArgs("Big", strings.Repeat("a", htmlpage.MaxHTMLBytes+1)), wantErr: "256KB"},
		{name: "empty html", args: `{"title":"T","html":""}`, wantErr: "html is required"},
		{name: "whitespace-only html", args: `{"title":"T","html":" \n\t"}`, wantErr: "html is required"},
		{name: "missing html", args: `{"title":"T"}`, wantErr: "html is required"},
		{name: "missing title", args: `{"html":"<p>x</p>"}`, wantErr: "title is required"},
		{name: "html not a string", args: `{"title":"T","html":42}`, wantErr: "invalid arguments"},
		{name: "no session", noSession: true, args: renderArgs("T", "<p>x</p>"), wantErr: "Pockode session"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e, dataDir := pageExecutor(t)
			caller := pageCaller
			if tt.noSession {
				caller = Caller{}
			}
			_, err := e.Execute(context.Background(), caller, "html_render", json.RawMessage(tt.args))
			if err == nil || !isUserError(err) {
				t.Fatalf("err = %v, want a user error", err)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("err = %q, want it to mention %q", err, tt.wantErr)
			}
			if list, _ := htmlpage.List(dataDir, "s1"); len(list) != 0 {
				t.Errorf("a refused call stored %+v", list)
			}
		})
	}
}

func renderArgs(title, html string) string {
	b, _ := json.Marshal(map[string]string{"title": title, "html": html})
	return string(b)
}
