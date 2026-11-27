package agent

import "testing"

func TestPockodeTool(t *testing.T) {
	for name, want := range map[string]string{
		"mcp__pockode__html_render": "html_render",
		"pockode:task_create":       "task_create",
		"html_render":               "",
		"mcp__other__html_render":   "",
		"other:html_render":         "",
		"Bash":                      "",
	} {
		got, ok := PockodeTool(name)
		if got != want || ok != (want != "") {
			t.Errorf("PockodeTool(%q) = %q, %v; want %q", name, got, ok, want)
		}
	}
}
