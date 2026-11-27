package work

import (
	"encoding/json"
	"testing"
)

func TestToolTarget(t *testing.T) {
	tests := []struct {
		tool, input string
		id          string
		creates, ok bool
	}{
		{tool: "task_start", input: `{"id":"w1"}`, id: "w1", ok: true},
		{tool: "work_comment_add", input: `{"work_id":"w2","body":"x"}`, id: "w2", ok: true},
		{tool: "task_list", input: `{"story_id":"s1"}`, id: "s1", ok: true},
		{tool: "task_create", input: `{"story_id":"s1","title":"T"}`, creates: true, ok: true},
		{tool: "story_create", input: `{}`, creates: true, ok: true},
		// Its id names a comment, not a work.
		{tool: "work_comment_update", input: `{"id":"c1"}`},
		{tool: "story_list", input: `{}`},
		{tool: "html_render", input: `{"id":"w1"}`},
		{tool: "work_get", input: `{}`},
		{tool: "work_get", input: `{"id":7}`},
		{tool: "work_get", input: `not json`},
	}
	for _, tt := range tests {
		id, creates, ok := ToolTarget(tt.tool, json.RawMessage(tt.input))
		if id != tt.id || creates != tt.creates || ok != tt.ok {
			t.Errorf("ToolTarget(%s, %s) = %q, %v, %v; want %q, %v, %v",
				tt.tool, tt.input, id, creates, ok, tt.id, tt.creates, tt.ok)
		}
	}
}

func TestIDFromCreateResult(t *testing.T) {
	task := Work{ID: "01a2", StoryID: "s1", Title: `Say ") (ID: nope)" twice`}
	tests := []struct {
		result, want string
	}{
		{CreateResult(task), "01a2"},
		{CreateResult(Work{ID: "s9", Title: "Story"}), "s9"},
		{"Comment added (ID: c1)", ""},
		{`Created task "T" (ID: )`, ""},
		{`Created task "T"`, ""},
		{"Error: Created nothing (ID: x)", ""},
	}
	for _, tt := range tests {
		got, ok := IDFromCreateResult(tt.result)
		if got != tt.want || ok != (tt.want != "") {
			t.Errorf("IDFromCreateResult(%q) = %q, %v; want %q", tt.result, got, ok, tt.want)
		}
	}
}
