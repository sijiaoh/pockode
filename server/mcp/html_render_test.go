package mcp

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

// The frontend draws the page straight from the call's input, so what this
// tool refuses is the whole of what keeps a page out of the chat.
func TestHTMLRender(t *testing.T) {
	tests := []struct {
		name      string
		args      string
		wantErr   string
		wantReply string
	}{
		{name: "fragment", args: `{"title":"Plans","html":"<table><tr><td>A</td></tr></table>"}`, wantReply: `"Plans"`},
		{name: "full document", args: `{"title":"Chart","html":"<!doctype html><html><body><canvas></canvas></body></html>"}`, wantReply: `"Chart"`},
		{name: "exactly at the limit", args: renderArgs("Big", strings.Repeat("a", maxHTMLRenderBytes)), wantReply: `"Big"`},
		{name: "over the limit", args: renderArgs("Big", strings.Repeat("a", maxHTMLRenderBytes+1)), wantErr: "256KB"},
		{name: "empty html", args: `{"title":"T","html":""}`, wantErr: "html is required"},
		{name: "whitespace-only html", args: `{"title":"T","html":" \n\t"}`, wantErr: "html is required"},
		{name: "missing html", args: `{"title":"T"}`, wantErr: "html is required"},
		{name: "missing title", args: `{"html":"<p>x</p>"}`, wantErr: "title is required"},
		{name: "html not a string", args: `{"title":"T","html":42}`, wantErr: "invalid arguments"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reply, err := (&Executor{}).Execute(context.Background(), Caller{}, "html_render", json.RawMessage(tt.args))
			if tt.wantErr != "" {
				if err == nil || !isUserError(err) {
					t.Fatalf("err = %v, want a user error", err)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("err = %q, want it to mention %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !strings.Contains(reply, tt.wantReply) {
				t.Errorf("reply = %q, want it to name %s", reply, tt.wantReply)
			}
		})
	}
}

func renderArgs(title, html string) string {
	b, _ := json.Marshal(map[string]string{"title": title, "html": html})
	return string(b)
}
