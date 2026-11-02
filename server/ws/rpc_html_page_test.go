package ws

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/pockode/server/htmlpage"
	"github.com/pockode/server/rpc"
)

// storePage draws a page in the session the way html_render does.
func storePage(t *testing.T, env *testEnv, sessionID string, draft htmlpage.Draft) htmlpage.Page {
	t.Helper()
	dataDir := env.getMainWorktree().DataDir
	// A session has its directory by the time its agent draws anything.
	if err := os.MkdirAll(filepath.Join(dataDir, "sessions", sessionID), 0o755); err != nil {
		t.Fatal(err)
	}
	page, err := htmlpage.NewStore().Append(dataDir, sessionID, draft)
	if err != nil {
		t.Fatalf("store page: %v", err)
	}
	return page
}

func TestHandler_HTMLPageGet(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "First", HTML: "<p>1</p>"})
	stored := storePage(t, env, created.ID, htmlpage.Draft{Title: "Second", HTML: "<p>2</p>", Base: "p1"})

	resp := env.call("html_page.get", rpc.HTMLPageGetParams{SessionID: created.ID, ID: stored.ID})
	if resp.Error != nil {
		t.Fatalf("unexpected error: %s", resp.Error.Message)
	}
	var result rpc.HTMLPageGetResult
	if err := json.Unmarshal(resp.Result, &result); err != nil {
		t.Fatalf("failed to unmarshal result: %v", err)
	}
	if result.Page.ID != "p2" || result.Page.Title != "Second" || result.Page.HTML != "<p>2</p>" || result.Page.Base != "p1" {
		t.Errorf("page = %+v", result.Page)
	}
}

func TestHandler_HTMLPageGet_Rejects(t *testing.T) {
	env := newTestEnv(t, &mockAgent{})
	_, created := env.createSession()
	storePage(t, env, created.ID, htmlpage.Draft{Title: "T", HTML: "x"})

	tests := []struct {
		name   string
		params rpc.HTMLPageGetParams
	}{
		{"unknown page", rpc.HTMLPageGetParams{SessionID: created.ID, ID: "p2"}},
		{"not a page id", rpc.HTMLPageGetParams{SessionID: created.ID, ID: "../history"}},
		{"missing id", rpc.HTMLPageGetParams{SessionID: created.ID}},
		// The session id picks the directory, so it must be one of this
		// worktree's sessions.
		{"unknown session", rpc.HTMLPageGetParams{SessionID: "nope", ID: "p1"}},
		{"traversing session id", rpc.HTMLPageGetParams{SessionID: "../..", ID: "p1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if resp := env.call("html_page.get", tt.params); resp.Error == nil {
				t.Errorf("expected an error, got %s", resp.Result)
			}
		})
	}
}
